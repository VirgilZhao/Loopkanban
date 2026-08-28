import { useEffect, useState } from 'react'
import { CodeBlock } from '@/components/CodeBlock.tsx'
import { RichDocView } from '@/components/RichDocView.tsx'
import { useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { cn } from '@/lib/utils.ts'
import type { FileKind, RichDoc } from '@/types.ts'

/**
 * 一份文件的正文，按它自己的方式呈现。
 *
 * 两个地方要看文件 —— 任务弹窗右边那一栏（Agent 在讨论里给的文档链接），
 * 以及文件浏览页的右半边。它们的取数接口不同、围栏不同，**呈现方式必须
 * 相同**：同一份 `.md` 在两处一个渲染一个是原文，只会让人以为自己看错了。
 * 所以呈现集中在这里，两边只管把数据递进来。
 *
 * 怎么呈现由服务端定的 `kind` 说了算（见 host 的 `docs/kind.ts`）：
 *
 * - `markdown` 渲染结果与原文之间可以切 —— 读方案要看渲染后的，
 *   核对 Agent 到底写了什么字则要看原文
 * - `text` 语法高亮 + 行号
 * - `pdf` / `image` 交给浏览器自己（字节走 raw 口子，不进 JSON）
 * - `docx` 服务端翻好的文档树
 * - `binary` 如实说看不了
 */

interface Props {
  /** 文件名，用来猜语言、以及给 `<iframe>` 一个标题。 */
  name: string
  kind: FileKind
  /** 正文。`pdf` / `image` / `docx` 是空串。 */
  content: string
  doc?: RichDoc | undefined
  /** 正文被截断了，底下要挂一句说明。 */
  truncated: boolean
  /**
   * 原始字节的地址，`pdf` 与 `image` 靠它。
   *
   * 给 null 表示这个来源没有 raw 口子 —— 那就退化成一句「这儿看不了」，
   * 而不是一个永远转不出来的空白框。
   */
  rawUrl: string | null
  /** Markdown 里的本机文件链接被点开了。不给则这类链接退化成纯文本。 */
  onOpenFile?: ((path: string) => void) | undefined
}

/** Markdown 的两种看法。 */
type Mode = 'preview' | 'source'

export function FileView({ name, kind, content, doc, truncated, rawUrl, onOpenFile }: Props): React.JSX.Element {
  const t = useT()
  const [mode, setMode] = useState<Mode>('preview')

  // 换了一份文件就回到渲染视图。上一份是为了核对字面才切到原文的，
  // 那个意图不该跟着传给下一份。
  useEffect(() => { setMode('preview') }, [name, content])

  /** 顶上的小切换条。只有 Markdown 有两种看法，别的都不出现。 */
  const toolbar = kind !== 'markdown' ? null : (
    <div className="flex flex-none items-center gap-1 border-b border-hairline px-3 py-1.5">
      {(['preview', 'source'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => { setMode(option) }}
          aria-pressed={mode === option}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] transition-colors',
            mode === option ? 'bg-raised text-ink' : 'text-ink-faint hover:text-sodium',
          )}
        >
          {t(option === 'preview' ? 'preview.rendered' : 'preview.source')}
        </button>
      ))}
    </div>
  )

  /*
   * PDF 与图片自己占满整格，**不套滚动容器** —— 浏览器的 PDF 阅读器有它
   * 自己的滚动条和工具栏，外面再包一层只会变成两条滚动条互相打架。
   */
  if (kind === 'pdf' || kind === 'image') {
    if (rawUrl === null) {
      return <p className="cjk-label flex flex-1 items-center justify-center p-6">{t('preview.noRaw')}</p>
    }
    return kind === 'pdf' ? (
      /*
       * 直接 iframe，没有 sandbox。
       *
       * 敢这么做是因为**类型在服务端就是一份允许清单**：那个口子只吐图片和
       * PDF，还带着 `nosniff`，所以这里根本不可能加载到一份会执行的东西。
       * 反过来，加上 sandbox 会把 Firefox 的 pdf.js 一并关掉（它要脚本），
       * 换来的是一个空白框 —— 防的是一个已经不存在的风险。
       */
      <iframe src={rawUrl} title={name} className="min-h-0 flex-1 border-0 bg-sunken" />
    ) : (
      <div className="min-h-0 flex-1 overflow-auto bg-sunken/40 p-4">
        <img src={rawUrl} alt={name} className="mx-auto max-w-full" />
      </div>
    )
  }

  // `docx` 却没有文档树，与二进制是同一件事：这份文件在这儿看不了。
  const unreadable = kind === 'binary' || (kind === 'docx' && doc === undefined)

  const body = unreadable ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="cjk-label">{t('preview.binary')}</p>
      {/* 旧版 `.doc` 是二进制的私有格式，不是 zip —— 单独说一句，免得人
          对着一份明明是 Word 的文件反复点。 */}
      {/\.doc$/i.test(name) ? <p className="cjk-label">{t('preview.legacyDoc')}</p> : null}
    </div>
  ) : doc !== undefined ? (
    <RichDocView doc={doc} />
  ) : kind === 'markdown' && mode === 'preview' ? (
    <div className="text-[13px]">
      {renderMarkdown(content, onOpenFile === undefined ? {} : { onOpenFile })}
    </div>
  ) : (
    <CodeBlock code={content} name={name} gutter />
  )

  return (
    <>
      {toolbar}
      <div className={cn('min-h-0 flex-1 overflow-auto', unreadable ? 'flex' : 'px-3 py-2')}>
        {body}
      </div>
      {/*
        * 只有真给出了正文才谈得上"截断"。
        *
        * 看不了的那一格什么都没渲染，再挂一句"只显示了前一部分"就是自相矛盾；
        * 文档树则自己会说它被截了（见 `RichDocView`），这儿再说一遍是两条。
        */}
      {truncated && !unreadable && kind !== 'docx' ? (
        <p className="cjk-label flex-none border-t border-hairline px-3 py-2 !text-lamp-fail">
          {t('preview.truncated')}
        </p>
      ) : null}
    </>
  )
}
