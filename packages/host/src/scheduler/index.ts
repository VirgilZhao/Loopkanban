/**
 * 自动认领调度器 —— 本项目的核心卖点。
 *
 * 决策本身是 `@loopkanban/core` 里的纯函数 `planDispatch`：不读数据库、
 * 不起进程、不看时钟。这里只负责把决策接到副作用上，以及按节拍反复执行。
 * 这样"并发上限、依赖阻塞、租约回收、provider 不可用"这些分支能用普通单测
 * 覆盖，不必真的去起十个 Agent。
 *
 * 两条硬要求：
 *
 * - **不做静默截断**。每一轮的跳过原因都留在 {@link SchedulerState.lastTick}
 *   里给界面读。用户问"我的卡为什么不动"，界面必须答得上来。
 * - **每轮先回收再派发**。崩溃的 Run 占着的并发名额要先还回来，否则一次崩溃
 *   会永久吃掉一个位子，跑几天之后调度器会莫名其妙地停摆。
 */

import { planDispatch, type Dispatch, type Skip, type TaskId } from '@loopkanban/core'
import type { AgentPool } from '../agents/index.ts'
import type { Runner } from '../runner/index.ts'
import type { Storage } from '../storage/index.ts'

/** 调度节拍。太快只是空转，太慢会让"扔进 Ready 就开跑"变得迟钝。 */
export const DEFAULT_TICK_MS = 3_000

export interface SchedulerSettings {
  /** 自动认领总开关。默认关 —— 让 Agent 无人值守动代码，得由人明确点头。 */
  readonly autopilot: boolean
  /** 每个执行器的并发上限 —— 不是全局上限。 */
  readonly maxPerProvider: number
  readonly maxPerRepo: number
}

export const DEFAULT_SETTINGS: SchedulerSettings = {
  autopilot: false,
  maxPerProvider: 50,
  maxPerRepo: 20,
}

export interface TickReport {
  readonly at: number
  readonly enabled: boolean
  readonly dispatched: readonly { taskId: TaskId; provider: string; runId?: string; error?: string }[]
  readonly skipped: readonly Skip[]
  readonly reclaimed: readonly TaskId[]
}

export interface SchedulerState {
  readonly settings: SchedulerSettings
  readonly lastTick: TickReport | null
}

export interface SchedulerOptions {
  readonly storage: Storage
  readonly runner: Runner
  /** 本机可用的执行器。是活视图不是快照 —— 刷新之后这里立刻跟着变。 */
  readonly agents: AgentPool
  readonly tickMs?: number
  readonly now?: () => number
}

export class Scheduler {
  private readonly options: SchedulerOptions
  private timer: NodeJS.Timeout | undefined
  /** 进行中的那一轮。新的 tick() 排在它后面，保证不会两轮并行。 */
  private inFlight: Promise<TickReport> | undefined
  private lastTick: TickReport | null = null

  constructor(options: SchedulerOptions) {
    this.options = options
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * 当前设置，从存储读，进程重启后保持。
   *
   * 并发上限从"全局"改成"每个执行器"时字段名跟着换了；旧库里存的是
   * `maxConcurrent`，照原值搬过来 —— 用户设过的数字不该因为我们改了名字
   * 就悄悄回到默认值。
   */
  get settings(): SchedulerSettings {
    const stored = this.options.storage.getSetting<Partial<SchedulerSettings> & { maxConcurrent?: number }>(
      'scheduler',
      DEFAULT_SETTINGS,
    )
    return {
      autopilot: stored.autopilot ?? DEFAULT_SETTINGS.autopilot,
      maxPerProvider: stored.maxPerProvider ?? stored.maxConcurrent ?? DEFAULT_SETTINGS.maxPerProvider,
      maxPerRepo: stored.maxPerRepo ?? DEFAULT_SETTINGS.maxPerRepo,
    }
  }

  /**
   * 更新设置。只接受合法值 —— 把并发上限设成 0 或负数会让调度器静悄悄地
   * 什么都不做，那比报错更难查。
   * @param patch - 要改的字段。
   */
  updateSettings(patch: Partial<SchedulerSettings>): SchedulerSettings {
    const current = this.settings
    const next: SchedulerSettings = {
      autopilot: patch.autopilot ?? current.autopilot,
      maxPerProvider: clampLimit(patch.maxPerProvider ?? current.maxPerProvider),
      maxPerRepo: clampLimit(patch.maxPerRepo ?? current.maxPerRepo),
    }
    this.options.storage.setSetting('scheduler', next)
    return next
  }

  state(): SchedulerState {
    return { settings: this.settings, lastTick: this.lastTick }
  }

  /** 起节拍。重复调用无副作用。 */
  start(): void {
    if (this.timer !== undefined) return
    const timer = setInterval(() => { void this.tickIfIdle() }, this.options.tickMs ?? DEFAULT_TICK_MS)
    // 调度器不该拖住进程退出。
    timer.unref()
    this.timer = timer
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * 跑一轮，并保证拿到的是**这次调用**的结果。
   *
   * 有轮次在跑时排队等它结束再跑自己的，而不是返回上一轮的报告 ——
   * 调用方（改完设置的那个 PATCH）要的正是新设置下的结果，给它一份陈旧报告
   * 会让界面显示"没有任何跳过原因"，而那恰恰是用户最想立刻看到反馈的时刻。
   *
   * 即使自动认领关着也会执行**回收** —— 崩溃留下的卡片必须回到 Ready，
   * 这跟用不用自动驾驶无关。
   *
   * @returns 这一轮做了什么，供界面解释"为什么我的卡还没动"。
   */
  async tick(): Promise<TickReport> {
    const previous = this.inFlight
    // 无论上一轮成功还是失败，都接着往下跑。
    const mine = (previous === undefined ? Promise.resolve() : previous.then(noop, noop))
      .then(() => this.runTick())
    this.inFlight = mine
    try {
      return await mine
    } finally {
      if (this.inFlight === mine) this.inFlight = undefined
    }
  }

  /**
   * 节拍专用：有轮次在跑就跳过这一拍。
   *
   * 定时器不该排队 —— 一轮跑得慢的话，排起来的拍子会在它结束后连着放炮。
   * @returns 这一轮的报告；被跳过时返回 null。
   */
  async tickIfIdle(): Promise<TickReport | null> {
    if (this.inFlight !== undefined) return null
    return this.tick()
  }

  private async runTick(): Promise<TickReport> {
    const { storage, runner } = this.options
    // 每一轮都重新读，这样刷新过的探测结果下一拍就生效。
    const agents = this.options.agents.list()
    const settings = this.settings

    const reclaimed = runner.reclaimExpired()

    if (!settings.autopilot) {
      const report: TickReport = {
        at: this.now, enabled: false, dispatched: [], skipped: [], reclaimed,
      }
      this.lastTick = report
      return report
    }

    const plan = planDispatch({
      tasks: storage.listTasks(),
      availableProviders: agents.map((a) => a.provider.id),
      limits: { maxPerProvider: settings.maxPerProvider, maxPerRepo: settings.maxPerRepo },
      now: this.now,
    })

    const dispatched = await this.launchAll(plan.dispatches)
    const report: TickReport = {
      at: this.now,
      enabled: true,
      dispatched,
      skipped: plan.skipped,
      reclaimed: [...reclaimed, ...plan.reclaimable],
    }
    this.lastTick = report
    return report
  }

  /** 逐个派发。一个失败不影响其余 —— 半张看板卡住比全卡住更难查。 */
  private async launchAll(dispatches: readonly Dispatch[]): Promise<TickReport['dispatched']> {
    const results: TickReport['dispatched'][number][] = []
    for (const dispatch of dispatches) {
      const started = await this.options.runner.start(dispatch.taskId, dispatch.provider)
      results.push(started.ok
        ? { taskId: dispatch.taskId, provider: dispatch.provider, runId: started.run.id }
        : { taskId: dispatch.taskId, provider: dispatch.provider, error: `${started.reason}: ${started.detail}` })
    }
    return results
  }
}

function noop(): void { /* 上一轮的成败不影响这一轮是否要跑 */ }

/** 并发上限至少为 1：0 或负数会让调度器静悄悄地什么都不做。 */
function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}
