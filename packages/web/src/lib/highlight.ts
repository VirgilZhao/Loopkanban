/**
 * 一个自己写的语法高亮器。
 *
 * 为什么不引 highlight.js / shiki：前者压完还有 100KB 上下、且要按语言再拉
 * 语法包，后者要带一整套 TextMate 语法和 WASM —— 而这里要照亮的是「Agent 刚
 * 改的那个文件」，读的人要的是把注释、字符串、关键字从一片等宽灰字里分出来，
 * 不是编辑器级别的语义着色。
 *
 * 产出的是**词元数组，不是 HTML 字符串**：调用方拿它建 React 元素，所以
 * 文件内容里带着 `</span>` 也只是一段文字，没有注入面。这与 `markdown.tsx`
 * 是同一条原则。
 *
 * 认不出的语言退回 `plain` —— 一片等寬灰字，和高亮前一样，不会更糟。
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  /** 类型名、内置类型。 */
  | 'type'
  /** 调用位置上的函数名。 */
  | 'func'
  /** 对象属性、YAML/JSON 的键、CSS 的属性名。 */
  | 'prop'
  /** 标记语言的标签名。 */
  | 'tag'
  /** 标记语言的属性名。 */
  | 'attr'
  | 'punct'

export interface Token {
  readonly kind: TokenKind
  readonly text: string
}

export type Language =
  | 'ts' | 'go' | 'rust' | 'java' | 'c' | 'php' | 'python' | 'ruby' | 'shell'
  | 'json' | 'yaml' | 'toml' | 'css' | 'markup' | 'sql' | 'markdown' | 'plain'

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '))

/**
 * 每种语言的关键字。
 *
 * 分语言列而不是并成一大坨，是因为并起来会伤到最常见的情况：JS 里一个叫
 * `val` 的变量会被 Kotlin 的关键字点亮，Go 里的 `type` 字段名会被当成声明。
 * 高亮错的地方比不高亮更让人分神。
 */
const KEYWORDS: Readonly<Record<Language, ReadonlySet<string>>> = {
  ts: words('as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let new of readonly return satisfies set static super switch this throw try typeof var void while with yield declare namespace abstract public private protected'),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
  rust: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while'),
  java: words('abstract as break case catch class companion const continue data default do else enum extends extension final finally for fun function fun if implements import in infix init inline instanceof interface internal is lateinit let native new object open operator out override package private protected public return sealed static super suspend switch synchronized this throw throws try typealias val var when where while'),
  c: words('alignas auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while'),
  php: words('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
  python: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'),
  ruby: words('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'),
  shell: words('if then else elif fi for while until do done case esac function in return break continue local export readonly declare source alias unset shift trap set'),
  sql: words('select from where insert into values update set delete create table alter drop index view join inner left right outer full on group by order having limit offset union all as distinct and or not null is in exists between like case when then else end primary key foreign references default constraint unique with returning'),
  json: new Set(['true', 'false', 'null']),
  yaml: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']),
  toml: new Set(['true', 'false']),
  css: new Set<string>(),
  markup: new Set<string>(),
  markdown: new Set<string>(),
  plain: new Set<string>(),
}

/** 内置类型名。点亮它们，一眼就能看出一个签名收什么吐什么。 */
const TYPES: Readonly<Partial<Record<Language, ReadonlySet<string>>>> = {
  ts: words('string number boolean object symbol bigint any unknown never null undefined true false Array Promise Record Map Set Date RegExp Error JSON Math console window document'),
  go: words('bool string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr byte rune float32 float64 complex64 complex128 error any nil true false make new len cap append copy delete panic recover'),
  rust: words('bool char str String i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 Vec Option Some None Result Ok Err Box Rc Arc true false'),
  java: words('boolean byte char double float int long short void String Integer Boolean Double Long List Map Set Object true false null Unit Any Nothing'),
  c: words('int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t ptrdiff_t wchar_t string vector map set NULL'),
  python: words('None True False self cls int float str bool list dict set tuple bytes object type len range print isinstance super Exception ValueError TypeError KeyError'),
  ruby: words('nil true false Integer String Symbol Array Hash Proc Struct puts require attr_accessor attr_reader attr_writer'),
  php: words('int float string bool array object mixed void null true false self parent static callable iterable'),
}

/** 一个语言的词法长什么样。够描述我们支持的那几种，不追求通用。 */
interface Grammar {
  /** 行注释的起始记号。 */
  readonly line: readonly string[]
  /** 块注释的起止。 */
  readonly block?: readonly [string, string]
  /** 普通字符串的引号。 */
  readonly quotes: readonly string[]
  /** 成对的长串（Python 的三引号、Shell 的 heredoc 不算）。 */
  readonly long?: readonly (readonly [string, string])[]
  /** 标识符里除字母数字下划线外还允许的字符。 */
  readonly extra?: string
  /** 反斜杠在字符串里是转义。 */
  readonly escape: boolean
}

const C_LIKE: Grammar = { line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'], escape: true }
const HASH: Grammar = { line: ['#'], quotes: ['"', "'"], escape: true }

const GRAMMARS: Readonly<Record<Language, Grammar>> = {
  ts: C_LIKE,
  go: C_LIKE,
  rust: C_LIKE,
  java: C_LIKE,
  c: { ...C_LIKE, line: ['//', '#'] },
  php: { ...C_LIKE, line: ['//', '#'], extra: '$' },
  python: { ...HASH, long: [['"""', '"""'], ["'''", "'''"]] },
  ruby: { ...HASH, extra: '@?!' },
  shell: { ...HASH, extra: '$-' },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: ['"', "'", '`'], escape: false },
  json: { line: [], quotes: ['"'], escape: true },
  yaml: HASH,
  toml: { line: ['#'], quotes: ['"', "'"], long: [['"""', '"""'], ["'''", "'''"]], escape: true },
  css: { line: [], block: ['/*', '*/'], quotes: ['"', "'"], extra: '-@', escape: true },
  markup: C_LIKE,
  markdown: C_LIKE,
  plain: { line: [], quotes: [], escape: false },
}

const EXTENSIONS: Readonly<Record<string, Language>> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', vue: 'markup', svelte: 'markup',
  go: 'go',
  rs: 'rust',
  java: 'java', kt: 'java', kts: 'java', scala: 'java', cs: 'java', swift: 'java', dart: 'java', groovy: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  php: 'php',
  py: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby', gemfile: 'ruby',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell', env: 'shell',
  json: 'json', jsonc: 'json', json5: 'json', lock: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml', properties: 'toml',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', xhtml: 'markup', svg: 'markup', plist: 'markup',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
}

/** 没有扩展名、但名字本身就说明了是什么的那些文件。 */
const BY_NAME: Readonly<Record<string, Language>> = {
  dockerfile: 'shell',
  makefile: 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.gitignore': 'shell',
  '.gitattributes': 'shell',
  '.env': 'shell',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
}

/**
 * 按文件名猜语言。
 *
 * @param name - 文件名或路径。
 * @returns 认出来的语言；认不出是 `plain`。
 */
export function languageOf(name: string): Language {
  const base = (name.split(/[/\\]/).pop() ?? '').toLowerCase()
  const known = BY_NAME[base]
  if (known !== undefined) return known
  // `.gitignore` 这类以点开头的名字，`split('.')` 的最后一段就是它自己。
  const ext = base.includes('.') && !base.startsWith('.') ? base.split('.').pop() ?? '' : ''
  return EXTENSIONS[ext] ?? 'plain'
}

/**
 * 「冒号左边的东西是个键」——这几种语言里成立。
 *
 * 配置文件读起来最费劲的一点就是键与值糊成一片，把键单挑出来，层级一眼可见。
 */
const KEYED = new Set<Language>(['json', 'yaml', 'toml', 'css'])

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'

function isWordChar(ch: string, extra: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || isDigit(ch) || ch === '_'
    || ch.charCodeAt(0) > 127 || extra.includes(ch)
}

/** 往后看第一个非空白字符。判断一个标识符是不是被当成函数在调。 */
function peekNonSpace(source: string, from: number): string {
  for (let at = from; at < source.length; at += 1) {
    const ch = source[at] as string
    if (!isSpace(ch)) return ch
  }
  return ''
}

/** 往前看最近一个非空白字符。`.foo` 里的 foo 是属性不是变量。 */
function backNonSpace(source: string, before: number): string {
  for (let at = before - 1; at >= 0; at -= 1) {
    const ch = source[at] as string
    if (!isSpace(ch)) return ch
  }
  return ''
}

/**
 * 通用扫描器：注释、字符串、数字、标识符、标点。
 *
 * 一遍过、不回溯，所以哪怕文件有几千行也只是一次线性扫描 —— 高亮是在渲染
 * 路径上做的，慢一点整个面板就会卡在滚动上。
 */
function scan(source: string, language: Language): Token[] {
  const grammar = GRAMMARS[language]
  const keywords = KEYWORDS[language]
  const types = TYPES[language] ?? new Set<string>()
  const extra = grammar.extra ?? ''
  const out: Token[] = []
  let at = 0
  let plain = ''

  const flush = (): void => {
    if (plain.length > 0) { out.push({ kind: 'plain', text: plain }); plain = '' }
  }
  const emit = (kind: TokenKind, text: string): void => { flush(); out.push({ kind, text }) }

  while (at < source.length) {
    const ch = source[at] as string

    // ── 注释 ────────────────────────────────────────────
    const lineMark = grammar.line.find((mark) => source.startsWith(mark, at))
    if (lineMark !== undefined) {
      const end = source.indexOf('\n', at)
      const stop = end === -1 ? source.length : end
      emit('comment', source.slice(at, stop))
      at = stop
      continue
    }
    if (grammar.block !== undefined && source.startsWith(grammar.block[0], at)) {
      const close = source.indexOf(grammar.block[1], at + grammar.block[0].length)
      const stop = close === -1 ? source.length : close + grammar.block[1].length
      emit('comment', source.slice(at, stop))
      at = stop
      continue
    }

    // ── 长字符串（三引号） ──────────────────────────────
    const long = grammar.long?.find((pair) => source.startsWith(pair[0], at))
    if (long !== undefined) {
      const close = source.indexOf(long[1], at + long[0].length)
      const stop = close === -1 ? source.length : close + long[1].length
      emit('string', source.slice(at, stop))
      at = stop
      continue
    }

    // ── 字符串 ──────────────────────────────────────────
    if (grammar.quotes.includes(ch)) {
      let end = at + 1
      while (end < source.length) {
        const here = source[end] as string
        if (grammar.escape && here === '\\') { end += 2; continue }
        if (here === ch) { end += 1; break }
        // 单行字符串不跨行。少一个引号不该让整个文件后半截都变成字符串。
        if (here === '\n' && ch !== '`') break
        end += 1
      }
      const stop = Math.min(end, source.length)
      // JSON 的键就是一个后面跟着冒号的字符串。
      emit(KEYED.has(language) && peekNonSpace(source, stop) === ':' ? 'prop' : 'string', source.slice(at, stop))
      at = stop
      continue
    }

    // ── 数字 ────────────────────────────────────────────
    if (isDigit(ch) && !isWordChar(source[at - 1] ?? ' ', extra)) {
      let end = at
      while (end < source.length && /[0-9a-fx_.eE+-]/.test(source[end] as string)) {
        // `1e+5` 里的符号算数字，`1+5` 里的不算。
        const here = source[end] as string
        if ((here === '+' || here === '-') && !/[eE]/.test(source[end - 1] ?? '')) break
        end += 1
      }
      emit('number', source.slice(at, end))
      at = end
      continue
    }

    // ── 标识符 ──────────────────────────────────────────
    if (isWordChar(ch, extra) && !isDigit(ch)) {
      let end = at
      while (end < source.length && isWordChar(source[end] as string, extra)) end += 1
      const word = source.slice(at, end)
      const kind: TokenKind = keywords.has(word) ? 'keyword'
        : types.has(word) ? 'type'
        : backNonSpace(source, at) === '.' ? 'prop'
        : KEYED.has(language) && [':', '='].includes(peekNonSpace(source, end)) ? 'prop'
        : peekNonSpace(source, end) === '(' ? 'func'
        // 大写开头的多半是类型名。这条是猜的，但猜对的时候远多于猜错。
        : /^[A-Z][A-Za-z0-9_]*$/.test(word) ? 'type'
        : 'plain'
      if (kind === 'plain') plain += word
      else emit(kind, word)
      at = end
      continue
    }

    if (isSpace(ch)) { plain += ch; at += 1; continue }

    // 剩下的都是标点。连着的几个（`=>`、`::`、`!==`）并成一个记号 ——
    // 一个一个地发，一行密一点的代码就能碎成几十个 span，DOM 白白重一倍。
    const last = out.at(-1)
    if (plain.length === 0 && last?.kind === 'punct') out[out.length - 1] = { kind: 'punct', text: last.text + ch }
    else emit('punct', ch)
    at += 1
  }

  flush()
  return out
}

/**
 * 标记语言（HTML / XML / SVG）另走一套。
 *
 * 通用扫描器在这里没有意义：这类文件的绝大多数字符是标签外的正文，而
 * 「关键字」这个概念根本不存在。要分出来的是标签名、属性名和属性值。
 */
function scanMarkup(source: string): Token[] {
  const out: Token[] = []
  let at = 0

  while (at < source.length) {
    const lt = source.indexOf('<', at)
    if (lt === -1) { out.push({ kind: 'plain', text: source.slice(at) }); break }
    if (lt > at) out.push({ kind: 'plain', text: source.slice(at, lt) })

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      const stop = end === -1 ? source.length : end + 3
      out.push({ kind: 'comment', text: source.slice(lt, stop) })
      at = stop
      continue
    }

    const gt = source.indexOf('>', lt)
    if (gt === -1) { out.push({ kind: 'plain', text: source.slice(lt) }); break }
    const inner = source.slice(lt, gt + 1)
    at = gt + 1

    // `<?xml …?>` / `<!DOCTYPE …>`：整段当一个记号，里面不必再分。
    if (inner.startsWith('<?') || inner.startsWith('<!')) {
      out.push({ kind: 'comment', text: inner })
      continue
    }

    // `<`、可能的 `/`、标签名，然后是属性。
    const head = /^<\/?[\w:.-]*/.exec(inner)?.[0] ?? '<'
    out.push({ kind: 'punct', text: head.startsWith('</') ? '</' : '<' })
    const name = head.replace(/^<\/?/, '')
    if (name.length > 0) out.push({ kind: 'tag', text: name })

    const rest = inner.slice(head.length)
    const ATTR = /([\w:.-]+)|("[^"]*"|'[^']*')|(\s+)|(.)/g
    for (let hit = ATTR.exec(rest); hit !== null; hit = ATTR.exec(rest)) {
      if (hit[1] !== undefined) out.push({ kind: 'attr', text: hit[1] })
      else if (hit[2] !== undefined) out.push({ kind: 'string', text: hit[2] })
      else out.push({ kind: hit[3] === undefined ? 'punct' : 'plain', text: hit[0] })
    }
  }

  return out
}

/** Markdown 原文视图：把结构记号点出来，不去解析语义。 */
const MD_RULES: readonly (readonly [RegExp, TokenKind])[] = [
  [/^\s{0,3}(#{1,6})\s.*$/, 'keyword'],
  [/^\s{0,3}(```|~~~).*$/, 'tag'],
  [/^\s{0,3}>.*$/, 'comment'],
]

function scanMarkdown(source: string): Token[] {
  const out: Token[] = []
  let fenced = false

  for (const [index, line] of source.split('\n').entries()) {
    if (index > 0) out.push({ kind: 'plain', text: '\n' })

    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
      out.push({ kind: 'tag', text: line })
      continue
    }
    if (fenced) { out.push({ kind: 'plain', text: line }); continue }

    const whole = MD_RULES.find(([pattern]) => pattern.test(line))
    if (whole !== undefined) { out.push({ kind: whole[1], text: line }); continue }

    // 行内：代码、加粗、斜体、链接、列表记号。切成片段逐个归类。
    const INLINE = /(`[^`]*`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]*\])(\([^)]*\))|^(\s*(?:[-*+]|\d+\.)\s)/g
    let cursor = 0
    for (let hit = INLINE.exec(line); hit !== null; hit = INLINE.exec(line)) {
      if (hit.index > cursor) out.push({ kind: 'plain', text: line.slice(cursor, hit.index) })
      if (hit[1] !== undefined) out.push({ kind: 'string', text: hit[1] })
      else if (hit[2] !== undefined) out.push({ kind: 'keyword', text: hit[2] })
      else if (hit[3] !== undefined) out.push({ kind: 'type', text: hit[3] })
      else if (hit[4] !== undefined) {
        out.push({ kind: 'attr', text: hit[4] })
        out.push({ kind: 'string', text: hit[5] ?? '' })
      } else out.push({ kind: 'punct', text: hit[6] ?? hit[0] })
      cursor = hit.index + hit[0].length
    }
    if (cursor < line.length) out.push({ kind: 'plain', text: line.slice(cursor) })
  }

  return out
}

/**
 * 高亮一段源码，按行给出词元。
 *
 * 按行而不是一长串，是因为渲染那头要给每行配一个行号 —— 让调用方自己再切
 * 一遍，等于把同一件事做两遍。
 *
 * @param source - 源码原文。
 * @param language - 语言；`plain` 表示整体不着色。
 */
export function highlightLines(source: string, language: Language): Token[][] {
  const text = source.replace(/\r\n/g, '\n')
  const flat = language === 'plain' ? [{ kind: 'plain' as const, text }]
    : language === 'markup' ? scanMarkup(text)
    : language === 'markdown' ? scanMarkdown(text)
    : scan(text, language)

  const lines: Token[][] = [[]]
  for (const token of flat) {
    const pieces = token.text.split('\n')
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) lines.push([])
      if (piece.length > 0) (lines.at(-1) as Token[]).push({ kind: token.kind, text: piece })
    }
  }
  return lines
}
