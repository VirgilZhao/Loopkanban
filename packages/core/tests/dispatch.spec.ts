import { describe, expect, it } from 'vitest'
import {
  asProjectId, asRunId, asTaskId, planDispatch, type Task,
} from '../src/index.ts'

const T0 = 1_000_000

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id),
    projectId: asProjectId('b1'),
    revision: 1,
    column: 'ready',
    position: 0,
    subject: id,
    description: '',
    acceptance: ['ok'],
    repoPath: '/repo',
    baseBranch: 'main',
    blockedBy: [],
    createdAt: T0,
    updatedAt: T0,
    ...rest,
  }
}

const running = (id: string, patch: Partial<Task> = {}): Task => task({
  id,
  column: 'running',
  lease: { runId: asRunId(`run-${id}`), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 60_000 },
  ...patch,
})

const plan = (tasks: Task[], patch: Partial<Parameters<typeof planDispatch>[0]> = {}) =>
  planDispatch({
    tasks,
    availableProviders: ['claude', 'codex'],
    // 默认放宽：每条测试自己声明它要验证的上限，避免默认值意外参与断言。
    limits: { maxConcurrent: 99, maxPerRepo: 99 },
    now: T0,
    ...patch,
  })

describe('planDispatch', () => {
  it('按 position 顺序派发 ready 列的任务', () => {
    const result = plan([
      task({ id: 'c', position: 3 }),
      task({ id: 'a', position: 1 }),
      task({ id: 'b', position: 2 }),
    ])
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['a', 'b', 'c'])
  })

  it('带上派发时读到的 revision，供执行方做 CAS 认领', () => {
    const result = plan([task({ id: 'a', revision: 42 })])
    expect(result.dispatches[0]).toMatchObject({ taskId: 'a', expectedRevision: 42 })
  })

  it('尊重全局并发上限，且把超出的原因如实记下 —— 不做静默截断', () => {
    const result = plan(
      [running('r1'), running('r2'), task({ id: 'a' }), task({ id: 'b' })],
      { limits: { maxConcurrent: 3, maxPerRepo: 9 } },
    )
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['a'])
    expect(result.skipped).toEqual([
      { taskId: 'b', reason: 'global-limit-reached', detail: '全局并发已满 (3)' },
    ])
  })

  it('尊重单仓库并发上限，压住合并冲突', () => {
    const result = plan([
      running('r1', { repoPath: '/repo-x' }),
      task({ id: 'a', repoPath: '/repo-x' }),
      task({ id: 'b', repoPath: '/repo-y' }),
    ], { limits: { maxConcurrent: 9, maxPerRepo: 1 } })

    expect(result.dispatches.map((d) => d.taskId)).toEqual(['b'])
    expect(result.skipped[0]).toMatchObject({ taskId: 'a', reason: 'repo-limit-reached' })
  })

  it('依赖未完成的任务被跳过并说明原因', () => {
    const result = plan([
      task({ id: 'dep', column: 'ready' }),
      task({ id: 'a', blockedBy: [asTaskId('dep')], position: 5 }),
    ])
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['dep'])
    expect(result.skipped[0]).toMatchObject({ taskId: 'a', reason: 'blocked-by-dependency' })
  })

  it('依赖已 done 时放行', () => {
    const result = plan([
      task({ id: 'dep', column: 'done' }),
      task({ id: 'a', blockedBy: [asTaskId('dep')] }),
    ])
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['a'])
  })

  it('指定的 provider 没探测到时跳过，而不是偷偷换一个', () => {
    const result = plan(
      [task({ id: 'a', preferredProvider: 'codex' })],
      { availableProviders: ['claude'] },
    )
    expect(result.dispatches).toEqual([])
    expect(result.skipped[0]).toMatchObject({ taskId: 'a', reason: 'provider-unavailable' })
    expect(result.skipped[0]?.detail).toContain('codex')
  })

  it('一个 provider 都没有时全部跳过并说清楚', () => {
    const result = plan([task({ id: 'a' })], { availableProviders: [] })
    expect(result.skipped[0]?.detail).toContain('没有探测到')
  })

  it('租约过期的任务被标记为可回收，且不再占用并发名额', () => {
    const dead = task({
      id: 'dead',
      column: 'running',
      lease: { runId: asRunId('x'), provider: 'claude', acquiredAt: T0 - 100_000, expiresAt: T0 - 1 },
    })
    const result = plan([dead, running('alive'), task({ id: 'a' }), task({ id: 'b' })],
      { limits: { maxConcurrent: 2, maxPerRepo: 9 } })

    expect(result.reclaimable).toEqual(['dead'])
    // 名额只被 alive 占了一个，所以 a 还能派出去；若崩溃的 Run 一直占位，
    // 一次崩溃就会永久吃掉一个并发位。
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['a'])
  })

  it('非 ready 列的任务不参与派发', () => {
    const result = plan([
      task({ id: 'a', column: 'backlog' }),
      task({ id: 'b', column: 'review' }),
      task({ id: 'c', column: 'done' }),
    ])
    expect(result.dispatches).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('同一轮内派出的任务会累计占用名额', () => {
    const result = plan(
      [task({ id: 'a', position: 1 }), task({ id: 'b', position: 2 }), task({ id: 'c', position: 3 })],
      { limits: { maxConcurrent: 2, maxPerRepo: 9 } },
    )
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['a', 'b'])
    expect(result.skipped[0]).toMatchObject({ taskId: 'c', reason: 'global-limit-reached' })
  })
})


describe('归档与调度', () => {
  it('归档的卡不派，也不进 skipped —— 它本来就不在看板上，没什么要解释', () => {
    const result = plan([
      task({ id: 'shelved', archivedAt: T0 - 1 }),
      task({ id: 'live', position: 1 }),
    ])
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['live'])
    expect(result.skipped).toEqual([])
  })

  it('归档一张已完成的卡，不该把它的下游重新卡住', () => {
    const result = plan([
      task({ id: 'dep', column: 'done', archivedAt: T0 - 1 }),
      task({ id: 'next', blockedBy: [asTaskId('dep')] }),
    ])
    expect(result.dispatches.map((d) => d.taskId)).toEqual(['next'])
    expect(result.skipped).toEqual([])
  })
})
