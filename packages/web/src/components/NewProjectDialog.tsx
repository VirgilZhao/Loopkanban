import { useState } from 'react'
import { FolderGit2, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { DirectoryPicker } from '@/components/DirectoryPicker.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { maybe, useT } from '@/lib/i18n.tsx'
import { basename } from '@/lib/path.ts'
import type { Project } from '@/types.ts'

interface Props {
  onCreated: (project: Project) => void
  onClose: () => void
  onSubmit: (input: { name: string; path: string }) => Promise<Project>
}

export function NewProjectDialog({ onCreated, onClose, onSubmit }: Props): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (name.trim().length === 0 || path.trim().length === 0) return
    setBusy(true)
    setError(null)
    void onSubmit({ name: name.trim(), path: path.trim() })
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
