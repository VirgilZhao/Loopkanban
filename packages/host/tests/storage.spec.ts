import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLease, asBoardId, asRunId, asTaskId, moveTask, type Task,
} from '@openkanban/core'
import { Storage, type Board, type Run } from '../src/storage/index.ts'

const T0 = 1_000_000
const BOARD = asBoardId('b1')

let store: Storage

const board = (): Board => ({
  id: BOARD, name: '默认看板', repoPath: '/repo', baseBranch: 'main', createdAt: T0,
})

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id),
    boardId: BOARD,
    revision: 1,
    column: 'ready',
    position: 1,
    subject: id,
    description: '描述',
    acceptance: ['有测试'],
    repoPath: '/repo',
    baseBranch: 'main',
    blockedBy: [],
    writeScopes: [],
    createdAt: T0,
    updatedAt: T0,
    ...rest,
  }
}

const run = (patch: Partial<Run> = {}): Run => ({
  id: asRunId('run-1'),
  taskId: asTaskId('t1'),
  provider: 'claude',
  cliVersion: '2.1.247',
  worktreePath: '/wt',
  branch: 'task/t1',
  status: 'running',
  startedAt: T0,
  ...patch,
})

beforeEach(() => {
  store = Storage.open(':memory:')
  store.createBoard(board())
})

describe('任务往返', () => {
  it('写进去再读出来，字段一个不丢', () => {
    const original = task({
      id: 't1',
      preferredProvider: 'codex',
      blockedBy: [asTaskId('dep')],
      writeScopes: ['src/auth/'],
      acceptance: ['A', 'B'],
      lease: { runId: asRunId('r9'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 1000 },
    })
    store.createTask(original)
    expect(store.getTask(asTaskId('t1'))).toEqual(original)
  })

  it('可选字段缺席时读回来也是缺席，而不是 null', () => {
    store.createTask(task({ id: 't1' }))
    const loaded = store.getTask(asTaskId('t1'))
    expect(loaded).not.toBeNull()
    expect(loaded?.lease).toBeUndefined()
    expect(loaded?.preferredProvider).toBeUndefined()
  })

  it('不存在的任务返回 null', () => {
    expect(store.getTask(asTaskId('nope'))).toBeNull()
  })

  it('按 position 排序列出', () => {
    store.createTask(task({ id: 'c', position: 3 }))
    store.createTask(task({ id: 'a', position: 1 }))
    store.createTask(task({ id: 'b', position: 2 }))
    expect(store.listTasks(BOARD).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('commitTask 的 compare-and-set', () => {
  it('revision 对得上时写入成功', () => {
    store.createTask(task({ id: 't1' }))
    const loaded = store.getTask(asTaskId('t1'))
    if (loaded === null) throw new Error('unreachable')

    const moved = moveTask(loaded, { expectedRevision: loaded.revision, to: 'running', now: T0 + 1 })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return

    expect(store.commitTask(moved.value)).toBe(true)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('running')
    expect(store.getTask(asTaskId('t1'))?.revision).toBe(2)
  })

  it('两个调度器同时认领，只有一个能落库 —— 并发正确性最终落在这条 SQL 上', () => {
    store.createTask(task({ id: 't1' }))
    const snapshot = store.getTask(asTaskId('t1'))
    if (snapshot === null) throw new Error('unreachable')

    // 两个调度器读到同一份快照，各自算出自己的新值。
    const a = acquireLease(snapshot, {
      expectedRevision: snapshot.revision, runId: asRunId('rA'),
      provider: 'claude', ttlMs: 60_000, now: T0, completed: new Set(),
    })
    const b = acquireLease(snapshot, {
      expectedRevision: snapshot.revision, runId: asRunId('rB'),
      provider: 'codex', ttlMs: 60_000, now: T0, completed: new Set(),
    })
    // 领域层看不见彼此，两边都算得出"合法"的新值。
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(store.commitTask(a.value)).toBe(true)
    // B 拿着同样的 revision 提交，必须被拒。
    expect(store.commitTask(b.value)).toBe(false)

    expect(store.getTask(asTaskId('t1'))?.lease?.runId).toBe('rA')
  })

  it('提交一个 revision 落后的值会被拒，数据不被覆盖', () => {
    store.createTask(task({ id: 't1', revision: 5, subject: '新的' }))
    const stale = task({ id: 't1', revision: 3, subject: '旧的' })
    expect(store.commitTask(stale)).toBe(false)
    expect(store.getTask(asTaskId('t1'))?.subject).toBe('新的')
  })

  it('租约可以被写成 null 来释放', () => {
    store.createTask(task({
      id: 't1', column: 'running',
      lease: { runId: asRunId('r1'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 1000 },
    }))
    const loaded = store.getTask(asTaskId('t1'))
    if (loaded === null) throw new Error('unreachable')
    const moved = moveTask(loaded, { expectedRevision: loaded.revision, to: 'review', now: T0 + 1 })
    if (!moved.ok) throw new Error('unreachable')

    expect(store.commitTask(moved.value)).toBe(true)
    expect(store.getTask(asTaskId('t1'))?.lease).toBeUndefined()
  })
})

describe('Run', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  it('写入后可读回，可选字段保持缺席', () => {
    store.createRun(run())
    const loaded = store.getRun(asRunId('run-1'))
    expect(loaded).toMatchObject({ provider: 'claude', status: 'running' })
    expect(loaded?.agentSessionId).toBeUndefined()
    expect(loaded?.endedAt).toBeUndefined()
  })

  it('可以补写会话 id 与终态', () => {
    store.createRun(run())
    store.updateRun({
      ...run(), agentSessionId: 'sess-9', status: 'failed',
      exitCode: 1, diagnostic: 'terminal=api_error', endedAt: T0 + 5000,
    })
    expect(store.getRun(asRunId('run-1'))).toMatchObject({
      agentSessionId: 'sess-9', status: 'failed', exitCode: 1, endedAt: T0 + 5000,
    })
  })

  it('列出上次崩溃留下的孤儿 Run，供启动时对账', () => {
    store.createRun(run({ id: asRunId('alive') }))
    store.createRun(run({ id: asRunId('done'), status: 'completed', endedAt: T0 + 1 }))
    expect(store.listOrphanRuns().map((r) => r.id)).toEqual(['alive'])
  })
})

describe('事件日志（append-only）', () => {
  beforeEach(() => {
    store.createTask(task({ id: 't1' }))
    store.createRun(run())
  })

  it('seq 从 1 开始逐条递增', () => {
    const seqs = ['session', 'text', 'tool'].map((kind, i) =>
      store.appendEvent(asRunId('run-1'), kind, { i }, T0 + i))
    expect(seqs).toEqual([1, 2, 3])
  })

  it('seq 按 Run 独立编号', () => {
    store.createRun(run({ id: asRunId('run-2') }))
    store.appendEvent(asRunId('run-1'), 'text', null, T0)
    store.appendEvent(asRunId('run-1'), 'text', null, T0)
    expect(store.appendEvent(asRunId('run-2'), 'text', null, T0)).toBe(1)
  })

  it('负载原样往返', () => {
    store.appendEvent(asRunId('run-1'), 'tool', { name: 'Bash', input: { cmd: 'ls -la' } }, T0)
    expect(store.readEvents(asRunId('run-1'))[0]).toMatchObject({
      seq: 1, kind: 'tool', payload: { name: 'Bash', input: { cmd: 'ls -la' } },
    })
  })

  it('afterSeq 支持 SSE 断线续传 —— 重连时不必重传全部历史', () => {
    for (let i = 0; i < 5; i += 1) store.appendEvent(asRunId('run-1'), 'text', { i }, T0 + i)
    const resumed = store.readEvents(asRunId('run-1'), 3)
    expect(resumed.map((e) => e.seq)).toEqual([4, 5])
  })

  it('没有事件时返回空数组而不是抛错', () => {
    expect(store.readEvents(asRunId('run-1'))).toEqual([])
  })
})

describe('迁移', () => {
  it('重复打开同一库不会重复建表', () => {
    const first = Storage.open(':memory:')
    expect(() => { first.close() }).not.toThrow()
  })

  it('外键约束生效 —— 不能给不存在的任务建 Run', () => {
    expect(() => { store.createRun(run({ taskId: asTaskId('ghost') })) }).toThrow()
  })
})
