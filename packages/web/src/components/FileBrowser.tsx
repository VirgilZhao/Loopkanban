import { useCallback, useEffect, useMemo, useState } from 'react'
import { CornerLeftUp, File, FileCode, FileText, Folder, GitBranch, RefreshCw } from 'lucide-react'
import { api, ApiError } from '@/api.ts'
import { Terminal } from '@/components/Terminal.tsx'
import { maybe, useT, type Translate } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { FileContent, FileEntry, FileListing, Project, Workspace } from '@/types.ts'

/** 一眼能认出是代码的后缀，给它一个不同的图标。纯装饰，认不出就用通用的。 */
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'html', 'py', 'go', 'rs', 'java', 'rb',
  'sh', 'zsh', 'yml', 'yaml', 'toml', 'sql', 'c', 'h', 'cpp', 'swift', 'kt', 'php',
])

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'log', 'gitignore', 'env'])

function iconFor(name: string): typeof File {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? ''
  if (CODE_EXT.has(ext)) return FileCode
  if (TEXT_EXT.has(ext)) return FileText
  return File
}

/** 文件大小。给人看的，不追求精确到字节。 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 工作区在下拉框里叫什么：主仓库，或者某张卡的 worktree。 */
function workspaceLabel(t: Translate, space: Workspace): string {
  const name = space.kind === 'repo' ? t('files.repo') : t('files.worktree', { taskId: space.taskId ?? '?' })
  return `${name} · ${space.branch ?? t('files.detached')}`
}

interface Props {
  project: Project
}

/**
 * 文件浏览页。
 *
 * 逛的是**服务端**的文件系统，且只在这个项目的仓库里面 —— 围栏画在后端
 * （见 host 的 `server/files.ts`），前端这边只是把它如实呈现：在根上时
 * 「上一级」直接灰掉，而不是点了才被拒绝。
 *
 * 工作区切换是这一页真正的价值所在。Agent 从来不在主仓库里干活，它在
 * `.loopkanban/worktrees/<卡号>/` 里 —— 那才是「它到底改了什么」的现场，
 * 而 diff 只能告诉你结果、告诉不了你现在的样子。
 */
export function FileBrowser({ project }: Props): React.JSX.Element {
  const t = useT()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [root, setRoot] = useState<string | null>(null)
  const [listing, setListing] = useState<FileListing | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [termOpen, setTermOpen] = useState(false)

  // 服务端的 detail 是中文的，英文界面下直接端出来只会是一句看不懂的话。
  // 认得的码按当前语言说，认不得的连码带原文一起给 —— 咽掉它更没用。
  const fail = useCallback((failure: unknown) => {
    setError(failure instanceof ApiError
      ? maybe(t, `err.${failure.code}`, `${failure.code} · ${failure.message}`)
      : String(failure))
  }, [t])

  // 换项目就整个重来：上一个仓库的工作区、目录、选中的文件，对这一个都没有意义。
  useEffect(() => {
    let cancelled = false
    setWorkspaces([])
    setRoot(null)
    setListing(null)
    setFile(null)
    setError(null)
    void api.workspaces(project.id)
      .then(({ workspaces: found }) => {
        if (cancelled) return
        setWorkspaces(found)
        // 默认落在主仓库上 —— 它总在第一个，且总存在。
        setRoot(found[0]?.path ?? null)
      })
      .catch((failure: unknown) => { if (!cancelled) fail(failure) })
    return () => { cancelled = true }
  }, [project.id, fail])

  /** 打开一个目录。不给 path 就是工作区根。 */
  const open = useCallback((at: string, path?: string) => {
    setBusy(true)
    setError(null)
    void api.files(at, path)
      .then((next) => { setListing(next) })
      .catch((failure: unknown) => { fail(failure); setListing(null) })
      .finally(() => { setBusy(false) })
  }, [fail])

  /*
   * 换工作区就回到它的根：上一个工作区里的路径在这一个里未必存在。
   *
   * `listing` 也要一起清掉，不能只清 `file`：终端的 cwd 取自 `listing.path`，
   * 留着旧的，在新目录到位之前那一小会儿，命令会带着新 root、旧 cwd 出去 ——
   * 从 worktree 切回主仓库时这两者恰好都通得过围栏，于是命令**静悄悄跑在了
   * 上一个 worktree 里**，而提示符上写的是另一个地方。
   */
  useEffect(() => {
    if (root === null) return
    setFile(null)
    setListing(null)
    open(root)
  }, [root, open])

  const readFile = useCallback((entry: FileEntry) => {
    if (root === null) return
    setError(null)
    void api.fileContent(root, entry.path)
      .then((next) => { setFile(next) })
      .catch((failure: unknown) => { fail(failure); setFile(null) })
  }, [root, fail])

  /**
   * 面包屑。每一段都能点回去。
   *
   * 相对路径由服务端算好，用平台自己的分隔符 —— 这里两种都切，免得在
   * Windows 上整条路径挤成一格。
   */
  const crumbs = useMemo(() => {
    if (listing === null || root === null) return []
    const parts = listing.relative.split(/[/\\]/).filter((part) => part.length > 0)
    let at = root
    return parts.map((part) => {
      at = `${at}/${part}`
      return { name: part, path: at }
    })
  }, [listing, root])

  const here = listing?.path ?? root ?? project.repoPath
  const where = listing === null || listing.relative.length === 0 ? t('files.root') : listing.relative

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 工作区 + 面包屑 ─────────────────────────────────── */}
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
        <GitBranch className="size-3.5 flex-none text-ink-faint" />
        <select
          value={root ?? ''}
          disabled={workspaces.length === 0}
          aria-label={t('files.workspace')}
          title={t('files.workspaceHint')}
          onChange={(event) => { setRoot(event.target.value) }}
          className={cn(
            'mono h-6 max-w-[15rem] flex-none rounded-md border border-hairline bg-transparent px-1 text-[10px] text-ink',
            'outline-none focus-visible:border-ring disabled:opacity-50',
          )}
        >
          {workspaces.map((space) => (
            <option key={space.path} value={space.path}>{workspaceLabel(t, space)}</option>
          ))}
        </select>

        <span className="h-4 w-px flex-none bg-hairline" />

        <button
          type="button"
          disabled={busy || listing === null || listing.parent === null}
          title={listing === null || listing.parent === null ? t('files.rootHint') : t('files.up')}
          aria-label={t('files.up')}
          onClick={() => { if (root !== null && listing?.parent != null) open(root, listing.parent) }}
          className={cn(
            'flex size-6 flex-none items-center justify-center rounded-md border border-hairline text-ink-faint',
            'transition-colors hover:border-sodium hover:text-sodium',
            'disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-faint',
          )}
        >
          <CornerLeftUp className="size-3" />
        </button>

        {/* 面包屑。长路径往左溢出，最后几段（也就是你在哪儿）永远留在视野里。 */}
        <nav className="mono flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[10px] whitespace-nowrap">
          <button
            type="button"
            onClick={() => { if (root !== null) open(root) }}
            className="flex-none rounded-sm px-1 text-ink-faint hover:text-sodium"
          >
            {t('files.root')}
          </button>
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex flex-none items-center gap-1">
              <span className="text-ink-faint/50">/</span>
              <button
                type="button"
                onClick={() => { if (root !== null) open(root, crumb.path) }}
                className={cn(
                  'rounded-sm px-1 hover:text-sodium',
                  index === crumbs.length - 1 ? 'text-ink' : 'text-ink-faint',
                )}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <button
          type="button"
          disabled={busy || root === null}
          title={t('files.reloadHint')}
          aria-label={t('files.reload')}
          onClick={() => {
            if (root === null) return
            open(root, listing?.path)
            // 打开着的文件也要跟着重读 —— 不然目录是新的、正文还是旧的。
            if (file !== null) void api.fileContent(root, file.path).then(setFile).catch(fail)
          }}
          className={cn(
            'flex size-6 flex-none items-center justify-center rounded-md border border-hairline text-ink-faint',
            'transition-colors hover:border-sodium hover:text-sodium disabled:opacity-40',
          )}
        >
          <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
        </button>
      </div>

      {error === null ? null : (
        <p className="flex-none border-b border-lamp-fail/40 bg-lamp-fail/[0.07] px-3 py-1.5 text-lamp-fail">
          {error}
        </p>
      )}

      {/* ── 目录（左） + 正文（右） ─────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <div className="w-64 flex-none overflow-y-auto border-r border-hairline">
          {/* 出错时不说"读取中" —— 那是在等一件已经不会发生的事，而上面的
              横幅已经把原因说清楚了。 */}
          {listing === null ? (
            error !== null ? null : <p className="p-4 text-center text-xs text-ink-faint">{t('files.loading')}</p>
          ) : listing.entries.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-faint">{t('files.empty')}</p>
          ) : listing.entries.map((entry) => {
            const Icon = entry.kind === 'dir' ? Folder : iconFor(entry.name)
            const active = entry.kind === 'file' && file?.path === entry.path
            return (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                onClick={() => {
                  if (entry.kind === 'dir') { if (root !== null) open(root, entry.path) } else readFile(entry)
                }}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-hairline/40 px-3 py-1.5 text-left',
                  'transition-colors last:border-b-0 hover:bg-raised/60',
                  active && 'bg-raised',
                )}
              >
                <Icon className={cn('size-3.5 flex-none', entry.kind === 'dir' ? 'text-sodium' : 'text-ink-faint')} />
                <span className={cn('min-w-0 flex-1 truncate text-xs', active ? 'text-ink' : 'text-ink-dim')}>
                  {entry.name}
                </span>
                {entry.kind === 'file' ? (
                  <span className="mono flex-none text-[9px] text-ink-faint">{humanSize(entry.size)}</span>
                ) : null}
              </button>
            )
          })}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {file === null ? (
            <p className="flex flex-1 items-center justify-center text-xs text-ink-faint">
              {t('files.pickFile')}
            </p>
          ) : (
            <>
              <header className="flex h-8 flex-none items-center gap-2 border-b border-hairline px-3">
                <span className="mono min-w-0 flex-1 truncate text-[11px] text-ink" title={file.path}>
                  {file.relative}
                </span>
                <span className="mono flex-none text-[10px] text-ink-faint">{humanSize(file.size)}</span>
              </header>
              {file.binary ? (
                <p className="flex flex-1 items-center justify-center text-xs text-ink-faint">
                  {t('files.binary')}
                </p>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto">
                  <pre className="mono px-3 py-2 text-[11px] leading-[1.55] text-ink-dim">{file.content}</pre>
                  {file.truncated ? (
                    <p className="cjk-label px-3 pb-2 !text-lamp-fail">{t('files.truncated')}</p>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {root === null ? null : (
        <Terminal
          root={root}
          cwd={here}
          where={where}
          open={termOpen}
          onToggle={() => { setTermOpen((on) => !on) }}
        />
      )}
    </div>
  )
}
