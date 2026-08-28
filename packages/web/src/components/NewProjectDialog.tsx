import { useEffect, useState } from 'react'
import { FolderGit2, FolderOpen, GitBranch } from 'lucide-react'
import { api } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { DirectoryPicker } from '@/components/DirectoryPicker.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { maybe, useT } from '@/lib/i18n.tsx'
import { basename } from '@/lib/path.ts'
import { cn } from '@/lib/utils.ts'
import type { BranchListing, Project } from '@/types.ts'

interface Props {
  onCreated: (project: Project) => void
  onClose: () => void
  onSubmit: (input: { name: string; path: string; baseBranch?: string }) => Promise<Project>
}

export function NewProjectDialog({ onCreated, onClose, onSubmit }: Props): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listing, setListing] = useState<BranchListing | null>(null)
  const [branch, setBranch] = useState('')

  /*
   * 路径一确定就把分支拉过来。
   *
   * 基线是**建项目时就定死**的东西：之后每张卡都从它派生，选错了每个 diff
   * 都会带上一堆无关改动。所以它必须在这个弹窗里就能看见、能改，而不是等
   * 第一次派活才发现自己长在了某条 feature 分支上。
   *
   * 手打路径也要生效，所以监听的是 path 本身；打字过程中的半截路径会一路
   * 打到服务端，用一个短延时压掉，并用 `stale` 挡住乱序返回的旧结果。
   */
  useEffect(() => {
    const target = path.trim()
    if (target.length === 0 || !target.startsWith('/')) {
      setListing(null)
      return undefined
    }
    let stale = false
    const timer = setTimeout(() => {
      void api.branches(target)
        .then((next) => {
          if (stale) return
          setListing(next)
          // 已经选过的分支只要还在，就别把人的选择冲掉。
          setBranch((current) => (next.branches.includes(current) ? current : next.base))
        })
        // 不是仓库、路径还没打完 —— 都不是错，服务端会在提交时把话说清楚。
        .catch(() => { if (!stale) setListing(null) })
    }, 250)
    return () => { stale = true; clearTimeout(timer) }
  }, [path])

  const submit = (): void => {
    if (name.trim().length === 0 || path.trim().length === 0) return
    setBusy(true)
    setError(null)
    void onSubmit({
      name: name.trim(),
      path: path.trim(),
      ...(branch.length === 0 ? {} : { baseBranch: branch }),
    })
      .then((project) => { onCreated(project) })
      .catch((failure: unknown) => {
        // 服务端拒绝时给一句用户照做得了的说明；没有对应文案就用它自己的话。
        const code = (failure as { code?: string }).code ?? ''
        setError(maybe(t, `newProject.err.${code}`, (failure as Error).message))
      })
      .finally(() => { setBusy(false) })
  }

  if (browsing) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('newProject.pickTitle')}</DialogTitle>
            <DialogDescription>{t('newProject.pickHint')}</DialogDescription>
          </DialogHeader>
          <DirectoryPicker
            start={path.trim().length > 0 ? path.trim() : undefined}
            onCancel={() => { setBrowsing(false) }}
            onPick={(picked) => {
              setPath(picked)
              // 名字还空着就拿目录名顶上 —— 多数时候它就是你想要的名字。
              setName((current) => (current.trim().length === 0 ? basename(picked) : current))
              setError(null)
              setBrowsing(false)
            }}
          />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('newProject.title')}</DialogTitle>
          <DialogDescription>{t('newProject.hint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">{t('newProject.name')}</Label>
            <Input
              id="project-name"
              value={name}
              autoFocus
              placeholder={t('newProject.namePlaceholder')}
              onChange={(event) => { setName(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="project-path">{t('newProject.folder')}</Label>
            <div className="flex gap-2">
              <Input
                id="project-path"
                value={path}
                className="mono"
                placeholder="/Users/you/code/your-repo"
                onChange={(event) => { setPath(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
              />
              {/* 手打路径也留着 —— 粘贴一个已知路径比一层层点进去快。 */}
              <Button variant="outline" size="sm" className="h-9" onClick={() => { setBrowsing(true) }}>
                <FolderOpen />{t('newProject.browse')}
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-xs text-ink-faint">
              <FolderGit2 className="mt-px size-3.5 flex-none" />
              {t('newProject.pathHint')}
            </p>
          </div>

          {/* 基线分支：任务分支从这儿派生，成果也合回这儿。只可选不可填 ——
              手打一个仓库里没有的名字，要等到第一次派活才炸。 */}
          <div className="space-y-2">
            <Label htmlFor="project-base">{t('newProject.base')}</Label>
            {listing === null || listing.branches.length === 0 ? (
              <p className="flex items-start gap-1.5 text-xs text-ink-faint">
                <GitBranch className="mt-px size-3.5 flex-none" />
                {listing === null ? t('newProject.baseWaiting') : t('newProject.baseEmpty')}
              </p>
            ) : (
              <>
                <select
                  id="project-base"
                  value={branch}
                  onChange={(event) => { setBranch(event.target.value) }}
                  className={cn(
                    'mono border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
                    'transition-[color,box-shadow] outline-none dark:bg-input/30',
                    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                  )}
                >
                  {listing.branches.map((candidate) => (
                    <option key={candidate} value={candidate}>{candidate}</option>
                  ))}
                </select>
                <p className="flex items-start gap-1.5 text-xs text-ink-faint">
                  <GitBranch className="mt-px size-3.5 flex-none" />
                  {t('newProject.baseHint')}
                </p>
              </>
            )}
          </div>

          {error === null ? null : (
            <p className="rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2 text-xs leading-relaxed text-lamp-fail">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('newProject.cancel')}</Button>
          <Button
            size="sm"
            disabled={busy || name.trim().length === 0 || path.trim().length === 0}
            onClick={submit}
          >
            {t('newProject.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
