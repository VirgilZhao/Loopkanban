/**
 * 任务的领域模型与状态机。全部是纯函数，不碰数据库也不起进程。
 *
 * 并发控制沿用 append-only + 单调 `revision` 的 compare-and-set：每次变更
 * 带上期望的 revision，不匹配就拒绝。这样「两个调度器同时认领同一张卡」
 * 会有一方明确失败，而不是双方都以为自己成功了。
 */

import type { BoardId, RunId, TaskId } from './ids.ts'

/** 看板的列。顺序即流转顺序。 */
export const COLUMNS = ['backlog', 'ready', 'running', 'review', 'done', 'failed'] as const
export type Column = (typeof COLUMNS)[number]

/** 一次执行的租约。持有它才有资格动这张卡的 running 状态。 */
export interface Lease {
  readonly runId: RunId
  readonly provider: string
  readonly acquiredAt: number
  /** 毫秒时间戳。超过即视为失效，卡片可被回收。 */
  readonly expiresAt: number
}

export interface Task {
  readonly id: TaskId
  readonly boardId: BoardId
  /** 单调递增，每次变更 +1，用作 compare-and-set 的凭据。 */
  readonly revision: number
  readonly column: Column
  /** 列内排序，允许非整数以便插入时不必重排全列。 */
  readonly position: number
  readonly subject: string
  readonly description: string
  /** 验收标准。进入 ready 要求非空 —— 没有判据的任务无法验收。 */
  readonly acceptance: readonly string[]
  readonly repoPath: string
  readonly baseBranch: string
  /** 指定执行器；未指定则由调度器在已探测到的 provider 里挑。 */
  readonly preferredProvider?: string | undefined
  readonly blockedBy: readonly TaskId[]
  /** 建议性的写入范围前缀，用于并发冲突预警，不是锁。 */
  readonly writeScopes: readonly string[]
  /** `undefined` 表示未被占用；清除租约就是把它置回 undefined。 */
  readonly lease?: Lease | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** 允许的列流转。故意收紧：随便乱跳会让「租约属于谁」变得无法推理。 */
const ALLOWED: Readonly<Record<Column, readonly Column[]>> = {
  backlog: ['ready'],
  ready: ['backlog', 'running'],
  running: ['review', 'failed'],
  review: ['done', 'ready', 'failed'],
  done: [],
  // 失败后可以改需求重排队，也可以直接放回想法池。
  failed: ['ready', 'backlog'],
}

/**
 * 某个流转是否被允许。
 * @param from - 当前列。
 * @param to - 目标列。
 */
export function canTransition(from: Column, to: Column): boolean {
  return from === to || ALLOWED[from].includes(to)
}

/** 领域操作的结果：要么成功带出新值，要么失败带出可判别的原因。 */
export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DomainError; readonly detail: string }

export type DomainError =
  | 'revision-conflict'
  | 'illegal-transition'
  | 'acceptance-required'
  | 'blocked-by-dependency'
  | 'lease-held'
  | 'lease-missing'
  | 'lease-mismatch'

const fail = <T>(reason: DomainError, detail: string): DomainResult<T> => ({ ok: false, reason, detail })
const succeed = <T>(value: T): DomainResult<T> => ({ ok: true, value })

/** 每次变更都走这里，保证 revision 与 updatedAt 不会被漏掉。 */
function bump(task: Task, patch: Partial<Task>, now: number): Task {
  return { ...task, ...patch, revision: task.revision + 1, updatedAt: now }
}

/**
 * 校验 compare-and-set 凭据。
 * @param task - 当前任务。
 * @param expectedRevision - 调用方读到的 revision。
 */
function checkRevision(task: Task, expectedRevision: number): DomainResult<Task> {
  return task.revision === expectedRevision
    ? succeed(task)
    : fail('revision-conflict', `期望 revision ${String(expectedRevision)}，实际 ${String(task.revision)}`)
}

export interface MoveRequest {
  readonly expectedRevision: number
  readonly to: Column
  readonly position?: number
  readonly now: number
}

/**
 * 把任务移到另一列。
 * @param task - 当前任务。
 * @param request - 目标列、CAS 凭据与时间。
 * @returns 新的任务值，或失败原因。
 */
export function moveTask(task: Task, request: MoveRequest): DomainResult<Task> {
  const guard = checkRevision(task, request.expectedRevision)
  if (!guard.ok) return guard

  if (!canTransition(task.column, request.to)) {
    return fail('illegal-transition', `不允许从 ${task.column} 移到 ${request.to}`)
  }
  // 没有验收标准的任务不能进队列：Agent 干完了也没人能判定它对不对。
  if (request.to === 'ready' && task.acceptance.length === 0) {
    return fail('acceptance-required', '进入 ready 前必须写明验收标准')
  }
  // 离开 running 时租约必须一并释放，否则卡片会永远显示"被占用"。
  const patch: Partial<Task> = request.to === 'running'
    ? {}
    : { lease: undefined }

  return succeed(bump(task, {
    ...patch,
    column: request.to,
    ...(request.position === undefined ? {} : { position: request.position }),
  }, request.now))
}

export interface AcquireLeaseRequest {
  readonly expectedRevision: number
  readonly runId: RunId
  readonly provider: string
  readonly ttlMs: number
  readonly now: number
  /** 已完成的任务 id 集合，用于判断依赖是否解开。 */
  readonly completed: ReadonlySet<TaskId>
}

/**
 * 认领任务：取得租约并进入 running。这是防止两个 Agent 抢同一张卡的地方。
 * @param task - 当前任务。
 * @param request - CAS 凭据、执行者身份、租期与依赖信息。
 */
export function acquireLease(task: Task, request: AcquireLeaseRequest): DomainResult<Task> {
  const guard = checkRevision(task, request.expectedRevision)
  if (!guard.ok) return guard

  if (task.column !== 'ready') {
    return fail('illegal-transition', `只有 ready 列的任务可以被认领，当前在 ${task.column}`)
  }
  const unmet = task.blockedBy.filter((id) => !request.completed.has(id))
  if (unmet.length > 0) {
    return fail('blocked-by-dependency', `依赖未完成: ${unmet.join(', ')}`)
  }
  // 未过期的租约仍然有效，说明别人先到了。
  if (task.lease !== undefined && task.lease.expiresAt > request.now) {
    return fail('lease-held', `已被 ${task.lease.provider} 的 ${task.lease.runId} 持有`)
  }

  return succeed(bump(task, {
    column: 'running',
    lease: {
      runId: request.runId,
      provider: request.provider,
      acquiredAt: request.now,
      expiresAt: request.now + request.ttlMs,
    },
  }, request.now))
}

/**
 * 续租。长任务必须定期续，否则会被回收器当成崩溃的 Run 收走。
 * @param task - 当前任务。
 * @param runId - 声称持有租约的 Run。
 * @param ttlMs - 新的租期。
 * @param now - 当前时间。
 */
export function renewLease(task: Task, runId: RunId, ttlMs: number, now: number): DomainResult<Task> {
  if (task.lease === undefined) return fail('lease-missing', '任务当前没有租约')
  if (task.lease.runId !== runId) {
    return fail('lease-mismatch', `租约属于 ${task.lease.runId}，不是 ${runId}`)
  }
  return succeed(bump(task, { lease: { ...task.lease, expiresAt: now + ttlMs } }, now))
}

/** 租约是否已失效（不存在也算失效）。 */
export function isLeaseExpired(task: Task, now: number): boolean {
  return task.lease === undefined || task.lease.expiresAt <= now
}

/**
 * 回收：把租约过期却还卡在 running 的任务放回 ready。
 *
 * 这是「进程崩溃 / 机器重启 / Agent 卡死」之后任务不会永远消失的唯一保障。
 * @param task - 当前任务。
 * @param now - 当前时间。
 * @returns 回收后的任务；无需回收时返回 null。
 */
export function reclaimIfExpired(task: Task, now: number): Task | null {
  if (task.column !== 'running' || !isLeaseExpired(task, now)) return null
  return bump(task, { column: 'ready', lease: undefined }, now)
}
