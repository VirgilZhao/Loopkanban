import { describe, expect, it } from 'vitest'
import {
  acquireLease, asBoardId, asRunId, asTaskId, canTransition, editTask, isLeaseExpired,
  moveTask, reclaimIfExpired, renewLease, type Task,
} from '../src/index.ts'

const T0 = 1_000_000

function task(patch: Partial<Task> = {}): Task {
  return {
    id: asTaskId('t1'),
    boardId: asBoardId('b1'),
    revision: 1,
    column: 'ready',
    position: 0,
    subject: '加个函数',
    description: '',
    acceptance: ['函数存在并有测试'],
    repoPath: '/repo',
    baseBranch: 'main',
    blockedBy: [],
    writeScopes: [],
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  }
}

const acquire = (t: Task, patch: Partial<Parameters<typeof acquireLease>[1]> = {}) =>
  acquireLease(t, {
    expectedRevision: t.revision,
    runId: asRunId('r1'),
    provider: 'claude',
    ttlMs: 60_000,
    now: T0,
    completed: new Set(),
    ...patch,
  })

describe('canTransition', () => {
  it('放行正常流转', () => {
    expect(canTransition('backlog', 'ready')).toBe(true)
    expect(canTransition('running', 'review')).toBe(true)
    expect(canTransition('review', 'done')).toBe(true)
    expect(canTransition('review', 'ready')).toBe(true)
    // 废弃成果、回想法池重新想需求：无租约状态之间的整理，该放行。
    expect(canTransition('review', 'backlog')).toBe(true)
    expect(canTransition('failed', 'ready')).toBe(true)
  })

  it('拦住乱跳 —— 否则「租约属于谁」无法推理', () => {
    expect(canTransition('backlog', 'running')).toBe(false)
    expect(canTransition('ready', 'done')).toBe(false)
    expect(canTransition('done', 'ready')).toBe(false)
    expect(canTransition('running', 'done')).toBe(false)
    // running → ready 是系统回收租约的专属通道，人不能走。
    expect(canTransition('running', 'ready')).toBe(false)
  })
})

describe('moveTask', () => {
  it('revision 不匹配时拒绝 —— 这是防并发写覆盖的地方', () => {
    const result = moveTask(task({ revision: 5 }), { expectedRevision: 4, to: 'running', now: T0 })
    expect(result).toMatchObject({ ok: false, reason: 'revision-conflict' })
  })

  it('成功时 revision 自增', () => {
    const result = moveTask(task({ column: 'backlog' }), { expectedRevision: 1, to: 'ready', now: T0 + 5 })
    expect(result.ok && result.value.revision).toBe(2)
    expect(result.ok && result.value.updatedAt).toBe(T0 + 5)
  })

  it('没有验收标准的任务进不了 ready —— 干完了也没人能判定对不对', () => {
    const result = moveTask(
      task({ column: 'backlog', acceptance: [] }),
      { expectedRevision: 1, to: 'ready', now: T0 },
    )
    expect(result).toMatchObject({ ok: false, reason: 'acceptance-required' })
  })

  it('离开 running 时一并释放租约，否则卡片会永远显示被占用', () => {
    const running = task({
      column: 'running',
      lease: { runId: asRunId('r1'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 60_000 },
    })
    const result = moveTask(running, { expectedRevision: 1, to: 'review', now: T0 })
    expect(result.ok && result.value.lease).toBeUndefined()
  })
})

describe('acquireLease', () => {
  it('认领成功后进入 running 并持有租约', () => {
    const result = acquire(task())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.column).toBe('running')
    expect(result.value.lease).toMatchObject({ runId: 'r1', provider: 'claude', expiresAt: T0 + 60_000 })
  })

  it('两个调度器读到同一快照时，后写的一方被 CAS 拒绝', () => {
    const snapshot = task({ revision: 7 })

    // 调度器 A 先提交，任务 revision 变成 8。
    const a = acquire(snapshot, { expectedRevision: 7, runId: asRunId('rA') })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.value.revision).toBe(8)

    // 调度器 B 手里还是 revision 7 的旧快照，提交时必须被拒。
    const b = acquireLease(a.value, {
      expectedRevision: 7,
      runId: asRunId('rB'), provider: 'codex', ttlMs: 60_000, now: T0, completed: new Set(),
    })
    expect(b).toMatchObject({ ok: false, reason: 'revision-conflict' })
  })

  it('即使 revision 对上，已在 running 的任务也认领不了', () => {
    const a = acquire(task())
    if (!a.ok) return
    const b = acquireLease(a.value, {
      expectedRevision: a.value.revision,
      runId: asRunId('rB'), provider: 'codex', ttlMs: 60_000, now: T0, completed: new Set(),
    })
    expect(b).toMatchObject({ ok: false, reason: 'illegal-transition' })
  })

  it('依赖未完成时拒绝认领', () => {
    const result = acquire(task({ blockedBy: [asTaskId('dep')] }))
    expect(result).toMatchObject({ ok: false, reason: 'blocked-by-dependency' })
  })

  it('依赖已完成时放行', () => {
    const result = acquire(task({ blockedBy: [asTaskId('dep')] }), { completed: new Set([asTaskId('dep')]) })
    expect(result.ok).toBe(true)
  })

  it('租约未过期时不能被抢', () => {
    const held = task({
      lease: { runId: asRunId('other'), provider: 'codex', acquiredAt: T0, expiresAt: T0 + 60_000 },
    })
    expect(acquire(held)).toMatchObject({ ok: false, reason: 'lease-held' })
  })

  it('租约已过期则可以被重新认领', () => {
    const stale = task({
      lease: { runId: asRunId('dead'), provider: 'codex', acquiredAt: T0 - 100_000, expiresAt: T0 - 1 },
    })
    expect(acquire(stale).ok).toBe(true)
  })

  it('只有 ready 列的任务可以被认领', () => {
    for (const column of ['backlog', 'review', 'done', 'failed'] as const) {
      expect(acquire(task({ column }))).toMatchObject({ ok: false, reason: 'illegal-transition' })
    }
  })
})

describe('renewLease', () => {
  it('持有者可以续租', () => {
    const running = acquire(task())
    expect(running.ok).toBe(true)
    if (!running.ok) return
    const renewed = renewLease(running.value, asRunId('r1'), 30_000, T0 + 50_000)
    expect(renewed.ok && renewed.value.lease?.expiresAt).toBe(T0 + 80_000)
  })

  it('非持有者不能续租', () => {
    const running = acquire(task())
    if (!running.ok) return
    expect(renewLease(running.value, asRunId('impostor'), 30_000, T0))
      .toMatchObject({ ok: false, reason: 'lease-mismatch' })
  })

  it('没有租约时续租失败', () => {
    expect(renewLease(task(), asRunId('r1'), 30_000, T0))
      .toMatchObject({ ok: false, reason: 'lease-missing' })
  })
})

describe('reclaimIfExpired', () => {
  it('租约过期且卡在 running 的任务被放回 ready —— 崩溃后任务不会永远消失', () => {
    const stuck = task({
      column: 'running',
      lease: { runId: asRunId('dead'), provider: 'claude', acquiredAt: T0 - 100_000, expiresAt: T0 - 1 },
    })
    const reclaimed = reclaimIfExpired(stuck, T0)
    expect(reclaimed?.column).toBe('ready')
    expect(reclaimed?.lease).toBeUndefined()
    expect(reclaimed?.revision).toBe(stuck.revision + 1)
  })

  it('租约仍有效时不动它', () => {
    const alive = task({
      column: 'running',
      lease: { runId: asRunId('r1'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 60_000 },
    })
    expect(reclaimIfExpired(alive, T0)).toBeNull()
  })

  it('不在 running 列的任务不参与回收', () => {
    expect(reclaimIfExpired(task({ column: 'review' }), T0)).toBeNull()
  })

  it('没有租约也算过期', () => {
    expect(isLeaseExpired(task(), T0)).toBe(true)
  })
})


describe('editTask', () => {
  const edit = (t: Task, patch: Parameters<typeof editTask>[1]['edit'], rev = t.revision) =>
    editTask(t, { expectedRevision: rev, edit: patch, now: T0 + 9 })

  it('改标题与验收标准并自增 revision', () => {
    const result = edit(task({ column: 'backlog' }), { subject: '  新标题  ', acceptance: ['A', ' ', 'B'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.subject).toBe('新标题')
    // 空白项被剔除，免得验收清单里出现空条目。
    expect(result.value.acceptance).toEqual(['A', 'B'])
    expect(result.value.revision).toBe(2)
  })

  it('正在执行的卡片不能改需求 —— 否则人和 Agent 对着两份规格', () => {
    expect(edit(task({ column: 'running' }), { subject: '改一下' }))
      .toMatchObject({ ok: false, reason: 'task-running' })
  })

  it('空标题被拒', () => {
    expect(edit(task({ column: 'backlog' }), { subject: '   ' }))
      .toMatchObject({ ok: false, reason: 'subject-required' })
  })

  it('队列中的卡不能清空验收标准，否则会变成一张无法验收的活卡', () => {
    expect(edit(task({ column: 'ready' }), { acceptance: [] }))
      .toMatchObject({ ok: false, reason: 'acceptance-required' })
    // 但在 backlog 里随便清。
    expect(edit(task({ column: 'backlog' }), { acceptance: [] }).ok).toBe(true)
  })

  it('可以显式清除指定的 provider', () => {
    const withProvider = task({ column: 'backlog', preferredProvider: 'codex' })
    const result = edit(withProvider, { preferredProvider: undefined })
    expect(result.ok && result.value.preferredProvider).toBeUndefined()
  })

  it('没提到的字段原样保留', () => {
    const original = task({ column: 'backlog', description: '原描述', writeScopes: ['src/'] })
    const result = edit(original, { subject: '只改标题' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.description).toBe('原描述')
    expect(result.value.writeScopes).toEqual(['src/'])
  })

  it('revision 不匹配时拒绝', () => {
    expect(edit(task({ column: 'backlog', revision: 5 }), { subject: 'x' }, 4))
      .toMatchObject({ ok: false, reason: 'revision-conflict' })
  })
})
