import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asBoardId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { capture } from '../src/agents/discover.ts'
import { parseHelp } from '../src/agents/help-parser.ts'
import type { AgentCaps, AgentProvider, RunContext } from '../src/agents/types.ts'
import { RunBus } from '../src/server/bus.ts'
import { Storage } from '../src/storage/index.ts'
import type { SpawnSpec } from '../src/subprocess/index.ts'
import { Runner, renderPrompt, renderTaskSpec } from '../src/runner/index.ts'

const T0 = 1_700_000_000_000
const BOARD = asBoardId('b1')

let sandbox: string
let repo: string
let store: Storage
let bus: RunBus

/**
 * 假 provider：用一个真的 node 子进程按行吐出预置的 JSONL。
 *
 * 刻意不 mock 掉子进程 —— 这样测到的是完整链路（进程组、逐行读取、
 * 解析、落库、广播、退出码），而不只是一个内存里的假对象。
 */
function scriptedProvider(lines: string[], exitCode = 0, tail = ''): AgentProvider {
  const script = `
    const lines = ${JSON.stringify(lines)}
    for (const line of lines) console.log(line)
    ${tail || `process.exit(${String(exitCode)})`}
  `
  return {
    id: 'scripted',
    probe: () => Promise.resolve(null),
    buildStart: (run: RunContext): SpawnSpec => ({
      argv: [process.execPath, '-e', script],
      cwd: run.worktreePath,
      stderr: 'pipe',
    }),
    buildResume: () => null,
    parseLine: (line: string) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        return event as never
      } catch {
        return { kind: 'raw', line }
      }
    },
  }
}

const caps = (): AgentCaps => ({
  id: 'scripted', bin: '/fake', version: '9.9.9',
  streaming: true, canPinSessionId: true, canResume: false,
  permissionTiers: ['standard'], help: parseHelp(''),
})

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), boardId: BOARD, revision: 1, column: 'ready', position: 1,
    subject: '加个 greet 函数', description: '要有测试',
    acceptance: ['greet.js 存在', '有单测'],
    repoPath: repo, baseBranch: 'main',
    blockedBy: [], writeScopes: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

function runner(provider: AgentProvider, patch: Partial<ConstructorParameters<typeof Runner>[0]> = {}): Runner {
  return new Runner({
    storage: store, bus,
    agents: [{ provider, caps: caps() }],
    worktreeRoot: join(sandbox, 'worktrees'),
    artifactsRoot: join(sandbox, 'artifacts'),
    leaseTtlMs: 60_000,
    timeoutMs: 20_000,
    ...patch,
  })
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-runner-'))
  repo = join(sandbox, 'repo')
  await capture(['git', 'init', '-q', '-b', 'main', repo])
  for (const args of [['config', 'user.email', 't@t'], ['config', 'user.name', 'T']]) {
    await capture(['git', '-C', repo, ...args])
  }
  await writeFile(join(repo, 'README.md'), '# scratch\n', 'utf8')
  await capture(['git', '-C', repo, 'add', '-A'])
  await capture(['git', '-C', repo, 'commit', '-qm', 'init'])

  store = Storage.open(':memory:')
  store.createBoard({ id: BOARD, name: '默认', repoPath: repo, baseBranch: 'main', createdAt: T0 })
  bus = new RunBus()
})

afterEach(async () => { store.close(); await rm(sandbox, { recursive: true, force: true }) })

/** 等某个 Run 走到终态。 */
async function settle(runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (store.getRun(asRunId(runId))?.status !== 'running') return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('Run 未在超时内收尾')
}

describe('renderTaskSpec / renderPrompt', () => {
  it('把验收标准写成 checklist，并声明约束', () => {
    const spec = renderTaskSpec(task({ id: 't1', writeScopes: ['src/auth/'] }))
    expect(spec).toContain('- [ ] greet.js 存在')
    expect(spec).toContain('src/auth/')
    expect(spec).toContain('不要提交或推送')
  })

  it('prompt 指向 TASK.md 而不是把长文堆进命令行', () => {
    expect(renderPrompt(task({ id: 't1' }))).toContain('TASK.md')
  })
})

describe('start — 认领与副作用顺序', () => {
  it('成功执行后卡片进 Review，Run 记为 completed', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'session', sessionId: 'sess-1' }),
      JSON.stringify({ kind: 'text', text: '干完了' }),
      JSON.stringify({ kind: 'finished', ok: true, summary: '创建了 greet.js' }),
    ]))

    const started = await r.start(asTaskId('t1'))
    expect(started.ok).toBe(true)
    if (!started.ok) return

    // 起进程之后卡片必须已经在 running 且持有租约。
    expect(store.getTask(asTaskId('t1'))).toMatchObject({ column: 'running' })
    expect(store.getTask(asTaskId('t1'))?.lease?.runId).toBe(started.run.id)

    await settle(started.run.id)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    expect(store.getTask(asTaskId('t1'))?.lease).toBeUndefined()
    expect(store.getRun(started.run.id)).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it('同一个会话 id 反复上报只广播一次 —— opencode 每条事件都带 sessionID', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'session', sessionId: 'ses_a' }),
      JSON.stringify({ kind: 'text', text: '第一步' }),
      JSON.stringify({ kind: 'session', sessionId: 'ses_a' }),
      JSON.stringify({ kind: 'session', sessionId: 'ses_a' }),
      JSON.stringify({ kind: 'text', text: '第二步' }),
    ]))

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const sessions = store.readEvents(started.run.id).filter((e) => e.kind === 'session')
    expect(sessions).toHaveLength(1)
    // 去重不能把会话 id 本身弄丢，续跑还要靠它。
    expect(store.getRun(started.run.id)?.agentSessionId).toBe('ses_a')
    // 其它事件一条都不能被顺手吞掉。
    expect(store.readEvents(started.run.id).filter((e) => e.kind === 'text')).toHaveLength(2)
  })

  it('带上新字段的 session 事件不算重复 —— claude 的 apiKeySource 不能被吞掉', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'session', sessionId: 'sess-1' }),
      JSON.stringify({ kind: 'session', sessionId: 'sess-1', apiKeySource: 'none' }),
    ]))

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const sessions = store.readEvents(started.run.id).filter((e) => e.kind === 'session')
    expect(sessions).toHaveLength(2)
    expect(sessions.at(-1)?.payload).toMatchObject({ apiKeySource: 'none' })
  })

  it('CLI 报告失败时卡片也进 Review，并带上结构化诊断', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'finished', ok: false, diagnostic: 'terminal=api_error api_status=401' }),
    ], 1))

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    expect(store.getRun(started.run.id)?.diagnostic).toContain('api_status=401')
  })

  it('没有 finished 事件时退回退出码判定', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'text', text: '啥也没说就退了' })], 3))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getRun(started.run.id)).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })

  it('不在 ready 列的卡片认领失败，且不产生任何副作用', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const result = await runner(scriptedProvider([])).start(asTaskId('t1'))

    expect(result).toMatchObject({ ok: false, reason: 'illegal-transition' })
    expect(store.listRuns(asTaskId('t1'))).toEqual([])
    expect(store.getTask(asTaskId('t1'))?.revision).toBe(1)
  })

  it('指定的 provider 没探测到时直接拒绝，不偷偷换一个', async () => {
    store.createTask(task({ id: 't1' }))
    const result = await runner(scriptedProvider([])).start(asTaskId('t1'), 'claude')
    expect(result).toMatchObject({ ok: false, reason: 'provider-unavailable' })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
  })

  it('同一张卡不能被认领两次', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const first = await r.start(asTaskId('t1'))
    expect(first.ok).toBe(true)
    expect(await r.start(asTaskId('t1'))).toMatchObject({ ok: false })
    if (first.ok) await settle(first.run.id)
  })
})

describe('事件日志与广播', () => {
  it('事件先落库再广播，两边的 seq 对得上', async () => {
    store.createTask(task({ id: 't1' }))
    const received: number[] = []
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'text', text: 'a' }),
      JSON.stringify({ kind: 'text', text: 'b' }),
      JSON.stringify({ kind: 'finished', ok: true }),
    ]))

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    bus.subscribe(started.run.id, (event) => {
      // 广播到达时该 seq 必须已经能从存储里读到。
      const stored = store.readEvents(started.run.id, event.seq - 1)[0]
      expect(stored?.seq).toBe(event.seq)
      received.push(event.seq)
    })

    await settle(started.run.id)
    const persisted = store.readEvents(started.run.id)
    expect(persisted.length).toBeGreaterThanOrEqual(4)
    expect(persisted.map((e) => e.seq)).toEqual([...persisted.keys()].map((i) => i + 1))
    expect(received.length).toBeGreaterThan(0)
  })

  it('原始输出与退出信息落盘，供事后追查', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const raw = await readFile(join(sandbox, 'artifacts', started.run.id, 'raw.log'), 'utf8')
    expect(raw).toContain('finished')
  })
})

describe('worktree 隔离', () => {
  it('Agent 在独立分支的 worktree 里干活，主工作区不受影响', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)

    expect(started.run.worktreePath).toContain('worktrees')
    expect(started.run.branch).toContain('task/t1')
    // TASK.md 写在 worktree 里，不在主仓库。
    await expect(readFile(join(started.run.worktreePath, 'TASK.md'), 'utf8')).resolves.toContain('验收标准')
    await expect(readFile(join(repo, 'TASK.md'), 'utf8')).rejects.toThrow()

    await settle(started.run.id)
  })
})

describe('评审意见的生命周期', () => {
  it('执行失败时意见留着 —— 否则人写的评审凭空丢了，重派又从头做一遍', async () => {
    store.createTask(task({ id: 't1', feedback: '连字符后面的字母也要大写' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: false })], 1))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    expect(store.getTask(asTaskId('t1'))?.feedback).toBe('连字符后面的字母也要大写')
  })

  it('跑出可验收结果之后才清掉意见，避免下一轮重复投喂', async () => {
    store.createTask(task({ id: 't1', feedback: '改一下' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    expect(store.getTask(asTaskId('t1'))?.feedback).toBeUndefined()
  })

  it('意见会出现在事件流里，人能看到这一轮是带着什么要求跑的', async () => {
    store.createTask(task({ id: 't1', feedback: '要保留 Unicode' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const notices = store.readEvents(started.run.id)
      .filter((e) => e.kind === 'notice')
      .map((e) => JSON.stringify(e.payload))
    expect(notices.join(' ')).toContain('要保留 Unicode')
  })
})

describe('崩溃恢复', () => {
  it('reconcile 把上次留下的 running Run 标记为 aborted', () => {
    store.createTask(task({ id: 't1' }))
    store.createRun({
      id: asRunId('ghost'), taskId: asTaskId('t1'), provider: 'scripted', cliVersion: '9',
      worktreePath: '/gone', branch: 'task/t1', status: 'running', startedAt: T0,
    })
    expect(runner(scriptedProvider([])).reconcile()).toBe(1)
    expect(store.getRun(asRunId('ghost'))).toMatchObject({ status: 'aborted' })
  })

  it('reclaimExpired 把租约过期的卡片放回 ready —— 崩溃后任务不会永远消失', () => {
    store.createTask(task({
      id: 't1', column: 'running',
      lease: { runId: asRunId('dead'), provider: 'scripted', acquiredAt: T0 - 1e6, expiresAt: T0 - 1 },
    }))
    const r = runner(scriptedProvider([]), { now: () => T0 })
    expect(r.reclaimExpired()).toEqual(['t1'])
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
  })

  it('本进程正在跑的 Run 不会被误当成过期回收', async () => {
    store.createTask(task({ id: 't1' }))
    // 租期极短，但只要 Run 还在 active 里就不该被收走。
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'text', text: 'slow' }),
      JSON.stringify({ kind: 'finished', ok: true }),
    ]), { leaseTtlMs: 1 })
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)

    expect(r.reclaimExpired()).toEqual([])
    await settle(started.run.id)
  })
})

describe('异常路径的收尾（回归）', () => {
  it('解析器中途抛异常时，卡片不会永远卡在 Running', async () => {
    store.createTask(task({ id: 't1' }))
    const provider = scriptedProvider([
      JSON.stringify({ kind: 'text', text: 'a' }),
      JSON.stringify({ kind: 'text', text: '炸' }),
      JSON.stringify({ kind: 'finished', ok: true }),
    ])
    // 模拟 provider 自己出 bug（或 stdout 中途出错）导致事件流中断。
    const broken: AgentProvider = {
      ...provider,
      parseLine: (line, caps) => {
        if (line.includes('炸')) throw new Error('parser blew up')
        return provider.parseLine(line, caps)
      },
    }
    const r = runner(broken, { leaseTtlMs: 500 })

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && store.getTask(asTaskId('t1'))?.column === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
    expect(store.getRun(started.run.id)?.status).toBe('failed')
    expect(store.getRun(started.run.id)?.diagnostic).toContain('事件流中断')

    // 关键：条目已从 active 移除，定时器也停了 —— 否则回收器会永远跳过它。
    expect(r.activeRunIds()).toEqual([])
  })

  it('事件落库失败不该杀掉执行 —— 一行日志没有 Agent 干的活值钱', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'text', text: 'a' }),
      JSON.stringify({ kind: 'finished', ok: true }),
    ]))

    const real = store.appendEvent.bind(store)
    let calls = 0
    store.appendEvent = ((...args: Parameters<Storage['appendEvent']>) => {
      calls += 1
      if (calls === 2) throw new Error('disk full')
      return real(...args)
    }) as Storage['appendEvent']

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)
    store.appendEvent = real

    // 丢了一条事件，但这一轮照常跑完并进了 Review。
    expect(store.getRun(started.run.id)?.status).toBe('completed')
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })

  it('起进程失败时不会留下一条永远 running 的 Run 记录', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([]), {
      spawn: () => Promise.reject(new Error('spawn ENOENT: CLI 刚被替换')),
    })

    const result = await r.start(asTaskId('t1'))
    expect(result).toMatchObject({ ok: false, reason: 'launch-failed' })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')

    const runs = store.listRuns(asTaskId('t1'))
    // 记录可以存在，但绝不能停在 running —— 否则统计与孤儿对账都被带偏。
    expect(runs.every((run) => run.status !== 'running')).toBe(true)
    expect(store.listOrphanRuns()).toEqual([])
  })

  it('主动取消记为 aborted，不混进失败率', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'text', text: 'ready' }),
      // 之后长时间不退出，给取消留出窗口。
    ], 0, 'setInterval(() => {}, 1000)'), { leaseTtlMs: 60_000 })

    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(await r.cancel(started.run.id)).toBe(true)
    await settle(started.run.id)

    const run = store.getRun(started.run.id)
    expect(run?.status).toBe('aborted')
    expect(run?.diagnostic).toContain('取消')
    // 成功率只看 completed / failed，aborted 不参与。
    expect(store.stats().failed).toBe(0)
  })
})
