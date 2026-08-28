/**
 * 命令行的 Tab 补全 —— 纯字符串那一半。
 *
 * 为什么单独拆出来：补全真正难的地方不是"去列个目录"，而是**在一行 shell
 * 命令里认出光标正压着的那个词**。`cp "my dir/a.txt" ./b<光标>` 里要补的是
 * `./b`，不是整行、也不是最后一个空格之后的所有字符 —— 引号里的空格不算
 * 分词。这段逻辑没有 IO、没有 React，因此可以直接拿测试钉死；剩下的
 * "列目录、画候选" 才交给组件。
 *
 * 只认路径，不认命令名：补命令名要读整条 PATH，那是另一个服务端接口；而
 * 这个终端里绝大多数的 Tab 都是为了走进某个七层深的目录。
 */

/** 词被哪种引号包着。裸词为 null。 */
export type Quote = '"' | "'" | null

export interface Token {
  /** 词的起点（含）。替换时从这里开始 —— 引号也在里面。 */
  readonly start: number
  /** 词的终点（不含）。恒等于光标位置：补的是光标**前面**那一截。 */
  readonly end: number
  /** 脱掉引号与反斜杠之后的字面值，可以直接当路径用。 */
  readonly value: string
  readonly quote: Quote
  /**
   * 是不是命令名那一位（行首，或 `|`、`;`、`&` 之后）。
   *
   * 重定向不算：`ls > out` 里的 `out` 是文件名，不是命令名。
   */
  readonly first: boolean
}

/** 分词符。引号里的这些字符不算数。 */
const BREAK = /[\s|;&<>()]/

/**
 * 认出光标压着的那个词。
 *
 * 从行首正着扫而不是从光标倒着找空格：倒着找没法知道那个空格是不是在引号
 * 里，而 `git commit -m "wip fix` 这种半开的引号在终端里随处可见。
 *
 * @param line - 整行命令。
 * @param caret - 光标位置（`selectionStart`）。
 * @returns 光标前那个词；光标正停在空白上时，返回一个落在光标处的空词 ——
 *   那也是能补的（`cd <Tab>` 应该列出当前目录）。
 */
export function tokenAt(line: string, caret: number): Token {
  const text = line.slice(0, Math.max(0, Math.min(caret, line.length)))
  let start = -1
  let value = ''
  let quote: Quote = null
  let opened: Quote = null
  let first = true

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote !== null) {
      if (ch === quote) { quote = null; continue }
      // 单引号里反斜杠不是转义符 —— 那是 shell 的规矩，不是这里的简化。
      if (quote === '"' && ch === '\\' && i + 1 < text.length) { i += 1; value += text[i] as string; continue }
      value += ch
      continue
    }
    if (ch === '\\') {
      if (start < 0) start = i
      if (i + 1 < text.length) { i += 1; value += text[i] as string }
      continue
    }
    if (ch === '"' || ch === "'") {
      if (start < 0) start = i
      quote = ch
      opened = ch
      continue
    }
    if (BREAK.test(ch)) {
      if (start >= 0) { start = -1; value = ''; opened = null; first = false }
      // 管道、分号、括号开的是新一条命令，它后面又是命令名那一位。
      // `>` `<` 不是：重定向的目标永远是文件名 —— 而那恰恰是最常按 Tab 的地方。
      if (ch === '<' || ch === '>') first = false
      else if (ch !== ' ' && ch !== '\t') first = true
      continue
    }
    if (start < 0) start = i
    value += ch
  }

  return start < 0
    ? { start: text.length, end: text.length, value: '', quote: null, first }
    : { start, end: text.length, value, quote: opened, first }
}

/**
 * 这个词该不该补路径。
 *
 * 命令名那一位放过去：那里要的是 PATH 里的可执行文件，拿当前目录的文件去
 * 填只会把 `gi` 补成 `gitignore-ish` 之类的东西。但写成 `./scripts/x` 的
 * 命令名带着斜杠，那确实是路径，照补。
 */
export function completable(token: Token): boolean {
  return !token.first || token.value.includes('/')
}

/** 把词切成"目录那一截"和"要匹配的前缀"。目录一截**带着结尾的斜杠**。 */
export function splitPath(value: string): { dir: string; prefix: string } {
  const cut = value.lastIndexOf('/')
  return cut < 0
    ? { dir: '', prefix: value }
    : { dir: value.slice(0, cut + 1), prefix: value.slice(cut + 1) }
}

/**
 * 挑出前缀对得上的条目。
 *
 * 两条不写在别处的规矩：
 *
 * - **点开头的条目要显式提出来才给**（`.g<Tab>`）。不然在仓库根上敲一个
 *   Tab，`.git`、`.github`、`.gitignore` 会把真正要找的东西挤出屏幕。
 * - 大小写敏感的匹配一个都没有时，**退回到不敏感**。macOS 的文件系统本来
 *   就不区分大小写，`readme<Tab>` 补不出 `README.md` 只会让人以为坏了。
 */
export function matching<T extends { name: string }>(entries: readonly T[], prefix: string): T[] {
  const visible = prefix.startsWith('.') ? entries : entries.filter((e) => !e.name.startsWith('.'))
  if (prefix.length === 0) return [...visible]
  const exact = visible.filter((e) => e.name.startsWith(prefix))
  if (exact.length > 0) return exact
  const lower = prefix.toLowerCase()
  return visible.filter((e) => e.name.toLowerCase().startsWith(lower))
}

/** 一组名字的最长公共前缀。补到这里为止是**无歧义**的那一段。 */
export function commonPrefix(names: readonly string[]): string {
  const first = names[0]
  if (first === undefined) return ''
  let end = first.length
  for (const name of names) {
    let i = 0
    while (i < end && i < name.length && name[i] === first[i]) i += 1
    end = i
  }
  return first.slice(0, end)
}

/**
 * 把一段路径变回能直接贴进命令行的文本。
 *
 * 必须转义：目录里出现空格、`$`、`(` 是常事，原样贴回去命令会以别人想不到
 * 的方式碎掉 —— 而这一步恰恰是补全替用户做的，他没机会检查。
 *
 * 词本来带引号就照旧用引号包回去（并把闭引号补上）：用户选了引号这条路，
 * 补全不该把它改写成一串反斜杠。
 */
export function literal(path: string, quote: Quote): string {
  // 单引号里什么都不转义，唯独单引号自己要"退出去再拼回来"。
  if (quote === "'") return `'${path.replaceAll("'", "'\\''")}'`
  if (quote === '"') return `"${path.replace(/(["\\$`])/g, '\\$1')}"`
  return path.replace(/([\s"'\\$`&|;<>()*?[\]{}#!])/g, '\\$1')
}
