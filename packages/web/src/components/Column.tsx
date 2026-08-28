import { CircleCheck, CircleDashed, Eye, Inbox, LoaderCircle, Plus, TriangleAlert } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Button } from '@/components/ui/button.tsx'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import {
  COLUMN_META, type Column as ColumnKey, type LiveLine, type PullRequest, type RunFailure,
  type Skip, type Task,
} from '@/types.ts'
import { TaskCard } from './TaskCard.tsx'

/** 列头的图标，与侧边栏导航同一套 —— 两处指的是同一件东西。 */
const COLUMN_ICON: Record<ColumnKey, React.ComponentType<{ className?: string }>> = {
  backlog: Inbox,
  ready: CircleDashed,
  running: LoaderCircle,
  review: Eye,
  done: CircleCheck,
}

interface Props {
  column: ColumnKey
  tasks: Task[]
  now: number
  index: number
  selectedId: string | null
  live: Record<string, LiveLine>
  /** 每张卡挂了几个附件；没有附件的卡不在里面。 */
  attachments: Record<string, number>
  /** 每张卡开过哪些 PR；一条都没有的卡不在里面。 */
  prs: Record<string, PullRequest[]>
  /** 上一轮没跑成的卡的收场。只有 Review 那一列会有。 */
  failures: Record<string, RunFailure>
  skips: Map<string, Skip>
  onSelect: (task: Task) => void
  /** 概览里同一列会来自不同仓库，给出项目名让卡片自报家门；单项目视图下不传。 */
  projectName?: ((projectId: string) => string | undefined) | undefined
  /** 只有 Backlog 列给新建入口 —— 新卡一律从想法池起步。 */
  onCreate?: (() => void) | undefined
}

export function Column({
  column, tasks, now, index, selectedId, live, attachments, prs, failures, skips,
  onSelect, projectName, onCreate,
}: Props): React.JSX.Element {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({ id: column })
  const meta = COLUMN_META[column]
  const Icon = COLUMN_ICON[column]
  // 真有 Agent 在跑时，Running 的图标才转。租约过期的卡是"待回收"，不是在跑 ——
  // 让它转下去就是在演一个已经死掉的进程。空列同理：一个空转的转圈是假信号。
  const spinning = column === 'running'
    && tasks.some((task) => task.lease !== undefined && task.lease.expiresAt > now)
  // 这一列里有几张是没跑成的。列头写一个数，是因为 Review 会长 —— 标记在卡上，
  // 而那张卡可能在滚动条下面。
  const broken = tasks.filter((task) => failures[task.id] !== undefined).length

  return (
    <section
      ref={setNodeRef}
      className={cn(
        // 列是一块卡片面板：xl 圆角、发丝边、一层浅影，列头与内容之间一条通栏分隔线。
        'settle flex min-w-[220px] flex-1 flex-col overflow-hidden rounded-xl border border-hairline',
        'bg-panel shadow-sm transition-colors duration-150',
        isOver && 'border-sodium-deep/60 shadow-md',
      )}
      style={{ animationDelay: `${String(index * 45)}ms` }}
    >
      {/* 列头：图标 + 列名 + 一句说明；右侧是新建入口与计数章。 */}
      <header className="flex flex-none items-start gap-2 px-3.5 pb-3 pt-3.5">
        <Icon className={cn(
          'mt-px size-4 flex-none text-ink-faint',
          column === 'running' && 'text-sodium',
          // 比默认的一圈一秒慢一半 —— 这块界面上唯二恒动的东西，急不得。
          spinning && 'animate-spin [animation-duration:2s] motion-reduce:animate-none',
        )} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-none text-ink">{meta.label}</h2>
          <p className="mt-1.5 truncate text-xs text-ink-faint">{t(`column.${column}.hint`)}</p>
        </div>
        {onCreate === undefined ? null : (
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={t('sidebar.newTask')}
            title={t('sidebar.newTask')}
            onClick={onCreate}
          >
            <Plus />
          </Button>
        )}
        {broken === 0 ? null : (
          <span
            title={t('column.review.failed', { n: broken })}
            className={cn(
              'mono flex h-6 items-center justify-center gap-1 rounded-md px-1.5',
              'border border-lamp-fail/40 bg-lamp-fail/[0.07] text-xs tabular-nums text-lamp-fail',
            )}
          >
            <TriangleAlert className="size-3" />{broken}
          </span>
        )}
        <span className={cn(
          'mono flex h-6 min-w-6 items-center justify-center rounded-md border border-hairline px-1.5',
          'text-xs tabular-nums text-ink-faint',
        )}>
          {tasks.length}
        </span>
      </header>

      <div className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto border-t border-hairline p-2.5',
        isOver && 'bg-sodium/[0.05]',
      )}>
        {/* 列内可排序：position 决定自动驾驶的派发顺序，所以拖动即调优先级。 */}
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            now={now}
            selected={selectedId === task.id}
            live={live[task.id]}
            attachments={attachments[task.id]}
            prs={prs[task.id]}
            failure={failures[task.id]}
            skip={skips.get(task.id)}
            projectName={projectName?.(task.projectId)}
            onSelect={onSelect}
          />
        ))}
        {/* 空列给一个矮的虚线槽位，像机架上空着的插槽；撑满整列会太吵。 */}
        </SortableContext>
        {tasks.length === 0 ? (
          <div className="h-16 rounded-lg border border-dashed border-hairline" />
        ) : null}
      </div>
    </section>
  )
}
