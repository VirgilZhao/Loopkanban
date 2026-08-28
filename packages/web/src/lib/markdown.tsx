import type { JSX } from 'react'

/**
 * 一个刻意简化的 Markdown 渲染器。
 *
 * **不引依赖、也不生成 HTML 字符串**：直接产出 React 元素，所以 Agent 的
 * 输出里就算带着 `<script>` 也只是一段文本，没有任何注入面 —— 用
 * `marked` + `dangerouslySetInnerHTML` 就得再配一个消毒器，那是两个依赖
 * 加一处必须记得做对的地方。
 *
 * 支持的正好是 Agent 回复里真正会出现的东西：标题、围栏代码块、有序/无序
 * 列表、引用、段落，以及行内的 `代码`、**粗体**、*斜体*、[链接]()。
 * 别的（表格、图片、脚注）按原文显示，不装作认识。
 */

/** 行内标记：代码 / 粗体 / 斜体 / 链接。 */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

function renderInline(text: string, key: string): (JSX.Element | string)[] {
  return text.split(INLINE).filter((part) => part.length > 0).map((part, index) => {
    const id = `${key}-${String(index)}`
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={id} className="mono rounded-sm bg-raised px-1 py-px text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={id} className="font-semibold">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={id}>{part.slice(1, -1)}</em>
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link !== null) {
      // 只放行 http(s)：javascript: 这类伪协议一律退化成纯文本。
      const href = link[2] ?? ''
      const label = link[1] ?? ''
      if (/^https?:\/\//.test(href)) {
        return (
          <a key={id} href={href} target="_blank" rel="noreferrer" className="text-sodium underline underline-offset-2">
            {label}
          </a>
        )
      }
      return <span key={id}>{part}</span>
    }
    return part
  })
}

/**
 * 把一段 Markdown 渲染成 React 元素。
 * @param source - 原文。
 */
export function renderMarkdown(source: string): JSX.Element[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const out: JSX.Element[] = []
  let index = 0

  const key = (): string => `md-${String(out.length)}`

  while (index < lines.length) {
    const line = lines[index] ?? ''

    // 围栏代码块：整段原样保留，里面不做任何行内解析。
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence !== null) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      out.push(
        <pre key={key()} className="mono my-2 overflow-x-auto rounded-md border border-hairline bg-sunken/60 p-2.5 text-[11px] leading-relaxed">
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const depth = (heading[1] ?? '#').length
      out.push(
        <p
          key={key()}
          className={depth <= 2 ? 'mt-3 mb-1 text-sm font-semibold text-ink' : 'mt-2 mb-1 font-medium text-ink'}
        >
          {renderInline(heading[2] ?? '', key())}
        </p>,
      )
      index += 1
      continue
    }

    // 列表：连续的同类行收成一组。
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*([-*+]|\d+\.)\s+/, ''))
        index += 1
      }
      const Tag = ordered ? 'ol' : 'ul'
      out.push(
        <Tag key={key()} className={`my-1.5 space-y-1 ps-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((item, i) => (
            <li key={`${key()}-${String(i)}`}>{renderInline(item, `${key()}-${String(i)}`)}</li>
          ))}
        </Tag>,
      )
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      out.push(
        <blockquote key={key()} className="my-2 border-s-2 border-hairline ps-3 text-ink-faint">
          {renderInline(quoted.join(' '), key())}
        </blockquote>,
      )
      continue
    }

    if (line.trim().length === 0) { index += 1; continue }

    // 段落：连续的非空行算一段，软换行按 Markdown 的规矩折成空格。
    const para: string[] = []
    while (index < lines.length && (lines[index] ?? '').trim().length > 0
      && !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(lines[index] ?? '')) {
      para.push((lines[index] ?? '').trim())
      index += 1
    }
    out.push(
      <p key={key()} className="my-1.5 leading-relaxed">{renderInline(para.join(' '), key())}</p>,
    )
  }

  return out
}
