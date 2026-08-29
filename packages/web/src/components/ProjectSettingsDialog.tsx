import { useCallback, useEffect, useState } from 'react'
import {
  Check, ChevronRight, CornerLeftUp, File, FlaskConical, Folder, FolderOpen, GitBranch, X,
} from 'lucide-react'
import { api } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { maybe, useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { FileListing, Project } from '@/types.ts'

interface Props {
  project: Project
  /** 存好了把新项目交给调用方 —— 界面各处摆的都是它。 */
  onSaved: (project: Project) => void
  onClose: () => void
}

/**
 * 项目设置：项目的基本信息，加上测试环境（启动命令、要拷进 worktree 的
 * 配置文件）。
 *
 * 为什么收拢到项目上：同一个仓库怎么跑起来是**仓库的事实**，不是某张卡的；
 * 摆在任务弹窗里，等于每开一张卡都被人追问一遍配置。这里一次配好，所有卡
 * 的「启动测试环境」都照着它来。
 */
export function ProjectSettingsDialog({ project, onSaved, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(project.name)
  const [branch, setBranch] = useState(project.baseBranch)
  const [branches, setBranches] = useState<readonly string[]>([])
  const [command, setCommand] = useState(project.testCommand ?? '')
  const [files, setFiles] = useState<readonly string[]>(project.testEnvFiles ?? [])
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 基线分支只可选不可填：手打一个仓库里没有的名字，要等到第一次派活才炸。
  useEffect(() => {
    let stale = false
    void api.branches(project.repoPath)
      .then(({ branches: found }) => { if (!stale) setBranches(found) })
      .catch(() => { if (!stale) setBranches([]) })
    return () => { stale = true }
  }, [project.repoPath])

  const submit = (): void => {
    if (name.trim().length === 0 || branch.trim().length === 0) return
    setBusy(true)
    setError(null)
    void api.updateProject(project.id, {
      name: name.trim(),
      baseBranch: branch.trim(),
      testCommand: command.trim(),
      testEnvFiles: [...files],
    })
      .then(({ project: saved }) => { onSaved(saved); onClose() })
      .catch((failure: unknown) => {
        const code = (failure as { code?: string }).code ?? ''
        setError(maybe(t, `newProject.err.${code}`, (failure as Error).message))
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>{t('settings.hint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="settings-name">{t('newProject.name')}</Label>
            <Input
              id="settings-name"
              value={name}
              onChange={(event) => { setName(event.target.value) }}
            />
          </div>

          {/* 仓库路径是项目的身份 —— 只给看，不给改。换了仓库就是另一个项目。 */}
          <div className="space-y-2">
            <Label>{t('newProject.folder')}</Label>
            <p className="mono truncate rounded-md border border-hairline bg-void/40 px-3 py-2 text-xs text-ink-dim" title={project.repoPath}>
              {project.repoPath}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-base">{t('newProject.base')}</Label>
            {branches.length === 0 ? (
              <p className="flex items-start gap-1.5 text-xs text-ink-faint">
                <GitBranch className="mt-px size-3.5 flex-none" />
                {t('newProject.baseEmpty')}
              </p>
            ) : (
              <select
                id="settings-base"
                value={branch}
                onChange={(event) => { setBranch(event.target.value) }}
                className={cn(
                  'mono border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
                  'transition-[color,box-shadow] outline-none dark:bg-input/30',
                  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                )}
              >
                {/* 现在配的基线不在列表里（比如分支被删了）也要摆出来，不然一保存就被换掉。 */}
                {branches.includes(branch) ? null : <option value={branch}>{branch}</option>}
                {branches.map((candidate) => (
                  <option key={candidate} value={candidate}>{candidate}</option>
                ))}
              </select>
            )}
            <p className="text-xs text-ink-faint">{t('newProject.baseHint')}</p>
          </div>

          <div className="space-y-2 border-t border-hairline pt-4">
            <Label htmlFor="settings-command">
              <FlaskConicalLabel />{t('testenv.title')} · {t('testenv.commandLabel')}
            </Label>
            <Input
              id="settings-command"
              value={command}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('testenv.commandPlaceholder')}
              className="mono text-xs"
              onChange={(event) => { setCommand(event.target.value) }}
            />
            <p className="text-xs text-ink-faint">{t('testenv.commandHint')}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label className="flex-none">{t('testenv.filesLabel')}</Label>
              <span className="flex-1" />
              <Button size="sm" variant={browsing ? 'default' : 'outline'} onClick={() => { setBrowsing(!browsing) }}>
                <FolderOpen />{t('testenv.filesBrowse')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {files.length === 0 ? (
                <span className="text-xs text-ink-faint">{t('testenv.filesNone')}</span>
              ) : files.map((file) => (
                <span
                  key={file}
                  className="mono flex items-center gap-1 rounded-md border border-sodium/50 bg-sodium/10 px-1.5 py-0.5 text-[10px] text-sodium"
                >
                  {file}
                  <button
                    type="button"
                    title={t('testenv.filesRemove', { file })}
                    aria-label={t('testenv.filesRemove', { file })}
                    onClick={() => { setFiles(files.filter((entry) => entry !== file)) }}
                    className="transition-colors hover:text-lamp-fail"
                  ><X className="size-2.5" /></button>
                </span>
              ))}
            </div>
            {browsing ? (
              <RepoFileBrowser
                repoPath={project.repoPath}
                selected={files}
                onToggle={(file) => {
                  setFiles((prev) => (prev.includes(file) ? prev.filter((entry) => entry !== file) : [...prev, file]))
                }}
              />
            ) : null}
            <p className="text-xs text-ink-faint">{t('testenv.filesHint')}</p>
          </div>

          {error === null ? null : (
            <p className="rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2 text-xs leading-relaxed text-lamp-fail">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('newProject.cancel')}</Button>
          <Button size="sm" disabled={busy || name.trim().length === 0} onClick={submit}>
            {t('testenv.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 小图标不用绕 Label 的 htmlFor：它只是个装饰。 */
function FlaskConicalLabel(): React.JSX.Element {
  return <FlaskConical className="mr-1 inline size-3.5 -translate-y-px text-sodium" />
}

/**
 * 仓库文件浏览器：目录点进去，文件点一下就入选/摘除。
 *
 * 逛的是**服务端**的主工作区（`/api/files` 的围栏把它框在已登记仓库里）；
 * 交给 `onToggle` 的是相对仓库根的路径 —— 拷贝那一侧记的就是它。
 */
export function RepoFileBrowser({ repoPath, selected, onToggle }: {
  repoPath: string
  selected: readonly string[]
  onToggle: (file: string) => void
}): React.JSX.Element {
  const t = useT()
  const [listing, setListing] = useState<FileListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback((path?: string) => {
    setError(null)
    void api.files(repoPath, path)
      .then(setListing)
      .catch((failure: unknown) => { setError((failure as Error).message) })
  }, [repoPath])

  useEffect(() => { open() }, [open])

  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={listing?.parent == null}
          title={t('testenv.filesUp')}
          aria-label={t('testenv.filesUp')}
          onClick={() => { if (listing?.parent != null) open(listing.parent) }}
          className="flex size-5 flex-none items-center justify-center rounded-md border border-hairline text-ink-faint transition-colors hover:border-sodium hover:text-sodium disabled:opacity-40"
        >
          <CornerLeftUp className="size-3" />
        </button>
        <span className="mono min-w-0 flex-1 truncate text-[10px] text-ink-faint" title={listing?.relative}>
          /{listing?.relative ?? ''}
        </span>
      </div>
      <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-hairline">
        {error !== null ? (
          <p className="p-3 text-center text-xs text-lamp-fail">{error}</p>
        ) : listing === null ? (
          <p className="p-3 text-center text-xs text-ink-faint">{t('picker.loading')}</p>
        ) : listing.entries.length === 0 ? (
          <p className="p-3 text-center text-xs text-ink-faint">{t('picker.emptyDir')}</p>
        ) : listing.entries.map((entry) => {
          // 服务端给的是绝对路径，存进配置要的是相对仓库根的 —— 就地换算。
          const relative = listing.relative.length === 0 ? entry.name : `${listing.relative}/${entry.name}`
          const picked = selected.includes(relative)
          return entry.kind === 'dir' ? (
            <button
              key={entry.path}
              type="button"
              onClick={() => { open(entry.path) }}
              className="flex w-full items-center gap-2 border-b border-hairline/60 px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-raised"
            >
              <Folder className="size-3.5 flex-none text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
              <ChevronRight className="size-3 flex-none text-ink-faint" />
            </button>
          ) : (
            <button
              key={entry.path}
              type="button"
              onClick={() => { onToggle(relative) }}
              className={cn(
                'flex w-full items-center gap-2 border-b border-hairline/60 px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-raised',
                picked ? 'text-sodium' : 'text-ink-dim',
              )}
            >
              <File className="size-3.5 flex-none" />
              <span className="mono min-w-0 flex-1 truncate text-[11px]">{entry.name}</span>
              <Check className={cn('size-3 flex-none', picked ? 'opacity-100' : 'opacity-0')} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
