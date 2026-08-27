import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CircleAlert, GitBranch, ListChecks, Lock, PauseCircle } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import type { Skip, Task } from '@/types.ts'

/** 把毫秒时长压成人能扫一眼的形式。 */
function since(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`
  return `${String(Math.floor(seconds / 3600))}h${String(Math.floor((seconds % 3600) / 60))}m`
}

interface Props {
  task: Task
  now: number
  selected: boolean
  /** 该任务当前正在跑的工具名，用于卡片上的实时票据。 */
  liveTool?: string | undefined
  /** 调度器这一轮为什么没派它。 */
  skip?: Skip | undefined
  onSelect: (task: Task) => void
}

export function TaskCard({ task, now, selected, liveTool, skip, onSelect }: Props): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const running = task.column === 'running'
  const leaseExpired = task.lease !== undefined && task.lease.expiresAt <= now

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => { onSelect(task) }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'group relative cursor-grab overflow-hidden border bg-panel px-2.5 py-2 text-left',
        'transition-colors duration-150',
        'hover:border-hairline-bright hover:bg-raised',
        selected && 'border-sodium-deep bg-raised',
        isDragging && 'z-50 cursor-grabbing opacity-90 shadow-[0_8px_24px_oklch(0_0_0/0.6)]',
        'rounded-[3px]',
      )}
    >
      {/* 正在执行的卡片带一条持续扫描的轨 —— 界面里唯一恒动的元素。 */}
      {running && !leaseExpired ? <span className="scan-rail" aria-hidden /> : null}
      {leaseExpired ? <span className="absolute inset-y-0 start-0 w-0.5 bg-lamp-fail" aria-hidden /> : null}

      <div className={cn('flex items-center gap-2', running && 'ps-1.5')}>
        <span className="tag">{task.id}</span>
        <span className="flex-1" />
        {task.preferredProvider === undefined ? null : (
          <span className="chrome-label !text-[8px]">{task.preferredProvider}</span>
        )}
        <span className="lamp" data-state={task.column} />
      </div>

      <p className={cn('mt-1.5 line-clamp-2 text-ink', running && 'ps-1.5')}>{task.subject}</p>

      {running && liveTool !== undefined ? (
        <p className="mono mt-1.5 flex items-center gap-1.5 ps-1.5 text-[10px] text-sodium">
          <span className="inline-block size-1 animate-pulse rounded-full bg-sodium" />
          {liveTool}
        </p>
      ) : null}

      {leaseExpired ? (
        <p className="mono mt-1.5 flex items-center gap-1 ps-1.5 text-[10px] text-lamp-fail">
          <CircleAlert className="size-3" /> 租约已过期 · 待回收
        </p>
      ) : null}

      {/* 「我的卡为什么不动」——调度器跳过它的原因直接写在卡上。 */}
      {skip === undefined ? null : (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-ink-faint">
          <PauseCircle className="mt-[2px] size-3 flex-none" />
          <span className="min-w-0">{skip.detail}</span>
        </p>
      )}

      <div className={cn(
        'mt-2 flex items-center gap-3 border-t border-hairline/60 pt-1.5 text-ink-faint',
        running && 'ps-1.5',
      )}>
        <span className="mono flex items-center gap-1 text-[10px]">
          <ListChecks className="size-3" />{task.acceptance.length}
        </span>
        {task.blockedBy.length > 0 ? (
          <span className="mono flex items-center gap-1 text-[10px] text-lamp-review">
            <Lock className="size-3" />{task.blockedBy.length}
          </span>
        ) : null}
        {task.writeScopes.length > 0 ? (
          <span className="mono flex items-center gap-1 truncate text-[10px]">
            <GitBranch className="size-3" />{task.writeScopes[0]}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="mono text-[10px]">{since(task.updatedAt, now)}</span>
      </div>
    </div>
  )
}
