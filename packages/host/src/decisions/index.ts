/**
 * 决策中枢：一次执行里"等人拍板"的那条通道。
 *
 * 两件事在这里汇合：CLI 撞上权限要人放行（supervised 档），或者模型主动
 * 调 `ask_user` 向人提问。宿主把请求落库、推给界面，等人的答复原路返回 ——
 * 在答复到来之前，调用方（gate shim）一直阻塞着，Run 就停在那一步。
 *
 * 三条规则：
 *
 * - **先落库再广播**。与 runner.emit 同一条纪律：SSE 推出去的 seq 必须已经
 *   在存储里，断线重连才补得回来。
 * - **等待必须有界**。等人的请求带超时（默认十分钟），到点自动收场 ——
 *   权限按拒绝、提问按"未获回答"。否则一次没人理的提问就是一个永远停在
 *   Running 的卡。
 * - **gate 的凭据只对这一次执行有效**。Agent 的环境里只有它自己的 run
 *   token，只能创建/轮询自己这次的决策；宿主的全权 token 绝不进 Agent 的
 *   环境 —— 能不能干活该由人决定，不能由干活的人自己决定。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { asRunId, type RunId, type TaskId } from '@loopkanban/core'
import type { RunBus } from '../server/bus.ts'
import type { DecisionKind, DecisionStatus, RunDecision, Storage } from '../storage/index.ts'

/** 等人答复的超时。超过即自动收场；要远小于 Run 自身的超时才有意义。 */
export const DEFAULT_DECISION_TIMEOUT_MS = 10 * 60_000

/** 权限请求里"这个工具叫什么"的长度上限。正常名字到不了这儿，防的是滥用。 */
const TOOL_MAX = 200
/** 提问正文与选项的界限。问题是一段话，不是一篇文档。 */
const QUESTION_MAX = 4_000
const CHOICES_MAX = 10
const CHOICE_MAX = 200

/** 创建一条决策的入参（已由 server 路由按形状收窄到这里的程度）。 */
export interface DecisionInput {
  readonly kind: DecisionKind
  readonly payload: unknown
}

/** 人（或超时、或执行收场）给一条决策的答复。 */
export interface DecisionResolution {
  readonly status: Exclude<DecisionStatus, 'pending'>
  readonly answer?: unknown
}

/** 输入不成立。回给 shim 的是 422，CLI 那头会把它当成一次失败的工具调用。 */
export class DecisionInputError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DecisionInputError'
  }
}

/** 校验并归一化权限请求的负载。 */
function permissionPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    throw new DecisionInputError('权限请求缺少 payload')
  }
  const raw = payload as Record<string, unknown>
  const tool = raw['tool']
  if (typeof tool !== 'string' || tool.trim().length === 0) {
    throw new DecisionInputError('权限请求缺少 tool（请求放行哪个工具）')
  }
  if (tool.length > TOOL_MAX) throw new DecisionInputError('tool 名过长')
  // input 原样带走：界面上要显示"它想对这个工具传什么参数"，放行时也要
  // 把原参数原样还回去（updatedInput），我们不解释工具的参数形状。
  const input = raw['input'] === undefined ? {} : raw['input']
  return { tool, input }
}

/** 校验并归一化提问的负载。 */
function questionPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    throw new DecisionInputError('提问缺少 payload')
  }
  const raw = payload as Record<string, unknown>
  const question = raw['question']
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new DecisionInputError('提问缺少 question')
  }
  if (question.length > QUESTION_MAX) throw new DecisionInputError('问题过长')
  const choices = raw['choices']
  if (choices === undefined) return { question }
  if (!Array.isArray(choices)
    || choices.length > CHOICES_MAX
    || choices.some((choice) => typeof choice !== 'string' || choice.length === 0 || choice.length > CHOICE_MAX)) {
    throw new DecisionInputError(`choices 要给不超过 ${String(CHOICES_MAX)} 条、每条 ${String(CHOICE_MAX)} 字以内的字符串`)
  }
  return { question, choices }
}

export interface DecisionHubOptions {
  readonly storage: Storage
  readonly bus: RunBus
  readonly timeoutMs?: number
  readonly now?: () => number
}

export class DecisionHub {
  private readonly storage: Storage
  private readonly bus: RunBus
  private readonly timeoutMs: number
  private readonly now: () => number
  /** 等待超时的定时器，resolve 时收掉。 */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** 只对一次执行有效的限权 token → runId。 */
  private readonly tokens = new Map<string, RunId>()
  /** 用户选了"本次执行内总是允许"的工具名，按 run 记忆。进程重启即忘 —— 那是新的一轮，重新问一遍并不过分。 */
  private readonly autoAllow = new Map<RunId, Set<string>>()

  constructor(options: DecisionHubOptions) {
    this.storage = options.storage
    this.bus = options.bus
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  /**
   * 给一次执行签发 gate token。token 只能创建/轮询这个 run 的决策。
   * @param runId - 归属的 Run。
   */
  issueToken(runId: RunId): string {
    const token = randomBytes(24).toString('base64url')
    this.tokens.set(token, runId)
    return token
  }

  /** 一个 bearer token 属于哪次执行；不是 gate token 就返回 null。 */
  runIdForToken(token: string): RunId | null {
    return this.tokens.get(token) ?? null
  }

  /**
   * 创建一条决策。权限请求先过一遍"本次执行内总是允许"的记忆，命中就
   * 不打扰人 —— 但**照样落库与广播**：事后要能查到"它放行过什么"，
   * 界面上也要有一行"按你的记忆放行了"。
   *
   * @throws DecisionInputError 负载不成立时。
   */
  create(runId: RunId, input: DecisionInput): RunDecision {
    if (input.kind === 'permission') {
      const payload = permissionPayload(input.payload)
      const tool = (payload as { tool: string }).tool
      if (this.autoAllow.get(runId)?.has(tool) === true) {
        // 命中"本次执行内总是允许"：直接以终态落库，不打扰人 —— 但照样
        // 广播，界面上要有一行"按你的记忆放行了"，事后也查得到。
        const decision: RunDecision = {
          id: `dec-${randomUUID().slice(0, 8)}`,
          runId,
          kind: 'permission',
          payload,
          status: 'allowed',
          answer: { decision: 'allow', scope: 'run', auto: true, message: '按你此前的选择，本次执行内对该工具自动放行' },
          createdAt: this.now(),
          resolvedAt: this.now(),
        }
        this.storage.createDecision(decision)
        this.emit(runId, 'decision_resolved', decision)
        return decision
      }
      return this.open(runId, 'permission', payload)
    }
    return this.open(runId, 'question', questionPayload(input.payload))
  }

  /** 一个 Run 还在等的决策数。runner 的超时顺延靠它判断"是不是在等人"。 */
  pendingCount(runId: RunId): number {
    return this.storage.listDecisions(runId).filter((decision) => decision.status === 'pending').length
  }

  /** 全部还在等的决策，带所属任务 —— 看板徽标的数据源。 */
  pendingByTask(): Map<TaskId, RunDecision[]> {
    const byTask = new Map<TaskId, RunDecision[]>()
    for (const pending of this.storage.listPendingDecisions()) {
      const list = byTask.get(pending.taskId) ?? []
      list.push(pending)
      byTask.set(pending.taskId, list)
    }
    return byTask
  }

  get(runId: RunId, id: string): RunDecision | null {
    const decision = this.storage.getDecision(id)
    return decision !== null && decision.runId === runId ? decision : null
  }

  /** 一个 Run 的全部决策，时间正序。 */
  list(runId: RunId): RunDecision[] {
    return this.storage.listDecisions(runId)
  }

  /**
   * 人拍板。**只有 pending 能被 resolve**：并发点两次、或对已超时的决策
   * 补点一下，都只会得到 null，调用方回 409。
   *
   * @param runId - 归属的 Run（必须与决策一致，防串台）。
   * @param id - 决策 id。
   * @param resolution - 新状态与答复。
   * @param scope - 权限放行时的记忆范围；'run' 表示本次执行内对该工具不再问。
   */
  resolve(runId: RunId, id: string, resolution: DecisionResolution, scope: 'once' | 'run' = 'once'): RunDecision | null {
    const decision = this.get(runId, id)
    if (decision === null || decision.status !== 'pending') return null
    // 权限的终态只能是 allowed/denied；提问的只能是 answered。超时与取消
    // 是系统自己收场的两条路，不走这里。
    if (decision.kind === 'permission' && resolution.status !== 'allowed' && resolution.status !== 'denied') {
      return null
    }
    if (decision.kind === 'question' && resolution.status !== 'answered') return null

    const settled = this.settle(runId, {
      ...decision,
      status: resolution.status,
      answer: resolution.answer,
      resolvedAt: this.now(),
    })
    if (settled === null) return null
    // "本次执行内总是允许"：记下工具名。下一次同工具的请求不再打扰人。
    if (decision.kind === 'permission' && resolution.status === 'allowed'
      && scope === 'run' && typeof (decision.payload as Record<string, unknown>)?.['tool'] === 'string') {
      const tool = (decision.payload as { tool: string }).tool
      const rules = this.autoAllow.get(runId) ?? new Set<string>()
      rules.add(tool)
      this.autoAllow.set(runId, rules)
    }
    return settled
  }

  /**
   * 一次执行结束时收掉所有还悬着的决策。
   * @returns 收掉的条数。
   */
  expireRun(runId: RunId, status: Extract<DecisionStatus, 'timeout' | 'cancelled'>): number {
    let expired = 0
    for (const decision of this.storage.listDecisions(runId)) {
      if (decision.status !== 'pending') continue
      const answer = decision.kind === 'permission'
        ? { decision: 'deny', message: status === 'timeout' ? '等待超时，已自动拒绝' : '执行已终止' }
        : { text: status === 'timeout'
            ? '（超时未获回答。请基于现有信息继续，明确说出你的假设，不要再等）'
            : '（执行已终止，没有人回答这个问题）', by: status }
      const settled = this.settle(runId, { ...decision, status, answer, resolvedAt: this.now() })
      if (settled !== null) expired += 1
    }
    return expired
  }

  /** 执行结束后撤销它的 gate token 与记忆。 */
  revokeRun(runId: RunId): void {
    for (const [token, owner] of this.tokens) {
      if (owner === runId) this.tokens.delete(token)
    }
    this.autoAllow.delete(runId)
  }

  /** 收掉全部定时器。进程正常退出路径上调用；Node 退出时它们本来也不会拦住进程。 */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** 落库 + 广播 + 挂超时。等待中的每一条都有一个到点的收场。 */
  private open(runId: RunId, kind: DecisionKind, payload: unknown): RunDecision {
    const decision: RunDecision = {
      id: `dec-${randomUUID().slice(0, 8)}`,
      runId,
      kind,
      payload,
      status: 'pending',
      createdAt: this.now(),
    }
    this.storage.createDecision(decision)
    this.emit(runId, 'decision', decision)
    const timer = setTimeout(() => {
      this.timers.delete(decision.id)
      this.expireRun(runId, 'timeout')
    }, this.timeoutMs)
    // 不该因为有人在等答案而阻止进程退出 —— 有 Run 在跑时反正有别的引用。
    timer.unref?.()
    this.timers.set(decision.id, timer)
    return decision
  }

  /** 把 pending 写成终态 + 广播 + 收掉定时器。终态写入失败（已被并发收场）时返回 null。 */
  private settle(runId: RunId, decision: RunDecision): RunDecision | null {
    const ok = this.storage.resolveDecision(
      decision.id, decision.status, decision.answer, decision.resolvedAt ?? this.now(),
    )
    if (!ok) return null
    const timer = this.timers.get(decision.id)
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(decision.id) }
    this.emit(runId, 'decision_resolved', { ...decision })
    return { ...decision }
  }

  /** 与 runner.emit 同一条纪律：先落库再广播；一条事件失败不拖垮执行。 */
  private emit(runId: RunId, kind: string, payload: unknown): void {
    try {
      const seq = this.storage.appendEvent(asRunId(runId), kind, payload, this.now())
      this.bus.publish({ runId, seq, kind, payload, at: this.now() })
    } catch (error) {
      console.error(`[loopkanban] 决策事件落库失败 run=${runId} kind=${kind}:`, error)
    }
  }
}
