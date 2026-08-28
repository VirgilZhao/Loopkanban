/**
 * 一个够用就好的 XML 解析器。
 *
 * 为什么不引 `fast-xml-parser` 之流：整个仓库的运行时依赖是零，而我们要解的
 * 只有一种 XML —— Word 自己写出来的 `document.xml`。它是机器生成的、格式规整
 * 的、不带 DTD 实体的；真正要处理的只有标签、属性、文本和 CDATA 这四样。
 *
 * 也**不产出 HTML 字符串**：解出来的是一棵朴素的树，调用方自己挑需要的节点。
 * 文档里带着 `<script>` 也只是一个名字叫 script 的节点，没有任何注入面。
 */

export interface XNode {
  /** 带命名空间前缀的原名，例如 `w:p`。Word 的文档里前缀是固定的。 */
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly XNode[]
  /** 直属文本子节点拼起来的字符串，不含后代元素里的文本。 */
  readonly text: string
}

/** XML 只预定义这五个实体。别的（`&nbsp;` 之类）要 DTD，Word 不会写。 */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
}

/** 认不出来的实体原样留着 —— 猜错比留着难看得多。 */
function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, body: string) => {
    if (!body.startsWith('#')) return NAMED[body.toLowerCase()] ?? whole
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10)
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
    try {
      return String.fromCodePoint(code)
    } catch {
      // 代理区的孤码，`fromCodePoint` 会抛。原样留着。
      return whole
    }
  })
}

/**
 * 找标签的 `>`，跳过引号里的那些。
 *
 * 属性值里出现 `>` 是合法的（`w:val="a>b"`），拿 `indexOf('>')` 会把标签
 * 从中间切开，后面整棵树就全歪了。
 */
function tagEnd(source: string, from: number): number {
  let quote = ''
  for (let at = from; at < source.length; at += 1) {
    const ch = source[at] as string
    if (quote !== '') { if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return at
  }
  return -1
}

const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

interface Mut { name: string; attrs: Record<string, string>; children: Mut[]; text: string }

/** 拆一个开标签的内容（不含尖括号、不含末尾的 `/`）。 */
function openTag(body: string): Mut {
  const name = /^[^\s/>]+/.exec(body)?.[0] ?? ''
  const attrs: Record<string, string> = {}
  ATTR.lastIndex = name.length
  for (let hit = ATTR.exec(body); hit !== null; hit = ATTR.exec(body)) {
    attrs[hit[1] as string] = decodeEntities(hit[2] ?? hit[3] ?? '')
  }
  return { name, attrs, children: [], text: '' }
}

/**
 * 解析一份 XML，返回根元素。
 *
 * 遇到畸形结构一律**尽量往下读**而不是抛：一份 Word 文档解到一半失败，
 * 能给出前面那些段落，也比一句「打不开」有用。
 *
 * @param source - XML 原文。
 * @returns 根元素；一个元素都没有时为 null。
 */
export function parseXml(source: string): XNode | null {
  const stack: Mut[] = []
  let root: Mut | null = null
  let at = 0

  const addText = (raw: string): void => {
    const top = stack.at(-1)
    if (top !== undefined && raw.length > 0) top.text += raw
  }

  while (at < source.length) {
    const lt = source.indexOf('<', at)
    if (lt === -1) { addText(decodeEntities(source.slice(at))); break }
    if (lt > at) addText(decodeEntities(source.slice(at, lt)))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      at = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      // CDATA 里的内容按字面算，不解实体 —— 那正是 CDATA 的意思。
      addText(source.slice(lt + 9, end === -1 ? source.length : end))
      at = end === -1 ? source.length : end + 3
      continue
    }
    // `<?xml …?>` 与 `<!DOCTYPE …>`：跳过，我们不关心。
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = tagEnd(source, lt)
      at = end === -1 ? source.length : end + 1
      continue
    }

    const gt = tagEnd(source, lt)
    if (gt === -1) break
    const inner = source.slice(lt + 1, gt)
    at = gt + 1

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      // 闭标签对不上时弹到最近一个同名的为止。少一个闭标签不该让后面的
      // 内容整个错位挂在里层。
      const depth = stack.findLastIndex((node) => node.name === name)
      if (depth !== -1) stack.length = depth
      continue
    }

    const selfClosing = inner.endsWith('/')
    const node = openTag(selfClosing ? inner.slice(0, -1) : inner)
    if (node.name.length === 0) continue

    const parent = stack.at(-1)
    if (parent === undefined) root ??= node
    else parent.children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return root
}

/** 直属子元素里所有叫这个名字的。 */
export function childrenNamed(node: XNode, name: string): XNode[] {
  return node.children.filter((child) => child.name === name)
}

/** 第一个叫这个名字的直属子元素。 */
export function firstNamed(node: XNode, name: string): XNode | null {
  return node.children.find((child) => child.name === name) ?? null
}

/** 整棵子树里所有叫这个名字的元素，先序。 */
export function findAll(node: XNode, name: string): XNode[] {
  const out: XNode[] = []
  const walk = (here: XNode): void => {
    if (here.name === name) out.push(here)
    for (const child of here.children) walk(child)
  }
  walk(node)
  return out
}

/** 整棵子树里的文本，按出现顺序拼起来。 */
export function textOf(node: XNode): string {
  let out = node.text
  for (const child of node.children) out += textOf(child)
  return out
}
