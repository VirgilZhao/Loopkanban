import { useMemo } from 'react'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { DocBlock, DocSpan, RichDoc } from '@/types.ts'

/**
 * 服务端翻出来的文档树（目前只有 `.docx`）的渲染。
 *
 * 收到的是**结构化的块与片段，不是 HTML 字符串** —— 所以这里直接建 React
 * 元素，文档里带着 `<script>` 也只是一段文字。用 `dangerouslySetInnerHTML`
 * 就得再配一个消毒器，而文档是外来输入，那是一处必须永远记得做对的地方。
 *
 * 刻意不还原的：字体、字号、颜色、分页、图片。预览要回答的是「这份文档说了
 * 什么」，不是「它印出来长什么样」—— 后者请打开 Word。
 */

/** 一段文字。加粗/斜体/下划线各自叠上去；链接只可能是 http(s)，服务端把过关了。 */
function Span({ span }: { span: DocSpan }): React.JSX.Element {
  const style = cn(
    span.bold === true && 'font-semibold text-ink',
    span.italic === true && 'italic',
    span.underline === true && 'underline underline-offset-2',
  )
  if (span.href !== undefined) {
    return (
      <a
        href={span.href}
        target="_blank"
        rel="noreferrer"
        title={span.href}
        className={cn(style, 'text-sodium underline underline-offset-2')}
      >
        {span.text}
      </a>
    )
  }
  return style.length === 0 ? <>{span.text}</> : <span className={style}>{span.text}</span>
}

/** 一串片段。Word 里的软换行是片段里的 `\n`，靠外面的 `whitespace-pre-wrap` 留住。 */
function Spans({ spans }: { spans: DocSpan[] }): React.JSX.Element {
  // 片段没有身份可言，位置就是它的身份。
  return <>{spans.map((span, index) => <Span key={index} span={span} />)}</>
}

/** 标题逐级收小。三级以下不再变化 —— 再小就读不出层级，只是更难看清。 */
const HEADING: Readonly<Record<number, string>> = {
  1: 'mt-5 mb-2 text-[17px] font-semibold',
  2: 'mt-4 mb-2 text-[15px] font-semibold',
  3: 'mt-3 mb-1.5 text-[13.5px] font-semibold',
}

/** 无序列表逐层换一个点，嵌套关系才看得出来。 */
const BULLETS = ['•', '◦', '▪', '·']

/**
 * 每条列表项前面印什么。
 *
 * 序号在这里数，而不是照搬 Word：它把「第几条」摊在样式定义与续编规则里，
 * 照着实现代价远大于收益。这里的规则简单且够用 —— 同一份编号（`numId`）
 * 里逐条递增；换了一份编号，或者中间隔了标题、表格，就从头再来。
 *
 * 段落**不打断**编号：Word 文档里列表项之间夹一段说明文字太常见了，
 * 见一段就重新数会把一份规格说明的条号全打乱。
 */
function markersOf(blocks: readonly DocBlock[]): (string | null)[] {
  let counters: number[] = []
  let current = ''
  return blocks.map((block) => {
    if (block.kind === 'heading' || block.kind === 'table') { counters = []; current = ''; return null }
    if (block.kind !== 'list') return null
    if (block.numId !== current) { counters = []; current = block.numId }
    if (!block.ordered) {
      // 圆点不占号，但要把它下面的层级清掉：退回上一层再开的编号从 1 起。
      counters.length = block.level
      return BULLETS[block.level % BULLETS.length] ?? '•'
    }
    counters.length = block.level + 1
    const next = (counters[block.level] ?? 0) + 1
    counters[block.level] = next
    return `${String(next)}.`
  })
}

function Block({ block, marker }: { block: DocBlock; marker: string | null }): React.JSX.Element {
  switch (block.kind) {
    case 'heading':
      return (
        <p className={cn('text-ink', HEADING[block.level] ?? 'mt-3 mb-1 font-semibold')}>
          <Spans spans={block.spans} />
        </p>
      )

    case 'list':
      return (
        <div
          className="my-1 flex gap-2"
          // 缩进跟着 Word 里的层级走。写成内联样式是因为层级是数据，
          // 而 Tailwind 是扫源码字符串生成样式的，拼出来的类名它看不见。
          style={{ marginInlineStart: `${String(block.level * 1.25)}rem` }}
        >
          <span aria-hidden className="mt-px min-w-[1.4em] flex-none select-none text-ink-faint">
            {marker ?? '•'}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap"><Spans spans={block.spans} /></span>
        </div>
      )

    case 'table':
      return (
        // 宽表格自己横向滚，绝不把整页顶宽。
        <div className="my-3 overflow-x-auto rounded-md border border-hairline">
          <table className="w-full border-collapse text-[12px]">
            <tbody>
              {block.rows.map((row, y) => (
                <tr key={y} className="border-b border-hairline/60 last:border-b-0">
                  {row.map((cell, x) => (
                    <td key={x} className="border-e border-hairline/60 px-2.5 py-1.5 align-top last:border-e-0">
                      <span className="whitespace-pre-wrap"><Spans spans={cell} /></span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    default:
      return <p className="my-2 whitespace-pre-wrap leading-relaxed"><Spans spans={block.spans} /></p>
  }
}

/**
 * 渲染一棵文档树。
 *
 * @param doc - 服务端翻好的块。
 */
export function RichDocView({ doc }: { doc: RichDoc }): React.JSX.Element {
  const t = useT()
  const markers = useMemo(() => markersOf(doc.blocks), [doc.blocks])

  if (doc.blocks.length === 0) {
    return <p className="cjk-label p-6 text-center">{t('preview.emptyDoc')}</p>
  }

  return (
    // 文档不是代码：给它一个可读的行宽。一行拉满整个面板，眼睛回不到下一行的行首。
    <div className="mx-auto max-w-[68ch] text-[13px] text-ink-dim">
      {doc.blocks.map((block, index) => (
        // 块也没有身份，位置就是它的身份 —— 这棵树是一次性读进来的，不会增删。
        <Block key={index} block={block} marker={markers[index] ?? null} />
      ))}
      {doc.truncated ? (
        <p className="cjk-label mt-4 border-t border-hairline pt-2 !text-lamp-fail">
          {t('preview.docTruncated')}
        </p>
      ) : null}
    </div>
  )
}
