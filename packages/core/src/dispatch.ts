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
  /**
   * **每个执行器**同时运行的上限。
   *
   * 不是全局上限：三个 CLI 各有各的额度与速率限制，claude 排满了不该顺带
   * 把 codex 也堵住。想开多大取决于你各家的账号能扛多少，不取决于这台机器
   * 有几个 CLI。
   */
  readonly maxPerProvider: number
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
  | 'provider-limit-reached'
  | 'repo-limit-reached'
  | 'provider-unavailable'

export interface Skip {
  readonly taskId: TaskId
  readonly reason: SkipReason
  /** 服务端自己的中文渲染，日志与 CLI 用。界面自己按 reason + params 组句。 */
  readonly detail: string
  /**
   * 句子里可变的那几段，按 reason 定序：
   * `blocked-by-dependency` 未完成的依赖；`provider-unavailable` 指定的执行器
   * （没指定就是空的）；两个 limit 则是 [谁, 上限]。
   *
   * 界面要用两种语言说同一句话，靠拆开 detail 去猜是行不通的。
   */
  readonly params: readonly string[]
}

export interface DispatchPlan {
  readonly dispatches: readonly Dispatch[]
  readonly skipped: readonly Skip[]
  /** 租约过期、应当被回收回 ready 的任务。 */
  readonly reclaimable: readonly TaskId[]
}

/**
 * 选一个可用的 provider。
 *
 * 指定了就必须用指定的。没指定时挑**当前跑得最少的那个** —— 上限是按执行器
 * 算的，总取第一个会让没指定的卡全堆在 claude 上排队，而 codex 闲着。
 * 打平时按 `available` 的顺序，结果因此是确定的（纯函数，可测）。
 */
function pickProvider(
  task: Task,
  available: readonly string[],
  running: ReadonlyMap<string, number>,
): string | null {
  if (task.preferredProvider !== undefined) {
    return available.includes(task.preferredProvider) ? task.preferredProvider : null
  }
  let best: string | null = null
  let least = Number.POSITIVE_INFINITY
  for (const provider of available) {
    const busy = running.get(provider) ?? 0
    if (busy < least) { best = provider; least = busy }
  }
  return best
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
  const runningPerProvider = new Map<string, number>()
  const runningPerRepo = new Map<string, number>()

  for (const task of tasks) {
    if (task.column !== 'running') continue
    if (isLeaseExpired(task, now)) {
      // 租约过期的 Run 视同已死，它占的名额要还回来，否则一次崩溃会永久
      // 吃掉一个并发位。
      reclaimable.push(task.id)
      continue
    }
    // 名额算在**租约上写着的那个 provider** 头上：那才是真正在跑的东西。
    const provider = task.lease?.provider
    if (provider !== undefined) {
      runningPerProvider.set(provider, (runningPerProvider.get(provider) ?? 0) + 1)
    }
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
      skipped.push({
        taskId: task.id,
        reason: 'blocked-by-dependency',
        detail: `依赖未完成: ${unmet.join(', ')}`,
        params: [unmet.join(', ')],
      })
      continue
    }

    const provider = pickProvider(task, availableProviders, runningPerProvider)
    if (provider === null) {
      skipped.push({
        taskId: task.id,
        reason: 'provider-unavailable',
        detail: task.preferredProvider === undefined
          ? '本机没有探测到任何可用的 Agent CLI'
          : `指定的 ${task.preferredProvider} 未探测到`,
        params: task.preferredProvider === undefined ? [] : [task.preferredProvider],
      })
      continue
    }

    const providerRunning = runningPerProvider.get(provider) ?? 0
    if (providerRunning >= limits.maxPerProvider) {
      skipped.push({
        taskId: task.id,
        reason: 'provider-limit-reached',
        detail: `${provider} 并发已满 (${String(limits.maxPerProvider)})`,
        params: [provider, String(limits.maxPerProvider)],
      })
      continue
    }

    const repoRunning = runningPerRepo.get(task.repoPath) ?? 0
    if (repoRunning >= limits.maxPerRepo) {
      skipped.push({
        taskId: task.id,
        reason: 'repo-limit-reached',
        detail: `${task.repoPath} 并发已满 (${String(limits.maxPerRepo)})`,
        params: [task.repoPath, String(limits.maxPerRepo)],
      })
      continue
    }

    dispatches.push({ taskId: task.id, expectedRevision: task.revision, provider })
    runningPerProvider.set(provider, providerRunning + 1)
    runningPerRepo.set(task.repoPath, repoRunning + 1)
  }

  return { dispatches, skipped, reclaimable }
}
