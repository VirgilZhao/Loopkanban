import { describe, expect, it } from 'vitest'
import {
  acquireLease, archiveTask, asProjectId, asRunId, asTaskId, canTransition, COLUMNS, deleteTask,
  dropDependency, editTask, isLeaseExpired, moveTask, reclaimIfExpired, renewLease,
  unarchiveTask, type Task, taskTitle,
} from '../src/index.ts'

const T0 = 1_000_000

function task(patch: Partial<Task> = {}): Task {
  return {
    id: asTaskId('t1'),
    projectId: asProjectId('b1'),
    revision: 1,
    column: 'ready',
    position: 0,
    description: '加个函数',
    acceptance: ['函数存在并有测试'],
    repoPath: '/repo',
    baseBranch: 'main',
    blockedBy: [],
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
    // Done 里再说一句就是"再改一版"：卡回队列重跑，成果与 PR 记录都留着。
    expect(canTransition('done', 'ready')).toBe(true)
  })

  it('拦住乱跳 —— 否则「租约属于谁」无法推理', () => {
    expect(canTransition('backlog', 'running')).toBe(false)
    expect(canTransition('ready', 'done')).toBe(false)
    // done 只开去 ready 那一个口子 —— 倒回想法池等于把做完的事说成没做过。
    expect(canTransition('done', 'backlog')).toBe(false)
    expect(canTransition('running', 'done')).toBe(false)
    // running → ready 是系统回收租约的专属通道，人不能走。
    expect(canTransition('running', 'ready')).toBe(false)
  })

  it('没有 Failed 列 —— running 的唯一出口是 review，成败都过人眼', () => {
    expect(COLUMNS).not.toContain('failed')
    expect(COLUMNS).toEqual(['backlog', 'ready', 'running', 'review', 'done'])
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

  it('验收标准是可选的：没写也能进队列', () => {
    const result = moveTask(
      task({ column: 'backlog', acceptance: [] }),
      { expectedRevision: 1, to: 'ready', now: T0 },
    )
    expect(result).toMatchObject({ ok: true })
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
    for (const column of ['backlog', 'review', 'done'] as const) {
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

  it('改描述与验收标准并自增 revision', () => {
    const result = edit(task({ column: 'backlog' }), { description: '新内容', acceptance: ['A', ' ', 'B'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.description).toBe('新内容')
    // 空白项被剔除，免得验收清单里出现空条目。
    expect(result.value.acceptance).toEqual(['A', 'B'])
    expect(result.value.revision).toBe(2)
  })

  it('正在执行的卡片不能改需求 —— 否则人和 Agent 对着两份规格', () => {
    expect(edit(task({ column: 'running' }), { description: '改一下' }))
      .toMatchObject({ ok: false, reason: 'task-running' })
  })

  it('任何一列都能清空验收标准 —— 它是可选的', () => {
    expect(edit(task({ column: 'ready' }), { acceptance: [] }).ok).toBe(true)
    expect(edit(task({ column: 'backlog' }), { acceptance: [] }).ok).toBe(true)
  })

  it('可以指定模型，也可以显式清掉它', () => {
    const picked = edit(task({ column: 'backlog', preferredProvider: 'claude' }), { model: 'opus' })
    expect(picked).toMatchObject({ ok: true })
    if (!picked.ok) return
    expect(picked.value.model).toBe('opus')

    const cleared = edit(picked.value, { model: undefined }, picked.value.revision)
    expect(cleared).toMatchObject({ ok: true })
    if (!cleared.ok) return
    expect(cleared.value.model).toBeUndefined()
  })

  it('可以显式清除指定的 provider', () => {
    const withProvider = task({ column: 'backlog', preferredProvider: 'codex' })
    const result = edit(withProvider, { preferredProvider: undefined })
    expect(result.ok && result.value.preferredProvider).toBeUndefined()
  })

  it('没提到的字段原样保留', () => {
    const original = task({ column: 'backlog', description: '原描述', acceptance: ['原判据'] })
    const result = edit(original, { preferredProvider: 'codex' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.description).toBe('原描述')
    expect(result.value.acceptance).toEqual(['原判据'])
  })

  it('revision 不匹配时拒绝', () => {
    expect(edit(task({ column: 'backlog', revision: 5 }), { description: 'x' }, 4))
      .toMatchObject({ ok: false, reason: 'revision-conflict' })
  })
})

describe('归档', () => {
  const archive = (t: Task) => archiveTask(t, { expectedRevision: t.revision, now: T0 + 100 })

  it('归档不改变卡在哪一列 —— 它是正交的标记，不是第六列', () => {
    for (const column of ['backlog', 'ready', 'review', 'done'] as const) {
      const shelved = archive(task({ column }))
      expect(shelved.ok && shelved.value.column).toBe(column)
      expect(shelved.ok && shelved.value.archivedAt).toBe(T0 + 100)
    }
  })

  it('取消归档后回到原位，位置也不动', () => {
    const shelved = archive(task({ column: 'review', position: 3.5 }))
    if (!shelved.ok) throw new Error(shelved.detail)
    const back = unarchiveTask(shelved.value, { expectedRevision: shelved.value.revision, now: T0 + 200 })
    expect(back.ok && back.value).toMatchObject({ column: 'review', position: 3.5 })
    expect(back.ok && back.value.archivedAt).toBeUndefined()
  })

  it('正在执行的卡不能归档 —— 从界面上藏起来只会让人以为它停了', () => {
    const running = acquire(task())
    if (!running.ok) throw new Error('setup')
    expect(archive(running.value)).toMatchObject({ ok: false, reason: 'task-running' })
  })

  it('重复归档与取消未归档都明确失败，而不是静默成功', () => {
    const shelved = archive(task())
    if (!shelved.ok) throw new Error(shelved.detail)
    expect(archiveTask(shelved.value, { expectedRevision: shelved.value.revision, now: T0 }))
      .toMatchObject({ ok: false, reason: 'already-archived' })
    expect(unarchiveTask(task(), { expectedRevision: 1, now: T0 }))
      .toMatchObject({ ok: false, reason: 'not-archived' })
  })

  it('归档的卡不能被认领 —— 否则看不见的地方有 Agent 在改仓库', () => {
    const shelved = archive(task({ column: 'ready' }))
    if (!shelved.ok) throw new Error(shelved.detail)
    expect(acquire(shelved.value)).toMatchObject({ ok: false, reason: 'task-archived' })
  })

  it('归档的卡冻结：移不动也改不了', () => {
    const shelved = archive(task({ column: 'backlog' }))
    if (!shelved.ok) throw new Error(shelved.detail)
    const t = shelved.value
    expect(moveTask(t, { expectedRevision: t.revision, to: 'ready', now: T0 }))
      .toMatchObject({ ok: false, reason: 'task-archived' })
    expect(editTask(t, { expectedRevision: t.revision, edit: { description: '改个名' }, now: T0 }))
      .toMatchObject({ ok: false, reason: 'task-archived' })
  })

  it('归档也走 CAS —— 并发下不会有人拿着旧 revision 把卡收走', () => {
    expect(archiveTask(task(), { expectedRevision: 99, now: T0 }))
      .toMatchObject({ ok: false, reason: 'revision-conflict' })
  })
})

describe('删除', () => {
  const remove = (t: Task) => deleteTask(t, { expectedRevision: t.revision })

  it('想法池与队列里的卡可以删', () => {
    for (const column of ['backlog', 'ready'] as const) {
      expect(remove(task({ column }))).toMatchObject({ ok: true })
    }
  })

  it('Agent 动过仓库之后就不许删了 —— 那会让发生过什么无从追溯', () => {
    for (const column of ['running', 'review', 'done'] as const) {
      expect(remove(task({ column }))).toMatchObject({ ok: false, reason: 'not-deletable' })
    }
  })

  it('归档的卡可以直接删，不必先取出来 —— 两个动作指向同一个方向', () => {
    const shelved = archiveTask(task({ column: 'backlog' }), { expectedRevision: 1, now: T0 })
    if (!shelved.ok) throw new Error(shelved.detail)
    expect(remove(shelved.value)).toMatchObject({ ok: true })
  })

  it('挂着租约的卡不能删 —— 否则会留下一个没有卡片对应、却还在改仓库的进程', () => {
    const held = task({
      column: 'ready',
      lease: { runId: asRunId('r1'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 60_000 },
    })
    expect(remove(held)).toMatchObject({ ok: false, reason: 'lease-held' })
  })

  it('删除也走 CAS —— 拿着旧 revision 删不掉刚被人改过的卡', () => {
    expect(deleteTask(task({ column: 'backlog' }), { expectedRevision: 99 }))
      .toMatchObject({ ok: false, reason: 'revision-conflict' })
  })
})

describe('dropDependency', () => {
  const T2 = asTaskId('t2')

  it('摘掉指向被删任务的依赖，其余依赖原样保留', () => {
    const next = dropDependency(task({ blockedBy: [T2, asTaskId('t3')] }), T2, T0 + 100)
    expect(next?.blockedBy).toEqual([asTaskId('t3')])
    expect(next?.revision).toBe(2)
    expect(next?.updatedAt).toBe(T0 + 100)
  })

  it('本来就没依赖它就返回 null —— 不该白白推高 revision 让别人的 CAS 落空', () => {
    expect(dropDependency(task(), T2, T0)).toBeNull()
  })

  it('running 与归档的卡照样摘 —— 它们最不能留着悬空引用', () => {
    const running = task({ column: 'running', blockedBy: [T2] })
    expect(dropDependency(running, T2, T0)?.blockedBy).toEqual([])
    const shelved = task({ column: 'ready', archivedAt: T0, blockedBy: [T2] })
    expect(dropDependency(shelved, T2, T0)?.blockedBy).toEqual([])
  })
})

describe('taskTitle', () => {
  it('取描述的第一行 —— 人写多行时，第一行本来就是那句话', () => {
    expect(taskTitle({ id: asTaskId('t1'), description: '加个 slugify\n\n要处理中文' })).toBe('加个 slugify')
  })

  it('前面的空行不算数', () => {
    expect(taskTitle({ id: asTaskId('t1'), description: '\n\n  真正的第一行  \n第二行' })).toBe('真正的第一行')
  })

  it('太长就截断 —— 分支名与提交信息里塞不下', () => {
    const title = taskTitle({ id: asTaskId('t1'), description: 'x'.repeat(200) })
    expect(title.length).toBeLessThanOrEqual(61)
    expect(title.endsWith('…')).toBe(true)
  })

  it('一个字都没写就退回任务 id —— 空白的分支名比丑的更糟', () => {
    expect(taskTitle({ id: asTaskId('t-abc'), description: '   \n  ' })).toBe('t-abc')
  })
})
