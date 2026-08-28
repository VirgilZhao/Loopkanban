import { useEffect, useRef, useState } from 'react'
import { FileText, X } from 'lucide-react'
import { api, ApiError } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { maybe, useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { resolveFrom } from '@/lib/path.ts'
import type { FilePreview as Preview } from '@/types.ts'

/** 按 Markdown 渲染的扩展名。别的都当纯文本，原样等宽显示。 */
const MARKDOWN = /\.(md|markdown|mdx)$/i

/** 字节数写成人看的样子。单位不分语言，不必进文案表。 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 文档预览：盖在任务弹窗上的一层。
 *
 * 为什么是盖一层而不是再开一个 Dialog：预览是**在读这条讨论的过程中**顺手
 * 打开的，退出去要回到原来那条讨论、原来那个滚动位置。嵌套弹窗会把焦点和
 * esc 的归属搅在一起 —— esc 该关的是预览，不是整张卡（这一下由
 * `RunPanel` 统一拦，它才同时看得见两层）。
 */
export function FilePreviewPane({ taskId, path, onOpen, onClose }: {
  taskId: string
  /** 要看的路径。绝对或相对于工作区根。 */
  path: string
  /** 预览里的链接又点开了另一份文档。 */
  onOpen: (path: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [file, setFile] = useState<Preview | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)

  // 焦点跟着预览走。刚点过的那个链接下一刻就随底下那块一起 inert 了，
  // 不主动接手的话焦点会掉到 body 上，键盘一时无处可去。换一份文档同理。
  useEffect(() => { paneRef.current?.focus() }, [path])

  useEffect(() => {
    let cancelled = false
    setFile(null)
    setFailed(null)
    void api.file(taskId, path)
      .then(({ file: loaded }) => { if (!cancelled) setFile(loaded) })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailed(error instanceof ApiError
          ? maybe(t, `err.${error.code}`, `${error.code} · ${error.message}`)
          : String(error))
      })
    return () => { cancelled = true }
  }, [taskId, path, t])

  const markdown = file !== null && MARKDOWN.test(file.name)

  return (
    <div ref={paneRef} tabIndex={-1} className="absolute inset-0 z-30 flex flex-col bg-panel outline-none">
      <header className="flex flex-none items-start gap-2 border-b border-hairline px-4 py-3">
        <FileText className="mt-[3px] size-4 flex-none text-sodium" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{file?.name ?? path}</p>
          <p className="mono truncate text-[10px] text-ink-faint" title={file?.path ?? path}>
            {file === null ? path : `${file.relative} · ${humanSize(file.size)}`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('preview.close')} title={t('preview.close')}>
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {failed !== null ? (
          <p className="p-6 text-center text-xs leading-relaxed text-lamp-fail">{failed}</p>
        ) : file === null ? (
          <p className="cjk-label p-6 text-center">{t('preview.loading')}</p>
        ) : markdown ? (
          <div className="text-[13px]">
            {/* 文档里的相对链接是相对这份文档说的，接好了再往下传。 */}
            {renderMarkdown(file.content, {
              onOpenFile: (next) => { onOpen(resolveFrom(file.path, next)) },
            })}
          </div>
        ) : (
          <pre className="mono whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-dim">
            {file.content}
          </pre>
        )}
      </div>

      {file?.truncated === true ? (
        <p className="cjk-label flex-none border-t border-hairline px-4 py-2 !text-lamp-fail">
          {t('preview.truncated')}
        </p>
      ) : null}
    </div>
  )
}
