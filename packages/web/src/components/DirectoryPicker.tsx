import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, CornerLeftUp, Folder, FolderGit2, House } from 'lucide-react'
import { api } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { DirListing } from '@/types.ts'

interface Props {
  /** 从哪儿开始逛；空的话由服务端给家目录。 */
  start?: string | undefined
  onPick: (path: string) => void
  onCancel: () => void
}

/**
 * 本机目录选择框。
 *
 * 逛的是**服务端**的文件系统 —— 浏览器自己的 `showDirectoryPicker()` 只给
 * 句柄不给路径，而服务端要的正是路径。
 */
export function DirectoryPicker({ start, onPick, onCancel }: Props): React.JSX.Element {
  const t = useT()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)

  const open = useCallback((path?: string) => {
    setBusy(true)
    setError(null)
    void api.browse(path)
      .then((next) => { setListing(next) })
      .catch((failure: unknown) => { setError((failure as Error).message) })
      .finally(() => { setBusy(false) })
  }, [])

  useEffect(() => { open(start) }, [open, start])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 当前位置 + 上一级。路径可能很长，所以它自己占一行并且可横向滚动。 */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('picker.up')}
          title={t('picker.up')}
          disabled={busy || listing?.parent === null || listing === null}
          onClick={() => { if (listing?.parent != null) open(listing.parent) }}
        >
          <CornerLeftUp />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('picker.home')}
          title={t('picker.home')}
          disabled={busy}
          onClick={() => { open() }}
        >
          <House />
        </Button>
        <p className="mono min-w-0 flex-1 truncate text-xs text-ink-faint" title={listing?.path}>
          {listing?.path ?? '…'}
        </p>
      </div>

      <div className="h-56 overflow-y-auto rounded-md border border-hairline">
        {error !== null ? (
          <p className="p-4 text-center text-xs text-lamp-fail">{error}</p>
        ) : listing === null ? (
          <p className="p-4 text-center text-xs text-ink-faint">{t('picker.loading')}</p>
        ) : listing.entries.length === 0 ? (
          <p className="p-4 text-center text-xs text-ink-faint">{t('picker.emptyDir')}</p>
        ) : listing.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            // 单击进去；要选中当前这一层，用下面那颗按钮 —— 两个动作分开，
            // 免得"想进去"变成"选错了"。
            onClick={() => { open(entry.path) }}
            className={cn(
              'flex w-full items-center gap-2 border-b border-hairline/60 px-3 py-2 text-left text-sm',
              'transition-colors last:border-b-0 hover:bg-raised',
            )}
          >
            {entry.isRepo
              ? <FolderGit2 className="size-4 flex-none text-sodium" />
              : <Folder className="size-4 flex-none text-ink-faint" />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.isRepo ? <span className="chrome-label !text-[8px] !text-sodium">git</span> : null}
            <ChevronRight className="size-3.5 flex-none text-ink-faint" />
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        {/* 只有 git 仓库能当项目，但这里不拦 —— 拦了用户就不知道自己错在哪，
            让服务端把话说清楚。 */}
        <p className="min-w-0 flex-1 text-xs text-ink-faint">
          {listing?.isRepo === true ? t('picker.isRepo') : t('picker.notRepo')}
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('picker.back')}</Button>
        <Button
          size="sm"
          disabled={busy || listing === null}
          onClick={() => { if (listing !== null) onPick(listing.path) }}
        >
          {t('picker.pick')}
        </Button>
      </div>
    </div>
  )
}
