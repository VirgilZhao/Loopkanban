import { useMemo } from 'react'
import { highlightLines, languageOf, type Language, type TokenKind } from '@/lib/highlight.ts'
import { cn } from '@/lib/utils.ts'

/**
 * 词元类别 → 颜色。`plain` 不给类，继承外面的正文色。
 *
 * 写成一张表而不是 `text-code-${kind}`：Tailwind 是**扫源码字符串**生成
 * 样式的，拼出来的类名它看不见，上线之后整块代码会是一片灰。
 */
const COLOR: Readonly<Record<TokenKind, string>> = {
  plain: '',
  comment: 'text-code-comment italic',
  string: 'text-code-string',
  number: 'text-code-number',
  keyword: 'text-code-keyword',
  type: 'text-code-type',
  func: 'text-code-func',
  prop: 'text-code-prop',
  tag: 'text-code-tag',
  attr: 'text-code-attr',
  punct: 'text-code-punct',
}

/**
 * 超过这个行数就整块退回一个朴素的 `<pre>`。
 *
 * 不是怕扫描慢（那是一次线性扫描），是怕 DOM。而**要省掉的是逐行那一层，
 * 不只是词元那一层**：行号栏要求每行自成一个 flex 行，于是一份 400KB 的
 * 日志（约一万七千行）光行容器就是三万多个节点，滚动直接卡成幻灯片。
 * 只把高亮关掉、行还照排，省不下这笔钱。
 *
 * 所以过了线就一个文本节点全部端出来 —— 没有行号、没有着色，但它是流畅的，
 * 而那么长的文件本来也不是用来"读"的。
 */
const MAX_LINES = 4000

interface Props {
  code: string
  /** 用来猜语言的文件名。给了 `language` 就不看它。 */
  name?: string
  language?: Language
  /** 显示行号。文件预览要，讨论里的代码块不要。 */
  gutter?: boolean
  className?: string
}

/**
 * 一块带语法高亮的代码。
 *
 * 高亮器是自己写的（见 `lib/highlight.ts`）—— 产出的是词元而不是 HTML
 * 字符串，所以文件内容里带着 `</span>` 也只是一段文字。
 */
const BASE = 'mono text-[11px] leading-[1.55] text-ink-dim'

export function CodeBlock({ code, name, language, gutter = false, className }: Props): React.JSX.Element {
  const lang = language ?? languageOf(name ?? '')
  const raw = useMemo(() => code.replace(/\r\n/g, '\n'), [code])
  // 行数先数一遍再决定要不要逐行铺 —— 铺完再发现太长，钱已经花掉了。
  const lines = useMemo(() => {
    const count = raw.length === 0 ? 0 : raw.split('\n').length
    return count > MAX_LINES ? null : highlightLines(raw, lang)
  }, [raw, lang])

  // 太长：一个文本节点了事。hook 都在上面调过了，这里提前返回是安全的。
  if (lines === null) {
    return <pre className={cn(BASE, 'whitespace-pre-wrap break-words', className)}>{raw}</pre>
  }

  // 行号栏的宽度按最大行号来，不然滚到一千行时正文会横着跳一格。
  const width = `${String(lines.length).length}ch`

  return (
    <pre className={cn(BASE, className)}>
      <code>
        {lines.map((tokens, index) => (
          // 行没有稳定身份可言（同一份文件里两行一模一样很常见），行号就是
          // 它的身份 —— 用下标做 key 在这里是对的，不是偷懒。
          <span key={index} className="flex">
            {gutter ? (
              <span
                aria-hidden
                style={{ width }}
                className="me-3 flex-none text-end text-ink-faint/60 select-none"
              >
                {index + 1}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {tokens.map((token, spot) => (
                token.kind === 'plain'
                  ? token.text
                  : <span key={spot} className={COLOR[token.kind]}>{token.text}</span>
              ))}
              {/* 空行也要占一行高，否则行号会和内容错位。 */}
              {tokens.length === 0 ? '\n' : null}
            </span>
          </span>
        ))}
      </code>
    </pre>
  )
}
