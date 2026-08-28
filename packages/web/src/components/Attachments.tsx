import { useCallback, useEffect, useRef, useState } from 'react'
import { File, FileImage, FileText, Paperclip, Upload, X } from 'lucide-react'
import { api, ApiError, attachmentUrl } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { Attachment } from '@/types.ts'

/** 与服务端 `MAX_ATTACHMENTS_PER_TASK` 对齐。超了服务端也会拒，这里只是先说一声。 */
const MAX = 20

/** 人看得懂的大小。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  taskId: string
  /** 正在执行或已归档的卡：附件是需求的一部分，跟着一起冻结。 */
  locked: boolean
  onError: (code: string, detail: string) => void
  /** 传完 / 删完通知外面刷新看板，卡片上那枚回形针的数字才跟得上。 */
  onChanged: () => void
}

/**
 * 附件区：传文件、看文件、删文件。
 *
 * **不进草稿**：传上去就是传上去了，不等"保存"。附件是一份实实在在的文件，
 * 传了却因为没点保存而丢掉，是最让人恼火的那种意外；而且卡片本来就是先落地
 * 再慢慢写的，附件也该照这个节奏。
 */
export function Attachments({ taskId, locked, onError, onChanged }: Props): React.JSX.Element {
  const t = useT()
  const [files, setFiles] = useState<Attachment[]>([])
  /** 正在上传的文件名。一个一个传，进度就是"轮到谁了"。 */
  const [uploading, setUploading] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void api.attachments(taskId)
      .then(({ attachments }) => { if (!cancelled) setFiles(attachments) })
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [taskId])

  const upload = useCallback((picked: FileList | null): void => {
    if (picked === null || picked.length === 0) return
    void (async () => {
      // 一个一个传，不并发：一次拖十个文件并发上去，服务端要同时把十份
      // 字节读进内存，而这里本来就没有"快"的需求。
      for (const file of Array.from(picked)) {
        setUploading(file.name)
        try {
          const created = await api.upload(taskId, file)
          setFiles((prev) => [...prev, created])
        } catch (error) {
          if (error instanceof ApiError) onError(error.code, error.message)
          // 一个文件传失败就停下：多半是超限或者卡被锁住了，
          // 剩下的接着传只会连着弹同一条错误。
          break
        } finally {
          setUploading(null)
        }
      }
      onChanged()
    })()
  }, [taskId, onError, onChanged])

  const remove = (attachment: Attachment): void => {
    void api.removeAttachment(attachment.id)
      .then(() => {
        setFiles((prev) => prev.filter((item) => item.id !== attachment.id))
        onChanged()
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) onError(error.code, error.message)
      })
  }

  const full = files.length >= MAX
  const disabled = locked || full || uploading !== null

  return (
    <div className="space-y-2">
      {files.length > 0 ? (
        <ul className="space-y-1.5">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5"
            >
              {/* 图片给个缩略图：一屏里认出"是哪张截图"，比读文件名快得多。 */}
              {file.mime.startsWith('image/') ? (
                <img
                  src={attachmentUrl(file.id)}
                  alt=""
                  className="size-8 flex-none rounded border border-hairline object-cover"
                />
              ) : (
                <span className="flex size-8 flex-none items-center justify-center rounded border border-hairline text-ink-faint">
                  <Icon mime={file.mime} />
                </span>
              )}
              <a
                href={attachmentUrl(file.id)}
                target="_blank"
                rel="noreferrer"
                title={t('editor.attachmentsOpen')}
                className="min-w-0 flex-1 truncate text-[13px] text-ink hover:text-sodium hover:underline"
              >
                {file.filename}
              </a>
              <span className="mono flex-none text-[10px] text-ink-faint">{humanSize(file.size)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={locked}
                aria-label={t('editor.attachmentsRemove')}
                title={t('editor.attachmentsRemove')}
                onClick={() => { remove(file) }}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-faint">{t('editor.attachmentsEmpty')}</p>
      )}

      {/* 锁住时连投放区都不给：与其让人拖进来再吃一条 422，不如直接说清楚。 */}
      {locked ? (
        <p className="text-xs text-ink-faint">{t('editor.attachmentsLocked')}</p>
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => { inputRef.current?.click() }}
            onDragOver={(event) => {
              event.preventDefault()
              if (!disabled) setDragOver(true)
            }}
            onDragLeave={() => { setDragOver(false) }}
            onDrop={(event) => {
              event.preventDefault()
              setDragOver(false)
              if (!disabled) upload(event.dataTransfer.files)
            }}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-hairline',
              'px-3 py-4 text-xs text-ink-faint transition-colors',
              'hover:border-hairline-bright hover:text-ink',
              'disabled:cursor-not-allowed disabled:opacity-50',
              dragOver && 'border-sodium-deep bg-sodium/[0.06] text-sodium',
            )}
          >
            {uploading === null ? (
              <>
                {dragOver ? <Upload className="size-3.5" /> : <Paperclip className="size-3.5" />}
                {dragOver ? t('editor.attachmentsDropActive') : t('editor.attachmentsDrop')}
              </>
            ) : (
              <>
                <Upload className="size-3.5 animate-pulse" />
                {t('editor.attachmentsUploading', { name: uploading })}
              </>
            )}
          </button>
          {full ? <p className="text-xs text-sodium">{t('editor.attachmentsFull', { max: MAX })}</p> : null}
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              upload(event.target.files)
              // 清空，否则同一个文件第二次选不会触发 change。
              event.target.value = ''
            }}
          />
        </>
      )}
    </div>
  )
}

/**
 * 一个附件的紧凑样子：缩略图 / 图标 + 文件名 + 大小，一行里能并排摆好几个。
 *
 * 讨论里的输入框底下和留言气泡里摆的是同一种东西，所以只画一次 —— 两处
 * 各写一遍的结果一定是它们慢慢长歪。上面那个竖排列表是规格表单的样子，
 * 那儿一屏只有几个文件，摆得开。
 *
 * @param file - 要显示的附件。
 * @param onRemove - 给了才有那个叉。已经跟着留言发出去的附件撤不回来
 *   （讨论是一份记录），所以旧留言里的那些不给。
 */
export function AttachmentChip({ file, onRemove, removeLabel }: {
  file: Attachment
  onRemove?: (() => void) | undefined
  removeLabel?: string
}): React.JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-hairline bg-sunken/40 py-1 pl-1 pr-2">
      {/* 图片给缩略图：一眼认出"是哪张截图"，比读文件名快得多。 */}
      {file.mime.startsWith('image/') ? (
        <img
          src={attachmentUrl(file.id)}
          alt=""
          className="size-6 flex-none rounded border border-hairline object-cover"
        />
      ) : (
        <span className="flex size-6 flex-none items-center justify-center text-ink-faint">
          <Icon mime={file.mime} />
        </span>
      )}
      <a
        href={attachmentUrl(file.id)}
        target="_blank"
        rel="noreferrer"
        title={file.filename}
        className="max-w-[13rem] truncate text-[12px] text-ink hover:text-sodium hover:underline"
      >
        {file.filename}
      </a>
      <span className="mono flex-none text-[10px] text-ink-faint">{humanSize(file.size)}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="flex-none text-ink-faint transition-colors hover:text-lamp-fail"
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  )
}

/** 按类型给个能一眼分辨的图标。认不出来的走通用文件。 */
function Icon({ mime }: { mime: string }): React.JSX.Element {
  if (mime.startsWith('image/')) return <FileImage className="size-4" />
  if (mime === 'application/pdf' || mime.startsWith('text/') || mime.includes('word') || mime.includes('document')) {
    return <FileText className="size-4" />
  }
  return <File className="size-4" />
}
