/**
 * 执行器在宿主这一侧：怎么存、谁是默认的、一张卡到底归谁跑。
 *
 * 领域层（`@loopkanban/core` 的 executor.ts）只管纯规则 —— 名字合不合法、
 * 一段话里点了谁的名。这里管的是与库和探测结果打交道的那半边：
 *
 * - **默认执行器**是一条设置，不是表上的一列。做成列的话，"有且只有一个
 *   默认"就得靠每次写入时把别人清掉来维持，而那是个迟早会漏的不变式；
 *   记成一个 id，天然只有一个。
 * - **解析成 provider + model** 只发生在派活那一刻。执行器改了模型，正在
 *   排队的卡下一轮就用新的 —— 建卡时把值拷进卡里的话，改执行器就只对
 *   之后新建的卡生效，那不是人期望的"改了大壮用的模型"。
 */

import { randomUUID } from 'node:crypto'
import {
  asExecutorId, checkExecutorName, type Executor, type ExecutorId, type Task, type TaskId,
} from '@loopkanban/core'
import type { DetectedAgent } from '../agents/index.ts'
import type { Storage } from '../storage/index.ts'

/** 默认执行器记在这条设置里。 */
const DEFAULT_KEY = 'defaultExecutor'

/**
 * 派活时真正要用的那两样。
 *
 * `provider` 可以没有：一个执行器都没建、卡上也没指定时就是这样，此时由
 * 调度器按"当前跑得最少的那个"挑 —— 那是执行器出现之前的行为，留着它，
 * 是为了让一台刚探测完 CLI 的机器不至于因为"还没建执行器"而完全派不出活。
 */
export interface Binding {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/**
 * 当前的默认执行器。
 *
 * 设置里那个不存在了（被删掉、库被手动动过）就退回第一个 —— 有执行器却
 * 说"没有默认执行器"，会让聊天和所有没指定的卡一起停摆，而这只是一条
 * 悬空的设置。
 *
 * @returns 默认执行器；一个都没有时返回 null。
 */
export function defaultExecutor(storage: Storage): Executor | null {
  return pickDefault(storage, storage.listExecutors())
}

/** {@link defaultExecutor} 的内核，给已经把名单读在手上的调用方省一次查询。 */
function pickDefault(storage: Storage, executors: readonly Executor[]): Executor | null {
  if (executors.length === 0) return null
  const pinned = storage.getSetting<string | null>(DEFAULT_KEY, null)
  const found = pinned === null ? undefined : executors.find((executor) => executor.id === pinned)
  return found ?? executors[0] ?? null
}

/** 指定默认执行器。id 不存在时不动 —— 悬空的设置只会在别处变成怪事。 */
export function setDefaultExecutor(storage: Storage, id: ExecutorId): boolean {
  if (storage.getExecutor(id) === null) return false
  storage.setSetting(DEFAULT_KEY, String(id))
  return true
}

/** 这张卡这一轮的两件事：记在卡上的负责人，以及真正要起的那个 CLI + 模型。 */
export interface Assignment {
  /**
   * 该被写到卡上的执行器（`null` 表示这次不认领）。
   *
   * 卡上钉了 CLI 的那种**不认领** —— 那是一次明确的选择，写上一个默认执行器
   * 会在下一轮反过来把它盖掉（executorId 的优先级更高）。
   */
  readonly executor: Executor | null
  readonly binding: Binding
}

/**
 * 这张卡这一轮交给谁、用什么跑。
 *
 * 三档，**明确的压过默认的**：
 *
 * 1. 卡上钉了执行器 —— 界面上唯一的说法，`@` 换人写的也是它。
 * 2. 卡上钉了 CLI（`preferredProvider`）—— 执行器出现之前的说法，MCP 那条
 *    口子至今还在用它。它是一次**明确的选择**，所以必须压过默认执行器；
 *    反过来的话，「我指名要 codex 跑」会被一个我根本没设过的默认值悄悄改掉。
 * 3. 默认执行器 —— 什么都没说时的那位。
 *
 * 一次读完库就把两个答案一起给出来：分成两次查的话，中间库要是变了，
 * 写到卡上的那位和真正起的那个 CLI 会来自不同的一行。
 */
export function assignmentFor(storage: Storage, task: Task): Assignment {
  const executors = storage.listExecutors()
  const pinned = task.executorId === undefined
    ? undefined
    : executors.find((executor) => String(executor.id) === String(task.executorId))
  if (pinned !== undefined) return { executor: pinned, binding: bindingOf(pinned) }

  if (task.preferredProvider !== undefined) {
    return {
      executor: null,
      binding: {
        provider: task.preferredProvider,
        ...(task.model === undefined ? {} : { model: task.model }),
      },
    }
  }

  const fallback = pickDefault(storage, executors)
  if (fallback !== null) return { executor: fallback, binding: bindingOf(fallback) }
  return { executor: null, binding: { ...(task.model === undefined ? {} : { model: task.model }) } }
}

/** 派活时要用的 provider 与 model。{@link assignmentFor} 的一半。 */
export function bindingFor(storage: Storage, task: Task): Binding {
  return assignmentFor(storage, task).binding
}

const bindingOf = (executor: Executor): Binding =>
  ({ provider: executor.provider, ...(executor.model === undefined ? {} : { model: executor.model }) })

/**
 * 一批卡各归哪个 CLI 跑，交给 `planDispatch` 的 `pinned`。
 *
 * 只放**解析得出**的那些：一个执行器都没有时这张表是空的，调度回到从前
 * "挑当前跑得最少的那个"的样子。
 */
export function providerPins(storage: Storage, tasks: readonly Task[]): ReadonlyMap<TaskId, string> {
  const executors = storage.listExecutors()
  const fallback = pickDefault(storage, executors)
  // 一个执行器都没有：不钉任何卡，调度回到"挑当前跑得最少的那个"（卡上的
  // preferredProvider 由 planDispatch 自己看，不必在这儿重复一遍）。
  if (fallback === null) return new Map()
  const byId = new Map(executors.map((executor) => [String(executor.id), executor]))
  const pins = new Map<TaskId, string>()
  for (const task of tasks) {
    const pinned = task.executorId === undefined ? undefined : byId.get(String(task.executorId))
    // 与 bindingFor 同一套优先级：钉了执行器 → 钉了 CLI → 默认执行器。
    // 这里**不放**第二档：`pinned` 会盖过 planDispatch 看到的 preferredProvider，
    // 而那两者本该是同一个答案 —— 少写一次就少一处会对不上的地方。
    if (pinned !== undefined) pins.set(task.id, pinned.provider)
    else if (task.preferredProvider === undefined) pins.set(task.id, fallback.provider)
  }
  return pins
}

export type CreateProblem =
  | 'empty' | 'too-long' | 'illegal-chars' | 'duplicate' | 'unknown-provider'
  /** 要改的那个执行器不在了。只有改的那条路会遇到。 */
  | 'not-found'

export interface CreateInput {
  readonly name: string
  readonly provider: string
  readonly model?: string | undefined
}

/**
 * 建一个执行器。
 *
 * provider 必须是**本机探测得到**的那几个之一：手打一个 CLI 不认的名字，
 * 只会在派活那一刻才炸，而那时人早就不在这个页面了。
 *
 * @param known - 本机探测到的 provider id。
 * @returns 建出来的执行器，或明确的问题。
 */
export function createExecutor(
  storage: Storage, input: CreateInput, known: readonly string[], now = Date.now(),
): { readonly ok: true; readonly executor: Executor } | { readonly ok: false; readonly problem: CreateProblem } {
  const checked = checkExecutorName(input.name, storage.listExecutors().map((executor) => executor.name))
  if (!checked.ok) return { ok: false, problem: checked.problem }
  if (!known.includes(input.provider)) return { ok: false, problem: 'unknown-provider' }

  const model = input.model?.trim()
  const executor: Executor = {
    id: asExecutorId(`e-${randomUUID().slice(0, 8)}`),
    name: checked.name,
    provider: input.provider,
    ...(model === undefined || model.length === 0 ? {} : { model }),
    createdAt: now,
    updatedAt: now,
  }
  storage.createExecutor(executor)
  // 第一个建出来的自然就是默认的 —— 建完还要再点一下"设为默认"，只是
  // 一道没有意义的手续。
  if (storage.getSetting<string | null>(DEFAULT_KEY, null) === null) {
    storage.setSetting(DEFAULT_KEY, String(executor.id))
  }
  return { ok: true, executor }
}

/**
 * 改一个执行器。字段缺席表示"这次没提到"。
 * @param known - 本机探测到的 provider id。
 */
export function updateExecutor(
  storage: Storage, id: ExecutorId, patch: Partial<CreateInput>, known: readonly string[], now = Date.now(),
): { readonly ok: true; readonly executor: Executor } | { readonly ok: false; readonly problem: CreateProblem } {
  const current = storage.getExecutor(id)
  if (current === null) return { ok: false, problem: 'not-found' }

  let name = current.name
  if (patch.name !== undefined) {
    const taken = storage.listExecutors()
      .filter((other) => other.id !== id)
      .map((other) => other.name)
    const checked = checkExecutorName(patch.name, taken)
    if (!checked.ok) return { ok: false, problem: checked.problem }
    name = checked.name
  }
  const provider = patch.provider ?? current.provider
  if (!known.includes(provider)) return { ok: false, problem: 'unknown-provider' }

  // 模型给空串就是"用这个 CLI 自己的默认"，与从没填过等价。
  const model = patch.model === undefined ? current.model : (patch.model.trim() || undefined)
  const next: Executor = {
    ...current,
    name,
    provider,
    ...(model === undefined ? { model: undefined } : { model }),
    updatedAt: now,
  }
  storage.updateExecutor(next)
  return { ok: true, executor: next }
}

/**
 * 库里一个执行器都没有时，照本机探测到的 CLI 各建一个。
 *
 * 为什么要有这一步：默认执行器是聊天与派活的前提，而"先去建一个执行器"
 * 对一个刚装好的看板来说是一道空手的门槛 —— 机器上装了什么是已知的事实，
 * 拿它兜个底，人一进来就能直接说话。名字就用 CLI 自己的 id：那是他此刻
 * 唯一认得的称呼，改名随时可以。
 *
 * **只在一个都没有时做**。删光了执行器是一个明确的选择，不该被下一次启动
 * 悄悄撤销。
 *
 * @returns 这一次建出来的执行器（没建就是空数组）。
 */
export function seedExecutors(
  storage: Storage, agents: readonly DetectedAgent[], now = Date.now(),
): readonly Executor[] {
  if (storage.listExecutors().length > 0) return []
  const made: Executor[] = []
  for (const agent of agents) {
    const result = createExecutor(storage, { name: agent.provider.id, provider: agent.provider.id }, [agent.provider.id], now)
    if (result.ok) made.push(result.executor)
  }
  return made
}
