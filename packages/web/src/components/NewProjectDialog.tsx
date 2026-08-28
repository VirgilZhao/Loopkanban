import { useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import type { Project } from '@/types.ts'

/** 服务端拒绝新增项目时的理由 → 用户照做得了的说明。 */
const HINT: Record<string, string> = {
  'not-a-repo': '这个目录不是 git 仓库。任务要在它派生出来的 worktree 上干活，不是仓库就派生不出来。',
  'path-not-absolute': '要绝对路径 —— 服务端不该去猜它相对于谁。',
  'project-exists': '这个目录已经是一个项目了。',
}

interface Props {
  onCreated: (project: Project) => void
  onClose: () => void
  onSubmit: (input: { name: string; path: string }) => Promise<Project>
}

export function NewProjectDialog({ onCreated, onClose, onSubmit }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (name.trim().length === 0 || path.trim().length === 0) return
    setBusy(true)
    setError(null)
    void onSubmit({ name: name.trim(), path: path.trim() })
      .then((project) => { onCreated(project) })
      .catch((failure: unknown) => {
        const code = (failure as { code?: string }).code ?? ''
        setError(HINT[code] ?? (failure as Error).message)
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>新增项目</DialogTitle>
          <DialogDescription>
            一个项目就是本机上的一个 git 仓库。任务在它派生的 worktree 里执行，做完再合回来。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">项目名称</Label>
            <Input
              id="project-name"
              value={name}
              autoFocus
              placeholder="给它一个你认得出的名字"
              onChange={(event) => { setName(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="project-path">项目文件夹</Label>
            <Input
              id="project-path"
              value={path}
              className="mono"
              placeholder="/Users/you/code/your-repo"
              onChange={(event) => { setPath(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            />
            {/* 浏览器的目录选择器只给句柄不给路径，服务端拿它没用 —— 所以这里
                只能手填绝对路径，由服务端去校验它是不是仓库。 */}
            <p className="flex items-start gap-1.5 text-xs text-ink-faint">
              <FolderGit2 className="mt-px size-3.5 flex-none" />
              本机上的绝对路径。基线分支取仓库当前所在的分支，不用填。
            </p>
          </div>

          {error === null ? null : (
            <p className="rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2 text-xs leading-relaxed text-lamp-fail">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={busy || name.trim().length === 0 || path.trim().length === 0}
            onClick={submit}
          >
            新增
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
