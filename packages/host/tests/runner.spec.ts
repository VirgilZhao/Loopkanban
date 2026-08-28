import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asProjectId, asRunId, asTaskId, moveTask, type Task } from '@loopkanban/core'
import { AgentPool } from '../src/agents/index.ts'
import { listStaged } from '../src/attachments/index.ts'
import { capture } from '../src/agents/discover.ts'
import { parseHelp } from '../src/agents/help-parser.ts'
import type { AgentCaps, AgentProvider, RunContext } from '../src/agents/types.ts'
import { RunBus } from '../src/server/bus.ts'
import { Storage } from '../src/storage/index.ts'
import { isClean, worktreeDir } from '../src/worktree/index.ts'
import type { SpawnSpec } from '../src/subprocess/index.ts'
import { Runner, renderPrompt, renderTaskSpec } from '../src/runner/index.ts'

const T0 = 1_700_000_000_000
const PROJECT = asProjectId('b1')

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
    command: 'scripted',
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
        return [event] as never
      } catch {
        return [{ kind: 'raw', line }]
      }
    },
  }
}

const caps = (): AgentCaps => ({
  id: 'scripted', bin: '/fake', version: '9.9.9',
  streaming: true, canPinSessionId: true, canResume: false, canPickModel: true, models: [],
  permissionTiers: ['standard'], help: parseHelp(''),
})

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), projectId: PROJECT, revision: 1, column: 'ready', position: 1,
    description: '加个 greet 函数\n\n要有测试',
    acceptance: ['greet.js 存在', '有单测'],
    repoPath: repo, baseBranch: 'main',
    blockedBy: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

function runner(provider: AgentProvider, patch: Partial<ConstructorParameters<typeof Runner>[0]> = {}): Runner {
  return new Runner({
    storage: store, bus,
    agents: AgentPool.of([{ provider, caps: caps() }]),
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
  store.createProject({ id: PROJECT, name: '默认', repoPath: repo, baseBranch: 'main', createdAt: T0 })
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
    const spec = renderTaskSpec(task({ id: 't1' }))
    expect(spec).toContain('- [ ] greet.js 存在')
    expect(spec).toContain('不要提交或推送')
  })

  it('prompt 指向 TASK.md 而不是把长文堆进命令行', () => {
    expect(renderPrompt(task({ id: 't1' }))).toContain('TASK.md')
  })
})

describe('附件', () => {
  /** 造一个真的附件文件，并把记录挂到卡上。 */
  async function attach(taskId: string, filename: string, body: string): Promise<void> {
    const path = join(sandbox, `blob-${filename}`)
    await writeFile(path, body, 'utf8')
    store.addAttachment({
      id: `a-${filename}`,
      taskId: asTaskId(taskId),
      filename,
      mime: 'text/plain',
      size: body.length,
      path,
      at: T0,
    })
  }

  it('派活时拷进 worktree，并在 TASK.md 与 prompt 里点名', async () => {
    store.createTask(task({ id: 't1' }))
    await attach('t1', '需求.txt', '照着这个做')

    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await settle(started.run.id)

    const wt = worktreeDir(repo, 't1')
    expect(await readFile(join(wt, '.loopkanban/attachments/需求.txt'), 'utf8')).toBe('照着这个做')

    const spec = await readFile(join(wt, 'TASK.md'), 'utf8')
    expect(spec).toContain('## 附件')
    expect(spec).toContain('.loopkanban/attachments/需求.txt')
  })

  it('附件不进 diff —— 它是输入不是产出', async () => {
    store.createTask(task({ id: 't1' }))
    await attach('t1', '需求.txt', '照着这个做')

    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) return
    await settle(started.run.id)

    // 附件躺在 .loopkanban/ 下，而那条排除规则让 git 根本看不见它 ——
    // 否则每次验收都会把一堆二进制材料提交进仓库。
    expect(await isClean(worktreeDir(repo, 't1'))).toBe(false) // TASK.md 本来就在
    const { stdout } = await capture(['git', '-C', worktreeDir(repo, 't1'), 'status', '--porcelain'])
    expect(stdout).not.toContain('.loopkanban')
  })

  it('撤回的附件下一轮不会还留在工作区里', async () => {
    store.createTask(task({ id: 't1' }))
    await attach('t1', '旧的.txt', 'x')

    const provider = scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })])
    const first = await runner(provider).start(asTaskId('t1'))
    if (!first.ok) return
    await settle(first.run.id)
    expect(await listStaged(worktreeDir(repo, 't1'))).toEqual(['旧的.txt'])

    store.deleteAttachment('a-旧的.txt')
    // 卡跑完停在 review，先放回队列才能再派一次。
    const reviewed = store.getTask(asTaskId('t1'))
    if (reviewed === null) throw new Error('setup')
    const back = moveTask(reviewed, { expectedRevision: reviewed.revision, to: 'ready', now: T0 })
    if (!back.ok) throw new Error('setup')
    store.commitTask(back.value)

    const second = await runner(provider).start(asTaskId('t1'))
    if (!second.ok) return
    await settle(second.run.id)
    expect(await listStaged(worktreeDir(repo, 't1'))).toEqual([])
  })

  it('没有附件时 TASK.md 里不摆一个空的「附件」节', () => {
    expect(renderTaskSpec(task({ id: 't1' }))).not.toContain('## 附件')
    expect(renderPrompt(task({ id: 't1' }))).not.toContain('附件')
  })

  it('清单带上相对路径、类型与大小，Agent 才知道该怎么读它', () => {
    const spec = renderTaskSpec(task({ id: 't1' }), [], [{
      filename: '合同.pdf', mime: 'application/pdf', size: 2048,
      relPath: '.loopkanban/attachments/合同.pdf',
    }])
    expect(spec).toContain('`.loopkanban/attachments/合同.pdf`')
    expect(spec).toContain('application/pdf')
    expect(spec).toContain('2.0 KB')
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

describe('一行多事件', () => {
  it('一行拆出的每个事件都要落库 —— 用量不该被同一行里的 finished 挤掉', async () => {
    store.createTask(task({ id: 't1' }))
    // 真实形状：claude 的 result 行、codex 的 turn.completed 都是"结束 + 用量"。
    const provider = scriptedProvider([JSON.stringify({ 结束带用量: true })])
    const twoInOne: AgentProvider = {
      ...provider,
      parseLine: (line) => line.includes('结束带用量')
        ? [
            { kind: 'usage', inputTokens: 11, outputTokens: 22, costUsd: 0.25 },
            { kind: 'finished', ok: true, summary: '干完了' },
          ]
        : [{ kind: 'raw', line }],
    }

    const started = await runner(twoInOne).start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getRun(started.run.id)?.status).toBe('completed')
    // 成本此前一路走到这儿就没了：一行只翻译得出一个事件，用量在 finished 手里输掉。
    expect(store.stats()).toMatchObject({ costUsd: 0.25, inputTokens: 11, outputTokens: 22 })
  })
})

describe('完成判定', () => {
  it('CLI 说成功但进程非零退出 —— 退出码一票否决，不记成 completed', async () => {
    store.createTask(task({ id: 't1' }))
    // 真实形状：codex 报完 turn.completed 之后 `-o` 落盘失败、收尾时崩掉。
    const started = await runner(scriptedProvider(
      [JSON.stringify({ kind: 'finished', ok: true, summary: '干完了' })], 1,
    )).start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const run = store.getRun(started.run.id)
    expect(run?.status).toBe('failed')
    // 光一个 exit=1 会让人对着"finished ok=true"的事件流发懵，要说清楚。
    expect(run?.diagnostic).toContain('非零码退出')
  })

  it('被信号杀掉不算它自己报的错 —— 说过成功的那一轮就是干完了', async () => {
    store.createTask(task({ id: 't1' }))
    // tail 里自杀：exitCode 为 null、signal 非空，正是取消与超时那条路。
    const r = runner(scriptedProvider(
      [JSON.stringify({ kind: 'finished', ok: true, summary: '干完了' })],
      0, 'process.kill(process.pid, "SIGKILL")',
    ))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getRun(started.run.id)).toMatchObject({ status: 'completed', exitCode: undefined })
  })
})

describe('刷新探测结果', () => {
  it('刷新后装上的 CLI 立刻能派活 —— 池子是活视图，不是开机时的快照', async () => {
    store.createTask(task({ id: 't1', preferredProvider: 'codex' }))
    const codex = { ...scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]), id: 'codex' }

    // 开机时本机只有 alpha，卡上却点名要 codex。
    let found = [{ provider: scriptedProvider([]), caps: caps() }]
    const pool = new AgentPool(() => Promise.resolve(found), found)
    const r = new Runner({
      storage: store, bus, agents: pool,
      artifactsRoot: join(sandbox, 'artifacts'), leaseTtlMs: 60_000, timeoutMs: 20_000,
    })

    const before = await r.start(asTaskId('t1'))
    expect(before).toMatchObject({ ok: false, reason: 'provider-unavailable' })

    // 用户装上了 codex，在界面上点了刷新。
    found = [...found, { provider: codex, caps: { ...caps(), id: 'codex' } }]
    await pool.refresh()

    const after = await r.start(asTaskId('t1'))
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.run.provider).toBe('codex')
    await settle(after.run.id)
  })
})

describe('worktree 隔离', () => {
  it('Agent 在独立分支的 worktree 里干活，主工作区不受影响', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)

    // worktree 长在项目自己的目录里：项目目录/.loopkanban/worktrees/<taskId>
    expect(started.run.worktreePath).toBe(worktreeDir(repo, 't1'))
    expect(started.run.branch).toContain('task/t1')
    // TASK.md 写在 worktree 里，不在主仓库。
    await expect(readFile(join(started.run.worktreePath, 'TASK.md'), 'utf8')).resolves.toContain('验收标准')
    await expect(readFile(join(repo, 'TASK.md'), 'utf8')).rejects.toThrow()
    // 而主工作区依然干净 —— worktree 目录已被写进本地排除表。
    expect(await isClean(repo)).toBe(true)

    await settle(started.run.id)
  })

  it('换个 Agent 接着干，还是同一个 worktree —— 它属于任务，不属于谁在跑', async () => {
    store.createTask(task({ id: 't1' }))
    const first = await runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
      .start(asTaskId('t1'))
    if (!first.ok) throw new Error(first.detail)
    await settle(first.run.id)
    await writeFile(join(first.run.worktreePath, 'half.txt'), '上一轮干了一半\n', 'utf8')

    // 打回重来：卡回到 ready，换一个 provider 接手。
    const after = store.getTask(asTaskId('t1'))
    if (after === null) throw new Error('卡没了')
    store.commitTask({ ...after, column: 'ready', lease: undefined, revision: after.revision + 1 })
    const other = scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })])
    const second = await new Runner({
      storage: store, bus,
      agents: AgentPool.of([{ provider: { ...other, id: 'codex' }, caps: caps() }]),
      artifactsRoot: join(sandbox, 'artifacts'),
      leaseTtlMs: 60_000, timeoutMs: 20_000,
    }).start(asTaskId('t1'))
    if (!second.ok) throw new Error(second.detail)

    expect(second.run.worktreePath).toBe(first.run.worktreePath)
    // 上一轮的半成品还在，Agent 不是在空目录里对着评审意见发懵。
    await expect(readFile(join(second.run.worktreePath, 'half.txt'), 'utf8')).resolves.toContain('干了一半')
    await settle(second.run.id)
  })
})

describe('讨论的生命周期', () => {
  /** 给这张卡留一条人类留言。 */
  const say = (body: string, at = T0) => {
    store.addComment({ id: `c-${String(at)}`, taskId: asTaskId('t1'), author: 'human', body, at })
  }

  it('Agent 这一轮的回复进讨论 —— 它就是人接下来要回应的东西', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'finished', ok: true, summary: '改完了：slugify 现在保留中文' }),
    ]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const comments = store.listComments(asTaskId('t1'))
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ author: 'agent', body: '改完了：slugify 现在保留中文' })
    expect(comments[0]?.runId).toBe(started.run.id)
  })

  it('失败的那一轮也记 —— 它卡在哪儿正是最该被讨论的', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'finished', ok: false, summary: '依赖装不上，npm 报 403' }),
    ], 1))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.listComments(asTaskId('t1'))[0]).toMatchObject({
      author: 'agent', body: '依赖装不上，npm 报 403',
    })
  })

  it('讨论不消费：跑完之后先前的留言还在，下一轮连着一起带走', async () => {
    store.createTask(task({ id: 't1' }))
    say('连字符后面的字母也要大写')
    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true, summary: '好了' })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const comments = store.listComments(asTaskId('t1'))
    expect(comments.map((c) => c.author)).toEqual(['human', 'agent'])
    expect(comments[0]?.body).toBe('连字符后面的字母也要大写')
  })

  it('整条讨论写进 TASK.md —— 只给最后一句会让 Agent 推翻已确认的结论', async () => {
    store.createTask(task({ id: 't1' }))
    say('先只改 slugify，别动别的', T0)
    store.addComment({ id: 'c-a', taskId: asTaskId('t1'), author: 'agent', body: '已改，只动了一个文件', at: T0 + 1 })
    say('再补个中文的测试', T0 + 2)

    const r = runner(scriptedProvider([JSON.stringify({ kind: 'finished', ok: true })]))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)

    const spec = await readFile(join(started.run.worktreePath, 'TASK.md'), 'utf8')
    expect(spec).toContain('## 讨论')
    expect(spec).toContain('先只改 slugify')
    expect(spec).toContain('已改，只动了一个文件')
    expect(spec).toContain('再补个中文的测试')
    await settle(started.run.id)
  })

  it('最新一条留言出现在事件流里，人能看到这一轮是带着什么要求跑的', async () => {
    store.createTask(task({ id: 't1' }))
    say('要保留 Unicode')
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

describe('一起步就死的执行', () => {
  it('一句话一个工具都没有就失败：诊断里给一条能照做的线索', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'finished', ok: false, diagnostic: 'UnknownError: 服务端错误' }),
    ], 1))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    const diagnostic = store.getRun(started.run.id)?.diagnostic ?? ''
    // 原始诊断照留，线索只是附在后面 —— 不替 CLI 下结论。
    expect(diagnostic).toContain('UnknownError: 服务端错误')
    expect(diagnostic).toContain('明确指定一个模型')
  })

  it('干过活的那种失败不给这条线索 —— 它的失败另有原因', async () => {
    store.createTask(task({ id: 't1' }))
    const r = runner(scriptedProvider([
      JSON.stringify({ kind: 'text', text: '我看了一圈代码' }),
      JSON.stringify({ kind: 'finished', ok: false, diagnostic: '测试没过' }),
    ], 1))
    const started = await r.start(asTaskId('t1'))
    if (!started.ok) throw new Error(started.detail)
    await settle(started.run.id)

    expect(store.getRun(started.run.id)?.diagnostic).toBe('测试没过')
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
