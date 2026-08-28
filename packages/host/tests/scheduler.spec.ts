import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { capture } from '../src/agents/discover.ts'
import { parseHelp } from '../src/agents/help-parser.ts'
import type { AgentCaps, AgentProvider, RunContext } from '../src/agents/types.ts'
import { Runner } from '../src/runner/index.ts'
import { Scheduler, DEFAULT_SETTINGS } from '../src/scheduler/index.ts'
import { RunBus } from '../src/server/bus.ts'
import { Storage } from '../src/storage/index.ts'
import type { SpawnSpec } from '../src/subprocess/index.ts'

const T0 = 1_700_000_000_000
const PROJECT = asProjectId('b1')

let sandbox: string
let repo: string
let store: Storage
let runner: Runner
let scheduler: Scheduler

/** 一个立刻成功收尾的假 CLI。 */
function provider(id: string, lines: string[] = [JSON.stringify({ kind: 'finished', ok: true })]): AgentProvider {
  const script = `for (const l of ${JSON.stringify(lines)}) console.log(l)`
  return {
    id,
    probe: () => Promise.resolve(null),
    buildStart: (run: RunContext): SpawnSpec => ({
      argv: [process.execPath, '-e', script], cwd: run.worktreePath, stderr: 'pipe',
    }),
    buildResume: () => null,
    parseLine: (line: string) => {
      try { return JSON.parse(line) as never } catch { return { kind: 'raw', line } }
    },
  }
}

const caps = (id: string): AgentCaps => ({
  id, bin: '/fake', version: '1.0.0', streaming: true,
  canPinSessionId: false, canResume: false, permissionTiers: ['standard'], help: parseHelp(''),
})

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), projectId: PROJECT, revision: 1, column: 'ready', position: 1,
    subject: id, description: '', acceptance: ['ok'],
    repoPath: repo, baseBranch: 'main', blockedBy: [],
    createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 等到没有任务停在 running 为止。 */
async function quiet(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!store.listTasks().some((t) => t.column === 'running')) return
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('仍有任务停在 running')
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-sched-'))
  repo = join(sandbox, 'repo')
  await capture(['git', 'init', '-q', '-b', 'main', repo])
  for (const args of [['config', 'user.email', 't@t'], ['config', 'user.name', 'T']]) {
    await capture(['git', '-C', repo, ...args])
  }
  await writeFile(join(repo, 'README.md'), '# x\n', 'utf8')
  await capture(['git', '-C', repo, 'add', '-A'])
  await capture(['git', '-C', repo, 'commit', '-qm', 'init'])

  store = Storage.open(':memory:')
  store.createProject({ id: PROJECT, name: '默认', repoPath: repo, baseBranch: 'main', createdAt: T0 })

  const agents = [{ provider: provider('alpha'), caps: caps('alpha') }]
  runner = new Runner({
    storage: store, bus: new RunBus(), agents,
    artifactsRoot: join(sandbox, 'artifacts'),
    leaseTtlMs: 60_000,
  })
  scheduler = new Scheduler({ storage: store, runner, agents })
})

afterEach(async () => {
  scheduler.stop()
  store.close()
  await rm(sandbox, { recursive: true, force: true })
})

describe('设置', () => {
  it('默认关闭自动认领 —— 让 Agent 无人值守动代码必须由人明确点头', () => {
    expect(scheduler.settings).toEqual(DEFAULT_SETTINGS)
    expect(scheduler.settings.autopilot).toBe(false)
  })

  it('设置写进存储，重启后仍在', () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 5 })
    const revived = new Scheduler({ storage: store, runner, agents: [] })
    expect(revived.settings).toMatchObject({ autopilot: true, maxConcurrent: 5 })
  })

  it('并发上限被夹到至少 1 —— 0 会让调度器静悄悄什么都不做', () => {
    expect(scheduler.updateSettings({ maxConcurrent: 0 }).maxConcurrent).toBe(1)
    expect(scheduler.updateSettings({ maxConcurrent: -3 }).maxConcurrent).toBe(1)
    expect(scheduler.updateSettings({ maxPerRepo: 2.7 }).maxPerRepo).toBe(2)
  })

  it('清除设置后回到默认值', () => {
    scheduler.updateSettings({ autopilot: true })
    // undefined 存成 null，等同清除；不该把 SQLite 打挂。
    expect(() => { store.setSetting('scheduler', undefined) }).not.toThrow()
    expect(scheduler.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('存坏的设置当作没存过，不卡住启动', () => {
    // 模拟被别的版本或人手写坏的值。
    const db = (store as unknown as {
      db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } }
    }).db
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('setting:scheduler', '{broken')
    expect(scheduler.settings).toEqual(DEFAULT_SETTINGS)
  })
})

describe('tick', () => {
  it('自动认领关着时不派活', async () => {
    store.createTask(task({ id: 't1' }))
    const report = await scheduler.tick()
    expect(report.enabled).toBe(false)
    expect(report.dispatched).toEqual([])
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
  })

  it('关着也照样回收 —— 崩溃留下的卡片必须回 Ready，这跟用不用自动驾驶无关', async () => {
    store.createTask(task({
      id: 't1', column: 'running',
      lease: { runId: asRunId('dead'), provider: 'alpha', acquiredAt: T0, expiresAt: T0 + 1 },
    }))
    const report = await scheduler.tick()
    expect(report.enabled).toBe(false)
    expect(report.reclaimed).toContain('t1')
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
  })

  it('开着时把 Ready 里的卡派出去', async () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 3, maxPerRepo: 3 })
    for (const id of ['a', 'b']) store.createTask(task({ id, position: id === 'a' ? 1 : 2 }))

    const report = await scheduler.tick()
    expect(report.dispatched.map((d) => d.taskId)).toEqual(['a', 'b'])
    expect(report.dispatched.every((d) => d.runId !== undefined)).toBe(true)

    await quiet()
    expect(store.listTasks().every((t) => t.column === 'review')).toBe(true)
  })

  it('尊重并发上限，超出的带原因留在 skipped —— 不做静默截断', async () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 1, maxPerRepo: 9 })
    for (const [i, id] of ['a', 'b', 'c'].entries()) store.createTask(task({ id, position: i + 1 }))

    const report = await scheduler.tick()
    expect(report.dispatched).toHaveLength(1)
    expect(report.skipped.map((s) => s.taskId)).toEqual(['b', 'c'])
    expect(report.skipped.every((s) => s.reason === 'global-limit-reached')).toBe(true)
    // 界面要能照着这个原因回答"我的卡为什么不动"。
    expect(report.skipped[0]?.detail).toContain('1')
    await quiet()
  })

  it('依赖未完成的卡带原因跳过', async () => {
    scheduler.updateSettings({ autopilot: true })
    store.createTask(task({ id: 'dep', column: 'backlog' }))
    store.createTask(task({ id: 'a', blockedBy: [asTaskId('dep')] }))

    const report = await scheduler.tick()
    expect(report.dispatched).toEqual([])
    expect(report.skipped[0]).toMatchObject({ taskId: 'a', reason: 'blocked-by-dependency' })
  })

  it('指定了没探测到的 provider 时跳过，而不是偷偷换一个', async () => {
    scheduler.updateSettings({ autopilot: true })
    store.createTask(task({ id: 'a', preferredProvider: '不存在的' }))

    const report = await scheduler.tick()
    expect(report.dispatched).toEqual([])
    expect(report.skipped[0]).toMatchObject({ reason: 'provider-unavailable' })
  })

  it('单个派发失败不影响同一轮的其他卡', async () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 9, maxPerRepo: 9 })
    store.createTask(task({ id: 'a', position: 1 }))
    // 仓库路径不存在 → 建 worktree 必失败。
    store.createTask(task({ id: 'bad', position: 2, repoPath: join(sandbox, 'no-such-repo') }))
    store.createTask(task({ id: 'c', position: 3 }))

    const report = await scheduler.tick()
    expect(report.dispatched).toHaveLength(3)
    expect(report.dispatched.filter((d) => d.error !== undefined).map((d) => d.taskId)).toEqual(['bad'])
    expect(report.dispatched.filter((d) => d.runId !== undefined)).toHaveLength(2)
    await quiet()
  })

  it('重入被挡住：上一轮还没跑完时不会把同一张卡算两次', async () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 9, maxPerRepo: 9 })
    store.createTask(task({ id: 'a' }))

    const [first, second] = await Promise.all([scheduler.tick(), scheduler.tick()])
    const total = first.dispatched.length + second.dispatched.length
    expect(total).toBe(1)
    await quiet()
  })
})

describe('start / stop', () => {
  it('重复 start 不会起多个节拍', () => {
    scheduler.start()
    scheduler.start()
    expect(() => { scheduler.stop() }).not.toThrow()
  })

  it('节拍会自动把 Ready 里的卡跑完', async () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 2, maxPerRepo: 2 })
    for (const [i, id] of ['a', 'b'].entries()) store.createTask(task({ id, position: i + 1 }))

    scheduler = new Scheduler({ storage: store, runner, agents: [{ provider: provider('alpha'), caps: caps('alpha') }], tickMs: 50 })
    scheduler.start()

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (store.listTasks().every((t) => t.column === 'review')) break
      await new Promise((r) => setTimeout(r, 40))
    }
    expect(store.listTasks().map((t) => t.column)).toEqual(['review', 'review'])
  })
})

describe('轮次串行（回归）', () => {
  it('tick 排在进行中的轮次之后，拿到的是自己这次的结果而非上一轮的陈旧报告', async () => {
    scheduler.updateSettings({ autopilot: true, maxConcurrent: 9, maxPerRepo: 9 })
    store.createTask(task({ id: 'a' }))

    const first = scheduler.tick()
    // 第一轮还在派发时改设置并再跑一轮 —— 这正是 PATCH /api/scheduler 的路径。
    scheduler.updateSettings({ autopilot: false })
    const second = await scheduler.tick()

    await first
    // 第二轮必须反映**新设置**，而不是复用第一轮的报告。
    expect(second.enabled).toBe(false)
    await quiet()
  })

  it('节拍忙时跳过而不是排队 —— 排队会在慢轮结束后连着放炮', async () => {
    scheduler.updateSettings({ autopilot: true })
    store.createTask(task({ id: 'a' }))

    const running = scheduler.tick()
    expect(await scheduler.tickIfIdle()).toBeNull()
    await running
    await quiet()
  })
})
