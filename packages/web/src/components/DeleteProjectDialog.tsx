import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx'
import { maybe, useT } from '@/lib/i18n.tsx'
import type { Project } from '@/types.ts'

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
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    setBusy(true)
    setError(null)
    void onSubmit()
      .then(() => { onDeleted() })
      .catch((failure: unknown) => {
        // 服务端拒绝时给一句用户照做得了的说明；没有对应文案就用它自己的话。
        const code = (failure as { code?: string }).code ?? ''
        setError(maybe(t, `deleteProject.err.${code}`, (failure as Error).message))
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('deleteProject.title', { name: project.name })}</DialogTitle>
          <DialogDescription>{t('deleteProject.irreversible')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm leading-relaxed text-ink-dim">
          <p>{t('deleteProject.lead')}</p>
          <ul className="space-y-1 text-xs text-ink-faint">
            <li>{t('deleteProject.tasks', { count: taskCount })}</li>
            <li>{t('deleteProject.branches')}</li>
          </ul>
          {/* 这句是这个弹窗里最要紧的一句：删的是账本，不是代码。 */}
          <p className="flex items-start gap-2 rounded-md border border-hairline bg-raised/40 px-3 py-2 text-xs">
            <TriangleAlert className="mt-px size-3.5 flex-none text-ink-faint" />
            <span>{t('deleteProject.safe', { path: project.repoPath })}</span>
          </p>
          {error === null ? null : (
            <p className="rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2 text-xs text-lamp-fail">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('deleteProject.cancel')}</Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={submit}
            className="bg-lamp-fail text-white hover:bg-lamp-fail/90"
          >
            {t('deleteProject.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
