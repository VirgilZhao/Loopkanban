/**
 * 把 `.docx` 翻成一棵能在浏览器里渲染的朴素文档树。
 *
 * 为什么要在服务端做：`.docx` 是个 ZIP，浏览器打不开；而人往任务里放的需求
 * 文档、Agent 参考的规格说明，恰恰常常就是一份 Word。看不了它，讨论里
 * 「按文档第三节做」这句话就落不了地。
 *
 * 为什么不转成 HTML 字符串：那样前端就得 `dangerouslySetInnerHTML`，于是
 * 需要一个消毒器 —— 而文档是**外来输入**。产出结构化的块与文本片段，前端
 * 照着建 React 元素，注入面从根上就不存在。
 *
 * 刻意不做的：分页、字体字号颜色、图片、页眉页脚、批注。预览要回答的是
 * 「这份文档说了什么」，不是「它印出来长什么样」——后者请打开 Word。
 */

import { extractZipEntry, readZipIndex, type ZipEntry } from './zip.ts'
import { childrenNamed, findAll, firstNamed, parseXml, type XNode } from './xml.ts'

/** 整份 `.docx` 读进内存的上限。超过这个就不该在浏览器里翻了。 */
export const DOCX_MAX_BYTES = 16 * 1024 * 1024

/**
 * 单个解压出来的 XML 上限。
 *
 * 卡在 8MB 而不是跟着 {@link DOCX_MAX_BYTES} 走，是因为**解压和解析都是同步的**，
 * 而这个进程同时还托着所有 SSE 事件流：一份几十 MB 的 `document.xml` 解下来
 * 再建成节点树，够把整个看板连同正在跑的 Agent 输出一起卡住好几秒。
 *
 * 8MB 的纯 XML 大约是几百页排满字的文档 —— 比谁会在预览栏里翻的东西都大得多。
 * 一份 `.docx` 的体积绝大部分是图片，而图片我们根本不解。超了就当读不出来
 * （文案里说明了「太大」也是原因之一）。
 */
const PART_MAX_BYTES = 8 * 1024 * 1024

/** 最多给出多少个块。极长的文档截断，并如实标出来。 */
const MAX_BLOCKS = 3000

/** 一段文字，以及它身上的格式。没有格式的字段就不出现，省下大半 JSON。 */
export interface DocSpan {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  /** 外部链接的地址。只留 http(s)，别的协议一律不带出来。 */
  readonly href?: string
}

export type DocBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly spans: readonly DocSpan[] }
  | { readonly kind: 'paragraph'; readonly spans: readonly DocSpan[] }
  | {
      readonly kind: 'list'
      readonly ordered: boolean
      readonly level: number
      /**
       * 这一条属于哪一份编号定义。
       *
       * 序号本身**不在这里算**：Word 把「第几条」摊在样式与续编规则里，
       * 照搬那套规则不值得。给出编号的身份，渲染那头就能自己数 —— 而
       * 换了一份编号就是换了一个列表，该从 1 重新开始。
       */
      readonly numId: string
      readonly spans: readonly DocSpan[]
    }
  | { readonly kind: 'table'; readonly rows: readonly (readonly (readonly DocSpan[])[])[] }

export interface RichDoc {
  readonly blocks: readonly DocBlock[]
  /** 块数超过上限，只给了前一段。 */
  readonly truncated: boolean
}

/**
 * Word 的开关型属性：`<w:b/>` 是开，`<w:b w:val="0"/>` 是关。
 *
 * 只看"标签在不在"会把显式关掉的加粗当成加粗 —— 从别处粘过来的段落里
 * 这种显式关闭到处都是。
 */
function toggled(rPr: XNode | null, name: string): boolean {
  const node = rPr === null ? null : firstNamed(rPr, name)
  if (node === null) return false
  const value = node.attrs['w:val']
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value.toLowerCase())
}

/** 一个 `w:r` 里的文字。制表与换行按字面留下来，段落的形状才不会塌掉。 */
function runText(run: XNode): string {
  let out = ''
  for (const child of run.children) {
    switch (child.name) {
      case 'w:t': out += child.text; break
      case 'w:tab': out += '\t'; break
      case 'w:br': case 'w:cr': out += '\n'; break
      case 'w:noBreakHyphen': out += '-'; break
      // `w:delText` 是修订里被删掉的字，不显示 —— 它已经不是文档的内容了。
      default: break
    }
  }
  return out
}

/** 两个片段的格式一样就并成一个。Word 会把一句话拆成十几个 run。 */
function push(spans: DocSpan[], span: DocSpan): void {
  if (span.text.length === 0) return
  const last = spans.at(-1)
  if (last !== undefined
    && last.bold === span.bold && last.italic === span.italic
    && last.underline === span.underline && last.href === span.href) {
    spans[spans.length - 1] = { ...last, text: last.text + span.text }
    return
  }
  spans.push(span)
}

/**
 * 收一个段落（或表格单元格）里的文字。
 *
 * 递归下去是因为 run 不一定是段落的直接孩子：超链接、修订标记（`w:ins`）、
 * 内容控件（`w:sdt`）都会在中间多包一层，而它们里面的字是正文的一部分。
 */
function collect(node: XNode, links: ReadonlyMap<string, string>, href: string | undefined, spans: DocSpan[]): void {
  for (const child of node.children) {
    if (child.name === 'w:r') {
      const rPr = firstNamed(child, 'w:rPr')
      const text = runText(child)
      if (text.length === 0) continue
      push(spans, {
        text,
        ...(toggled(rPr, 'w:b') ? { bold: true } : {}),
        ...(toggled(rPr, 'w:i') ? { italic: true } : {}),
        ...(toggled(rPr, 'w:u') ? { underline: true } : {}),
        ...(href === undefined ? {} : { href }),
      })
      continue
    }
    if (child.name === 'w:hyperlink') {
      const target = links.get(child.attrs['r:id'] ?? '')
      collect(child, links, target ?? href, spans)
      continue
    }
    // 被删除的修订整段跳过；别的容器（w:ins / w:sdt / w:smartTag / w:bookmark…）
    // 继续往里走。
    if (child.name === 'w:del') continue
    if (child.name === 'w:pPr' || child.name === 'w:rPr') continue
    collect(child, links, href, spans)
  }
}

/** `Heading3` / `Title` / `TOC2` → 标题层级；不是标题时为 0。 */
function headingLevel(style: string): number {
  if (/^(title)$/i.test(style)) return 1
  const numbered = /^(?:heading|toc)(\d)$/i.exec(style)
  return numbered === null ? 0 : Math.min(6, Number.parseInt(numbered[1] as string, 10))
}

/**
 * 读编号定义，判断某个列表是有序还是圆点。
 *
 * `numbering.xml` 读不出来时一律当圆点：把有序列表画成圆点只是不够漂亮，
 * 反过来把圆点画成 1. 2. 3. 会凭空造出并不存在的次序。
 */
function orderedNumIds(numbering: XNode | null): ReadonlySet<string> {
  if (numbering === null) return new Set()
  const format = new Map<string, boolean>()
  for (const abstract of childrenNamed(numbering, 'w:abstractNum')) {
    const id = abstract.attrs['w:abstractNumId']
    if (id === undefined) continue
    // 只看第 0 层：预览不区分嵌套层各自的编号样式。
    const lvl = childrenNamed(abstract, 'w:lvl').find((node) => (node.attrs['w:ilvl'] ?? '0') === '0')
    const fmt = lvl === undefined ? '' : firstNamed(lvl, 'w:numFmt')?.attrs['w:val'] ?? ''
    format.set(id, fmt !== '' && fmt !== 'bullet' && fmt !== 'none')
  }

  const ordered = new Set<string>()
  for (const num of childrenNamed(numbering, 'w:num')) {
    const numId = num.attrs['w:numId']
    const abstractId = firstNamed(num, 'w:abstractNumId')?.attrs['w:val']
    if (numId !== undefined && abstractId !== undefined && format.get(abstractId) === true) ordered.add(numId)
  }
  return ordered
}

/** 一个 `w:p` → 一个块。整段没有一个字时返回 null（Word 里空段落遍地都是）。 */
function paragraph(node: XNode, links: ReadonlyMap<string, string>, ordered: ReadonlySet<string>): DocBlock | null {
  const spans: DocSpan[] = []
  collect(node, links, undefined, spans)
  if (spans.every((span) => span.text.trim().length === 0)) return null

  const pPr = firstNamed(node, 'w:pPr')
  const style = pPr === null ? '' : firstNamed(pPr, 'w:pStyle')?.attrs['w:val'] ?? ''
  const level = headingLevel(style)
  if (level > 0) return { kind: 'heading', level, spans }

  const numPr = pPr === null ? null : firstNamed(pPr, 'w:numPr')
  if (numPr !== null) {
    const numId = firstNamed(numPr, 'w:numId')?.attrs['w:val'] ?? ''
    const depth = Number.parseInt(firstNamed(numPr, 'w:ilvl')?.attrs['w:val'] ?? '0', 10)
    return {
      kind: 'list',
      ordered: ordered.has(numId),
      level: Number.isFinite(depth) ? Math.min(5, Math.max(0, depth)) : 0,
      numId,
      spans,
    }
  }
  return { kind: 'paragraph', spans }
}

/** 一个 `w:tbl` → 一张表。单元格里的多个段落用换行接起来。 */
function table(node: XNode, links: ReadonlyMap<string, string>): DocBlock {
  const rows = childrenNamed(node, 'w:tr').map((tr) => childrenNamed(tr, 'w:tc').map((tc) => {
    const spans: DocSpan[] = []
    for (const [index, para] of childrenNamed(tc, 'w:p').entries()) {
      if (index > 0) push(spans, { text: '\n' })
      collect(para, links, undefined, spans)
    }
    return spans
  }))
  return { kind: 'table', rows }
}

/**
 * 超链接的目标：`document.xml.rels` 里按 `r:id` 记着。
 *
 * 只放行 http(s)。文档里完全可以写一条 `file:///etc/passwd` 甚至
 * `javascript:` —— 那是外来输入，不该有第二条路进到页面的 `<a href>` 里。
 */
function relationships(rels: XNode | null): Map<string, string> {
  const out = new Map<string, string>()
  if (rels === null) return out
  for (const rel of findAll(rels, 'Relationship')) {
    const id = rel.attrs['Id']
    const target = rel.attrs['Target'] ?? ''
    if (id !== undefined && /^https?:\/\//i.test(target)) out.set(id, target)
  }
  return out
}

/**
 * body 那一层里，包着正文的容器。
 *
 * Word 不是只把段落平铺在 `w:body` 下面：目录、封面、内容控件会裹一层
 * `w:sdt`，修订里整段的插入会裹一层 `w:ins`。只认直接孩子的话，这些段落
 * 会**连一声不吭地消失** —— 整篇都被裹住时，给出来的就是一份"空文档"。
 */
const CONTAINERS = new Set(['w:sdt', 'w:sdtContent', 'w:ins', 'w:customXml', 'w:smartTag'])

/**
 * 摊平出 body 里真正的块，按出现顺序。
 *
 * 只往 {@link CONTAINERS} 里面钻，不是见到什么都往下走 —— 表格单元格里也有
 * `w:p`，无差别地递归会把它们再当成一遍顶层段落，同一段文字出现两次。
 */
function* topBlocks(node: XNode): Generator<XNode> {
  for (const child of node.children) {
    if (child.name === 'w:p' || child.name === 'w:tbl') yield child
    else if (CONTAINERS.has(child.name)) yield* topBlocks(child)
  }
}

/** 解一个 zip 条目里的 XML。取不出来或解不动时为 null。 */
function part(bytes: Buffer, index: readonly ZipEntry[], name: string): XNode | null {
  const entry = index.find((candidate) => candidate.name === name)
  if (entry === undefined) return null
  const raw = extractZipEntry(bytes, entry, PART_MAX_BYTES)
  return raw === null ? null : parseXml(raw.toString('utf8'))
}

/**
 * 把一份 `.docx` 的字节读成文档树。
 *
 * @param bytes - 整个文件的内容。
 * @returns 文档树；不是一份能认出来的 `.docx` 时为 null。
 */
export function readDocx(bytes: Buffer): RichDoc | null {
  const index = readZipIndex(bytes)
  if (index === null) return null

  const document = part(bytes, index, 'word/document.xml')
  // 是个 ZIP 但里面没有 document.xml —— 那它不是 Word 文档（多半是 .xlsx
  // 之类被改了扩展名）。说"读不出来"，不要给一份空文档。
  if (document === null) return null
  const body = firstNamed(document, 'w:body') ?? document

  const links = relationships(part(bytes, index, 'word/_rels/document.xml.rels'))
  const ordered = orderedNumIds(part(bytes, index, 'word/numbering.xml'))

  const blocks: DocBlock[] = []
  let truncated = false
  for (const child of topBlocks(body)) {
    if (blocks.length >= MAX_BLOCKS) { truncated = true; break }
    if (child.name === 'w:p') {
      const block = paragraph(child, links, ordered)
      if (block !== null) blocks.push(block)
    } else if (child.name === 'w:tbl') {
      blocks.push(table(child, links))
    }
  }

  return { blocks, truncated }
}
