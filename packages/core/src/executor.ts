/**
 * 执行器：一个**起了名字**的「哪个 CLI + 哪个模型」。
 *
 * 在这之前，"交给谁干"是卡片上的两个字段（preferredProvider + model），
 * 每张卡各填一遍，而且填的是 `claude` / `claude-opus-4-6-20260101` 这种
 * 只有机器认得的字符串。人脑子里想的其实是"这活儿交给大壮"——
 * 一个稳定的、有名字的干活的人，而不是每次现攒一次配置。
 *
 * 于是把它提出来成为一等公民：
 *
 * - 建一次，处处引用。改了大壮用的模型，往后所有交给大壮的活都跟着变。
 * - 有**默认执行器**。不指定就是它 —— 包括看板右侧那块聊天，人一进来
 *   就能直接说话，不必先做一次配置。
 * - 在对话里 `@大壮` 就是"这轮交给大壮"。这比一个下拉框更贴近人本来的说法，
 *   而且它和那句话是同一条消息，不会出现"改了下拉却忘了发言"。
 *
 * 这一层只有**纯规则**：名字合不合法、一段话里点了谁的名。存哪儿、怎么派活
 * 是宿主的事。
 */

import type { TaskId } from './ids.ts'

declare const brand: unique symbol
export type ExecutorId = string & { readonly [brand]: 'ExecutorId' }
export const asExecutorId = (value: string): ExecutorId => value as ExecutorId

export interface Executor {
  readonly id: ExecutorId
  /** 人给它起的名字，例如「大壮」。全局唯一（不分大小写），也是 `@` 的那个词。 */
  readonly name: string
  /** 哪个 CLI，例如 `claude`。 */
  readonly provider: string
  /** 哪个模型。留空表示用那个 CLI 自己的默认 —— 我们不替它做主。 */
  readonly model?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** 名字的长度上限。再长的名字在卡面、聊天气泡、@ 补全里都摆不下。 */
export const EXECUTOR_NAME_MAX = 24

/**
 * 名字里不许出现的东西。
 *
 * 空白、`@`、`#` 是**功能性**的禁止，不是洁癖：`@` 后面跟到哪儿算完全靠
 * 这条规则 —— 名字里能有空格的话，「@大壮 帮我看看」到底点的是"大壮"还是
 * "大壮 帮我看看"就没有答案了；`#` 是任务引用的开头，同理。
 */
const ILLEGAL = /[\s@#]/u

export type NameProblem = 'empty' | 'too-long' | 'illegal-chars' | 'duplicate'

/**
 * 校验一个执行器名。
 * @param raw - 用户输入的名字。
 * @param taken - 已经存在的名字（大小写不敏感地比对）。
 * @returns 合法时给出规范化后的名字，否则给出问题。
 */
export function checkExecutorName(
  raw: string, taken: readonly string[] = [],
): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: NameProblem } {
  const name = raw.trim()
  if (name.length === 0) return { ok: false, problem: 'empty' }
  if (name.length > EXECUTOR_NAME_MAX) return { ok: false, problem: 'too-long' }
  if (ILLEGAL.test(name)) return { ok: false, problem: 'illegal-chars' }
  const folded = name.toLowerCase()
  if (taken.some((other) => other.trim().toLowerCase() === folded)) {
    return { ok: false, problem: 'duplicate' }
  }
  return { ok: true, name }
}

/** 按名字找执行器，大小写不敏感 —— 人打字时不会去记大小写。 */
export function executorByName(
  executors: readonly Executor[], name: string,
): Executor | undefined {
  const folded = name.trim().toLowerCase()
  return executors.find((executor) => executor.name.toLowerCase() === folded)
}

/**
 * 一段话里点了哪些执行器的名。
 *
 * **拿已知的名字去文本里找，而不是拿正则去猜一个名字**。名字可以是中文、
 * 可以带连字符，猜的那条路要么把「@大壮，帮我」连标点一起吃掉，要么得
 * 维护一张"名字里允许哪些字符"的表 —— 而那张表迟早和真实的名字对不上。
 *
 * 长名字优先：同时存在「壮」和「大壮」时，`@大壮` 点的是后者。
 *
 * @param text - 用户写的那段话。
 * @param executors - 现有的全部执行器。
 * @returns 被点到的执行器，按名字长度从长到短去重后、按在文中首次出现的先后排。
 */
export function mentionedExecutors(
  text: string, executors: readonly Executor[],
): readonly Executor[] {
  const found: { executor: Executor; at: number }[] = []
  const byLength = [...executors].sort((a, b) => b.name.length - a.name.length)
  // 已经被更长的名字吃掉的位置不再算数：`@大壮` 命中"大壮"之后，"壮"不该
  // 在同一处再命中一次。
  const consumed = new Set<number>()
  const haystack = text.toLowerCase()
  for (const executor of byLength) {
    const needle = `@${executor.name.toLowerCase()}`
    let at = haystack.indexOf(needle)
    while (at >= 0) {
      if (!consumed.has(at)) {
        for (let i = at; i < at + needle.length; i += 1) consumed.add(i)
        found.push({ executor, at })
        break
      }
      at = haystack.indexOf(needle, at + 1)
    }
  }
  return found.sort((a, b) => a.at - b.at).map((hit) => hit.executor)
}

/**
 * 一段话里引用了哪些卡片：`#t-1a2b3c4d`。
 *
 * 引用的目的是"干这件事之前先看看那张卡"——落到卡上就是 `relatedTo`，
 * 派活时那张卡的内容会被展开写进规格里（见 host 的 renderTaskSpec）。
 * 所以人在输入框里打一个 `#`，和去配置页里勾一个关联，是同一件事的两种说法。
 *
 * @param text - 用户写的那段话。
 * @returns 去重后的任务 id，按出现先后。
 */
export function referencedTasks(text: string): readonly TaskId[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(/#(t-[0-9a-z-]{2,24})/giu)) {
    const id = match[1]
    if (id !== undefined) seen.add(id.toLowerCase())
  }
  return [...seen] as TaskId[]
}
