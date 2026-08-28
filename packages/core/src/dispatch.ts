/**
 * 调度决策：从 ready 列里挑出这一轮该派给谁。
 *
 * 刻意做成**纯函数** —— 不读数据库、不起进程、不看时钟（时间由参数传入）。
 * 自动认领是本项目的核心卖点，也是最容易出并发 bug 的地方；把决策与副作用
 * 分开，就能用普通单测覆盖「并发上限、依赖阻塞、租约回收、provider 不可用」
 * 这些分支，而不必真的去起十个 Agent。
 *
 * 另一条原则：**不做静默截断**。因为名额、依赖或 provider 不可用而没派出去
 * 的任务，都带原因出现在 {@link DispatchPlan.skipped} 里，UI 要能解释
 * 「为什么我的卡还没动」。
 */

import type { TaskId } from './ids.ts'
import { isLeaseExpired, type Task } from './task.ts'

export interface DispatchLimits {
  /** 全局同时运行的 Run 上限。 */
  readonly maxConcurrent: number
  /** 单个仓库同时运行的上限，用来压住合并冲突。 */
  readonly maxPerRepo: number
}

export interface DispatchInput {
  readonly tasks: readonly Task[]
  /** 本机探测到、当前可用的 provider id。 */
  readonly availableProviders: readonly string[]
  readonly limits: DispatchLimits
  readonly now: number
}

export interface Dispatch {
  readonly taskId: TaskId
  /** 派发时读到的 revision，执行方必须拿它做 CAS 认领。 */
  readonly expectedRevision: number
  readonly provider: string
}

export type SkipReason =
  | 'blocked-by-dependency'
  | 'global-limit-reached'
  | 'repo-limit-reached'
  | 'provider-unavailable'

export interface Skip {
  readonly taskId: TaskId
  readonly reason: SkipReason
  readonly detail: string
}

export interface DispatchPlan {
  readonly dispatches: readonly Dispatch[]
  readonly skipped: readonly Skip[]
  /** 租约过期、应当被回收回 ready 的任务。 */
  readonly reclaimable: readonly TaskId[]
}

/** 选一个可用的 provider：指定了就必须用指定的，否则取第一个可用的。 */
function pickProvider(task: Task, available: readonly string[]): string | null {
  if (task.preferredProvider !== undefined) {
    return available.includes(task.preferredProvider) ? task.preferredProvider : null
  }
  return available[0] ?? null
}

/**
 * 计算这一轮的派发计划。
 * @param input - 全部任务、可用 provider、并发上限与当前时间。
 * @returns 该派发的、该跳过的、以及该回收的。
 */
export function planDispatch(input: DispatchInput): DispatchPlan {
  const { tasks, availableProviders, limits, now } = input

  // 归档的 done 卡照样算"依赖已完成"：把做完的东西收进架子，不该让它的
  // 下游重新被卡住。
  const completed = new Set<TaskId>(tasks.filter((t) => t.column === 'done').map((t) => t.id))

  const reclaimable: TaskId[] = []
  let runningGlobal = 0
  const runningPerRepo = new Map<string, number>()

  for (const task of tasks) {
    if (task.column !== 'running') continue
    if (isLeaseExpired(task, now)) {
      // 租约过期的 Run 视同已死，它占的名额要还回来，否则一次崩溃会永久
      // 吃掉一个并发位。
      reclaimable.push(task.id)
      continue
    }
    runningGlobal += 1
    runningPerRepo.set(task.repoPath, (runningPerRepo.get(task.repoPath) ?? 0) + 1)
  }

  const dispatches: Dispatch[] = []
  const skipped: Skip[] = []

  // 归档的卡直接排除，也不进 skipped —— skipped 是拿来回答"我看得见的卡
  // 为什么不动"的，而归档的卡本来就不在看板上，没有什么要解释。
  const candidates = tasks
    .filter((t) => t.column === 'ready' && t.archivedAt === undefined)
    .slice()
    .sort((a, b) => a.position - b.position)

  for (const task of candidates) {
    const unmet = task.blockedBy.filter((id) => !completed.has(id))
    if (unmet.length > 0) {
      skipped.push({ taskId: task.id, reason: 'blocked-by-dependency', detail: `依赖未完成: ${unmet.join(', ')}` })
      continue
    }

    const provider = pickProvider(task, availableProviders)
    if (provider === null) {
      skipped.push({
        taskId: task.id,
        reason: 'provider-unavailable',
        detail: task.preferredProvider === undefined
          ? '本机没有探测到任何可用的 Agent CLI'
          : `指定的 ${task.preferredProvider} 未探测到`,
      })
      continue
    }

    if (runningGlobal >= limits.maxConcurrent) {
      skipped.push({
        taskId: task.id,
        reason: 'global-limit-reached',
        detail: `全局并发已满 (${String(limits.maxConcurrent)})`,
      })
      continue
    }

    const repoRunning = runningPerRepo.get(task.repoPath) ?? 0
    if (repoRunning >= limits.maxPerRepo) {
      skipped.push({
        taskId: task.id,
        reason: 'repo-limit-reached',
        detail: `${task.repoPath} 并发已满 (${String(limits.maxPerRepo)})`,
      })
      continue
    }

    dispatches.push({ taskId: task.id, expectedRevision: task.revision, provider })
    runningGlobal += 1
    runningPerRepo.set(task.repoPath, repoRunning + 1)
  }

  return { dispatches, skipped, reclaimable }
}

/**
 * 有重叠写入范围的正在运行的任务，用于向人提示可能的合并冲突。
 *
 * 这是**建议性**的：Bash、格式化工具、代码生成器都能绕过它。
 * @param task - 待检查的任务。
 * @param tasks - 全部任务。
 * @returns 与之写入范围重叠、且正在运行的任务 id。
 */
export function overlappingWriteScopes(task: Task, tasks: readonly Task[]): TaskId[] {
  if (task.writeScopes.length === 0) return []
  const overlaps = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a)
  return tasks
    .filter((other) => other.id !== task.id
      && other.column === 'running'
      && other.repoPath === task.repoPath
      && other.writeScopes.some((s) => task.writeScopes.some((t) => overlaps(s, t))))
    .map((other) => other.id)
}
