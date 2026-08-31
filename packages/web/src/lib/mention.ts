/**
 * 输入框里的两种"点名"：`@执行器` 与 `#任务id`。
 *
 * 真正生效的解析在服务端（见 core 的 executor.ts）—— 界面这一份是为了**当场
 * 告诉人他刚写下的这句话会怎么被理解**：底下那行"这一轮交给大壮"要跟着字
 * 一起变，才有意义。两份规则必须一致，所以这里照抄同一套做法：拿已知的名字
 * 去文本里找，而不是拿正则去猜一个名字。
 *
 * 前端不依赖后端包（见 types.ts 那句），这份重复是那条边界的代价，
 * 也正因如此它必须短到一眼能对完。
 */

import type { Executor } from '@/types.ts'

/**
 * 这段话点了谁的名。长名字优先 —— 同时有「壮」和「大壮」时，`@大壮` 是后者。
 * @returns 第一个被点到的执行器；没点名时 undefined。
 */
export function mentioned(text: string, executors: readonly Executor[]): Executor | undefined {
  const haystack = text.toLowerCase()
  let best: { executor: Executor; at: number } | undefined
  for (const executor of [...executors].sort((a, b) => b.name.length - a.name.length)) {
    const at = haystack.indexOf(`@${executor.name.toLowerCase()}`)
    if (at < 0) continue
    // 同一段话里点了两个人时，以**先出现**的那个为准 —— 服务端也是这么定的。
    if (best === undefined || at < best.at) best = { executor, at }
  }
  return best?.executor
}

/** 这段话引用了哪些卡片：`#t-1a2b3c4d`。去重，按出现先后。 */
export function referenced(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(/#(t-[0-9a-z-]{2,24})/giu)) {
    const id = match[1]
    if (id !== undefined) seen.add(id.toLowerCase())
  }
  return [...seen]
}
