/**
 * 从 CLI 的 `--help` 输出里解析出「有哪些参数、参数的候选值是什么」。
 *
 * 为什么不按版本号判断：我们不绑定 CLI 版本，用户装的是什么版本就用什么版本。
 * 版本号到能力的映射表会立刻过期，而 `--help` 是 CLI 自己吐出的当前事实。
 *
 * 支持三种候选值写法：
 *   - commander 风格（claude）：`(choices: "acceptEdits", "auto", ...)`
 *   - clap 风格（codex）：`[possible values: read-only, workspace-write, ...]`
 *   - yargs 风格（opencode）：`[choices: "default", "json"]`
 */

/** 一次 help 解析的结果。 */
export interface HelpSurface {
  /** help 里出现过的所有长参数名（不含 `--` 前缀）。 */
  readonly flags: ReadonlySet<string>
  /** 长参数名 → 候选值列表。 */
  readonly choices: ReadonlyMap<string, readonly string[]>
  /**
   * 长参数名 → 它那一块的原文（含描述）。
   *
   * 有些事实只写在描述里而不是候选值里 —— 例如 claude 的 `--model` 把可用
   * 别名写在「e.g. 'opus', 'sonnet'」这句话中间。要把它们捞出来，就得留着原文。
   */
  readonly descriptions: ReadonlyMap<string, string>
}

/** 匹配一个参数块的起始行，例如 `  -s, --sandbox <MODE>` 或 `  --verbose`。 */
const BLOCK_START = /^\s{0,10}(?:-[A-Za-z0-9], )?--[A-Za-z0-9][\w-]*/
/** 长参数名。 */
const LONG_FLAG = /--([A-Za-z0-9][\w-]*)/g
const COMMANDER_CHOICES = /\(choices:\s*([^)]*)\)/s
const CLAP_CHOICES = /\[possible values:\s*([^\]]*)\]/s
/**
 * yargs 把候选值放在方括号里：`[string] [choices: "default", "json"]`。
 *
 * 必须排在 clap 之后再试：两者都是方括号，但 clap 的关键字是
 * `possible values`，先匹配它不会误伤。
 */
const YARGS_CHOICES = /\[choices:\s*([^\]]*)\]/s

/** 把候选值列表拆开并去掉引号与空白。 */
function splitChoices(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, '').trim())
    .filter((item) => item.length > 0)
}

/**
 * 解析一段 `--help` 文本。
 * @param helpText - CLI 的完整 help 输出。
 * @returns 出现过的参数集合与各参数的候选值。
 */
export function parseHelp(helpText: string): HelpSurface {
  const flags = new Set<string>()
  for (const match of helpText.matchAll(LONG_FLAG)) {
    const name = match[1]
    if (name !== undefined) flags.add(name)
  }

  // 按「参数块」切分：一行以参数开头，直到下一个参数开头行为止都算它的描述。
  const lines = helpText.split('\n')
  const choices = new Map<string, readonly string[]>()
  const descriptions = new Map<string, string>()
  let currentFlags: string[] = []
  let buffer: string[] = []

  const flush = (): void => {
    if (currentFlags.length === 0) return
    const block = buffer.join('\n')
    const raw = COMMANDER_CHOICES.exec(block)?.[1]
      ?? CLAP_CHOICES.exec(block)?.[1]
      ?? YARGS_CHOICES.exec(block)?.[1]
    if (raw !== undefined) {
      const values = splitChoices(raw)
      // 一个块可能同时声明短参数与长参数，候选值对每个长参数都成立。
      if (values.length > 0) for (const flag of currentFlags) choices.set(flag, values)
    }
    for (const flag of currentFlags) descriptions.set(flag, block)
    currentFlags = []
    buffer = []
  }

  for (const line of lines) {
    if (BLOCK_START.test(line)) {
      flush()
      currentFlags = [...line.matchAll(LONG_FLAG)].map((m) => m[1]).filter((n): n is string => n !== undefined)
    }
    if (currentFlags.length > 0) buffer.push(line)
  }
  flush()

  return { flags, choices, descriptions }
}

/**
 * help 里是否存在某个参数。
 * @param surface - {@link parseHelp} 的结果。
 * @param flag - 长参数名，不含 `--`。
 */
export function hasFlag(surface: HelpSurface, flag: string): boolean {
  return surface.flags.has(flag)
}

/**
 * 取某参数的候选值；未声明候选值时返回空数组。
 * @param surface - {@link parseHelp} 的结果。
 * @param flag - 长参数名，不含 `--`。
 */
export function choicesOf(surface: HelpSurface, flag: string): readonly string[] {
  return surface.choices.get(flag) ?? []
}

/**
 * 取某个参数那一块的原文（含描述）。
 * @param surface - {@link parseHelp} 的结果。
 * @param flag - 长参数名，不含 `--`。
 */
export function describeFlag(surface: HelpSurface, flag: string): string | undefined {
  return surface.descriptions.get(flag)
}
