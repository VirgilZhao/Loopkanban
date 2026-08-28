import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import type { Project } from '@/types.ts'

/** 服务端拒绝删除时的理由 → 用户照做得了的说明。 */
const HINT: Record<string, string> = {
  'project-busy': '还有卡正在执行 —— 那是个活着的进程正在改这个仓库。先终止它们再删。',
  'project-not-found': '这个项目已经不在了。',
}

interface Props {
  project: Project
  /** 这个项目名下的卡片数，摆在确认文案里 —— 要删掉多少东西得说清楚。 */
  taskCount: number
  onDeleted: () => void
  onClose: () => void
  onSubmit: () => Promise<unknown>
}

export function DeleteProjectDialog({
  project, taskCount, onDeleted, onClose, onSubmit,
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    setBusy(true)
    setError(null)
    void onSubmit()
      .then(() => { onDeleted() })
      .catch((failure: unknown) => {
        const code = (failure as { code?: string }).code ?? ''
        setError(HINT[code] ?? (failure as Error).message)
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>删除项目「{project.name}」？</DialogTitle>
          <DialogDescription>这个动作不可撤销。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm leading-relaxed text-ink-dim">
          <p>会被删掉的是 LoopKanban 记的账：</p>
          <ul className="space-y-1 text-xs text-ink-faint">
            <li>· 这个项目下的 {taskCount} 张卡，以及它们的执行历史与日志</li>
            <li>· 这些卡留下的任务分支与 worktree（<span className="mono">.loopkanban/worktrees/</span>）</li>
          </ul>
          {/* 这句是这个弹窗里最要紧的一句：删的是账本，不是代码。 */}
          <p className="flex items-start gap-2 rounded-md border border-hairline bg-raised/40 px-3 py-2 text-xs">
            <TriangleAlert className="mt-px size-3.5 flex-none text-ink-faint" />
            <span>
              你的仓库 <span className="mono break-all">{project.repoPath}</span> 本身不会被动，
              已经合并进基线的改动也都还在。
            </span>
          </p>
          {error === null ? null : (
            <p className="rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2 text-xs text-lamp-fail">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={submit}
            className="bg-lamp-fail text-white hover:bg-lamp-fail/90"
          >
            删除项目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
