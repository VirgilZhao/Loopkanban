/**
 * 任务的领域模型与状态机。全部是纯函数，不碰数据库也不起进程。
 *
 * 并发控制沿用 append-only + 单调 `revision` 的 compare-and-set：每次变更
 * 带上期望的 revision，不匹配就拒绝。这样「两个调度器同时认领同一张卡」
 * 会有一方明确失败，而不是双方都以为自己成功了。
 */

import type { ProjectId, RunId, TaskId } from './ids.ts'

/** 看板的列。顺序即流转顺序。 */
export const COLUMNS = ['backlog', 'ready', 'running', 'review', 'done'] as const
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
  readonly projectId: ProjectId
  /** 单调递增，每次变更 +1，用作 compare-and-set 的凭据。 */
  readonly revision: number
  readonly column: Column
  /** 列内排序，允许非整数以便插入时不必重排全列。 */
  readonly position: number
  /**
   * 卡片的全部内容。**没有单独的标题** —— 一句话的活写一句话，复杂的活
   * 写一段，逼人先起个标题只是多一道手续。要显示"叫什么"时取第一行，
   * 见 {@link taskTitle}。
   */
  readonly description: string
  /**
   * 验收标准。**可选** —— 有判据当然更好（Agent 照着做，人照着验），
   * 但强制它等于给每张卡都加一道门槛，而很多活的判据就是"跑起来对不对"。
   */
  readonly acceptance: readonly string[]
  /** 项目仓库路径。跟着项目走，建卡时定下，之后不由人改。 */
  readonly repoPath: string
  readonly baseBranch: string
  /** 指定执行器；未指定则由调度器在已探测到的 provider 里挑。 */
  readonly preferredProvider?: string | undefined
  /**
   * 指定模型。留空就用那个 CLI 自己的默认 —— 我们不替它做主。
   * 只在指定了执行器时有意义：模型名是各家 CLI 自己的说法，不通用。
   */
  readonly model?: string | undefined
  readonly blockedBy: readonly TaskId[]
  /** `undefined` 表示未被占用；清除租约就是把它置回 undefined。 */
  readonly lease?: Lease | undefined
  /**
   * 归档时间；`undefined` 表示没归档。
   *
   * **刻意不做成第六列**。归档是"从视野里拿走"，不是流转的下一站 ——
   * 一张卡可以在任何阶段被搁置：想法池里想岔了的、Review 里判定不做的、
   * Done 里已经不用再看的。做成列的话，它既要能从每一列进来、又要能回到
   * 原来那一列，状态机会被这一个动作撑破；而且列是可见的，归档的意义恰恰
   * 是不可见。所以它是一个正交的标记，`column` 保持原样，取消归档就回到
   * 搁置前的位置。
   */
  readonly archivedAt?: number | undefined
  /**
   * 验收通过、进入 Done 的那一刻；`undefined` 表示还没走到那一步。
   *
   * 不复用 `updatedAt`：Done 是终点，但卡片进去之后仍会被动 —— 归档、
   * 补一句描述都会把 `updatedAt` 推到今天。拿它排序，一张半年前完成的卡
   * 会因为刚被归档而排到队首。`doneAt` 只在跨进 Done 的那一次写入，
   * 之后不再变（Done 没有出口，重排列内位置也不重写它），所以它就是
   * "这张卡是什么时候做完的"。
   */
  readonly doneAt?: number | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * 允许的列流转。
 *
 * 收紧的目标只有两个：**不许跳过认领**（那会让「租约属于谁」无法推理），
 * **不许跳过验收**（那等于让 Agent 自己给自己盖章）。除此之外的移动都是
 * 无租约状态之间的整理动作，一律放行 —— 过度收紧只会逼用户绕路。
 */
const ALLOWED: Readonly<Record<Column, readonly Column[]>> = {
  backlog: ['ready'],
  ready: ['backlog', 'running'],
  // running 的唯一出口是 review —— **成功与失败都要过人眼**。
  // 单独设一个 Failed 列只会攒下一堆没人再看的卡；失败的那次执行同样有
  // 分支、日志和诊断要判读，判读完的动作也和打回一模一样。
  // 直接去 done 是跳过验收；回 ready 也不行 —— 那是系统回收租约的专属通道，
  // 见 reclaimIfExpired。
  running: ['review'],
  // 验收后：通过、打回重做、或者废弃成果回想法池重新想需求。
  review: ['done', 'ready', 'backlog'],
  done: [],
}

/**
 * 某个流转是否被允许。
 * @param from - 当前列。
 * @param to - 目标列。
 */
export function canTransition(from: Column, to: Column): boolean {
  return from === to || ALLOWED[from].includes(to)
}

/** 显示名的长度上限。再长的第一行在卡片、分支名、提交信息里都塞不下。 */
const TITLE_MAX = 60

/**
 * 卡片的显示名：描述的第一行。
 *
 * 任务没有独立的标题字段，但分支名、提交信息、通知标题这些地方都需要一个
 * 短称呼。取第一行是最不意外的规则 —— 人写多行时，第一行本来就是那句话。
 *
 * @param task - 只需要 id 与描述。
 * @returns 第一行（截断到 60 字）；一个字都没写时退回任务 id。
 */
export function taskTitle(task: Pick<Task, 'id' | 'description'>): string {
  const first = task.description.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  if (first === undefined) return String(task.id)
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first
}

/** 领域操作的结果：要么成功带出新值，要么失败带出可判别的原因。 */
export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DomainError; readonly detail: string }

export type DomainError =
  | 'revision-conflict'
  | 'illegal-transition'
  | 'blocked-by-dependency'
  | 'lease-held'
  | 'lease-missing'
  | 'lease-mismatch'
  | 'task-running'
  | 'task-archived'
  | 'already-archived'
  | 'not-archived'
  | 'not-deletable'

const fail = <T>(reason: DomainError, detail: string): DomainResult<T> => ({ ok: false, reason, detail })
const succeed = <T>(value: T): DomainResult<T> => ({ ok: true, value })

/** 每次变更都走这里，保证 revision 与 updatedAt 不会被漏掉。 */
type TaskPatch = Partial<Omit<Task, 'preferredProvider'>> & { readonly preferredProvider?: string | undefined }

function bump(task: Task, patch: TaskPatch, now: number): Task {
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

/**
 * 归档的卡是冻结的：不能移、不能改、不能被认领。
 *
 * 要动它就先取消归档 —— 多按一下的代价，换来的是"搁置"这个动作有明确边界，
 * 而不是一个既在架子上、又能被半改半跑的中间态。
 */
function checkNotArchived(task: Task): DomainResult<Task> {
  return task.archivedAt === undefined
    ? succeed(task)
    : fail('task-archived', '这张卡已归档。要动它先取消归档')
}

export interface ArchiveRequest {
  readonly expectedRevision: number
  readonly now: number
}

/**
 * 归档：把卡从视野里拿走，但保留它所在的列与全部内容。
 *
 * 正在执行的卡不能归档 —— Agent 还拿着租约在改仓库，从界面上把它藏起来
 * 只会让人以为它停了。要搁置就先终止执行。
 *
 * @param task - 当前任务。
 * @param request - CAS 凭据与时间。
 */
export function archiveTask(task: Task, request: ArchiveRequest): DomainResult<Task> {
  const guard = checkRevision(task, request.expectedRevision)
  if (!guard.ok) return guard
  if (task.column === 'running') {
    return fail('task-running', '正在执行的卡片不能归档，先终止执行')
  }
  if (task.archivedAt !== undefined) {
    return fail('already-archived', '这张卡已经归档了')
  }
  return succeed(bump(task, { archivedAt: request.now }, request.now))
}

/**
 * 取消归档：卡回到它被搁置时所在的列与位置。
 * @param task - 当前任务。
 * @param request - CAS 凭据与时间。
 */
export function unarchiveTask(task: Task, request: ArchiveRequest): DomainResult<Task> {
  const guard = checkRevision(task, request.expectedRevision)
  if (!guard.ok) return guard
  if (task.archivedAt === undefined) {
    return fail('not-archived', '这张卡没有归档')
  }
  return succeed(bump(task, { archivedAt: undefined }, request.now))
}

/** 可以删除的列。**只有 Agent 还没碰过的卡**：想法池与队列。 */
const DELETABLE: readonly Column[] = ['backlog', 'ready']

export interface DeleteRequest {
  readonly expectedRevision: number
}

/**
 * 删除一张卡：判定它能不能删。
 *
 * 与归档的分工：归档是"从视野里拿走但留着"，删除是"这张卡本身就是多余的"
 * —— 想法池里写废的点子、队列里重复排进去的活。攒着它们只会让看板越来越
 * 难扫，而归档不解决这个问题：归档是给"以后可能还要"准备的。
 *
 * **只允许 backlog 与 ready**。再往后每一列都意味着 Agent 已经动过仓库：
 * running 有活着的进程和租约，review 有等着人判读的 diff，done 是审计记录。
 * 这几列该走的是终止 / 废弃 / 归档 —— 删掉它们等于让"发生过什么"无从追溯。
 * 要删一张已经跑过的卡，先废弃回想法池。
 *
 * 归档的卡可以直接删。归档冻结的是那些会造出半途状态的动作（移动、改需求、
 * 被认领），删除和归档指向的是同一个方向，不必先取出来再删一次。
 *
 * 只做判定、不产出新值：删除没有"新的任务值"，副作用（连同执行历史与
 * worktree 一并抹掉）由调用方负责。
 *
 * @param task - 当前任务。
 * @param request - CAS 凭据。
 * @returns 原样的任务，表示可以删；或拒绝的原因。
 */
export function deleteTask(task: Task, request: DeleteRequest): DomainResult<Task> {
  const guard = checkRevision(task, request.expectedRevision)
  if (!guard.ok) return guard
  if (!DELETABLE.includes(task.column)) {
    return fail('not-deletable', `只有 Backlog 与 Ready 的卡可以删除，当前在 ${task.column}`)
  }
  // 队列里的卡不该带着租约（离开 running 时一并释放）。真带着就说明有 Run
  // 正抓着它，删掉会留下一个还在改仓库、却再也没有卡片对应的进程。
  if (task.lease !== undefined) {
    return fail('lease-held', `这张卡还挂着 ${task.lease.provider} 的租约，先终止那次执行`)
  }
  return succeed(task)
}

/**
 * 摘掉一条指向已删除任务的依赖。
 *
 * 这是引用完整性的修补，不是人工编辑：`blockedBy` 里留着一个已经不存在的
 * id，调度器会永远算它"依赖未完成"，那张卡再也不会被派出去，界面上却只
 * 显示一个查无此卡的 id —— 没有任何操作能解开它。
 *
 * 刻意不设列与归档的守卫。running 的卡同样可能依赖被删的那张，而它恰恰
 * 最不能留着悬空引用：打回之后它还要重新排队。
 *
 * @param task - 待检查的任务。
 * @param on - 被删掉的任务 id。
 * @param now - 当前时间。
 * @returns 摘除后的新值；本来就没依赖它则返回 null。
 */
export function dropDependency(task: Task, on: TaskId, now: number): Task | null {
  if (!task.blockedBy.includes(on)) return null
  return bump(task, { blockedBy: task.blockedBy.filter((id) => id !== on) }, now)
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

  const shelved = checkNotArchived(task)
  if (!shelved.ok) return shelved
  if (!canTransition(task.column, request.to)) {
    return fail('illegal-transition', `不允许从 ${task.column} 移到 ${request.to}`)
  }
  // 离开 running 时租约必须一并释放，否则卡片会永远显示"被占用"。
  const patch: Partial<Task> = request.to === 'running'
    ? {}
    : { lease: undefined }

  // 只在**跨进** Done 的那一次盖时间戳。done → done 是列内重排（唯一还被
  // 允许的自反流转），拿它重写 doneAt 等于"拖一下就把完成时间改成现在"。
  const done: Partial<Task> = request.to === 'done' && task.column !== 'done'
    ? { doneAt: request.now }
    : {}

  return succeed(bump(task, {
    ...patch,
    ...done,
    column: request.to,
    ...(request.position === undefined ? {} : { position: request.position }),
  }, request.now))
}

/** 允许人工编辑的字段。执行相关的状态（列、租约、revision）不在此列。 */
export interface TaskEdit {
  readonly description?: string
  readonly acceptance?: readonly string[]
  readonly preferredProvider?: string | undefined
  readonly model?: string | undefined
  readonly blockedBy?: readonly TaskId[]
}

export interface EditRequest {
  readonly expectedRevision: number
  readonly edit: TaskEdit
  readonly now: number
}

/**
 * 编辑任务内容。
 *
 * **正在执行的卡片不可编辑**：Agent 已经拿着 TASK.md 在干活了，此刻改需求
 * 只会让人和机器对着两份不同的规格，产出无从验收。要改就先终止。
 *
 * @param task - 当前任务。
 * @param request - CAS 凭据、要改的字段与时间。
 */
export function editTask(task: Task, request: EditRequest): DomainResult<Task> {
  const guard = checkRevision(task, request.expectedRevision)
  if (!guard.ok) return guard
  if (task.column === 'running') {
    return fail('task-running', '正在执行的卡片不能改需求，先终止执行')
  }
  const shelved = checkNotArchived(task)
  if (!shelved.ok) return shelved

  const { edit } = request
  const acceptance = edit.acceptance?.map((item) => item.trim()).filter((item) => item.length > 0)

  return succeed(bump(task, {
    ...(edit.description === undefined ? {} : { description: edit.description }),
    ...(acceptance === undefined ? {} : { acceptance }),
    ...('preferredProvider' in edit ? { preferredProvider: edit.preferredProvider } : {}),
    ...('model' in edit ? { model: edit.model } : {}),
    ...(edit.blockedBy === undefined ? {} : { blockedBy: [...edit.blockedBy] }),
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

  // **这一条最要紧**：归档的卡在界面上是看不见的，被自动调度捡走就意味着
  // 用户看不见的地方有 Agent 在改他的仓库。
  const shelved = checkNotArchived(task)
  if (!shelved.ok) return shelved
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
