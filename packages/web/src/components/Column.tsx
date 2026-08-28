import { Plus } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { cn } from '@/lib/utils.ts'
import { COLUMN_META, type Column as ColumnKey, type Skip, type Task } from '@/types.ts'
import { TaskCard } from './TaskCard.tsx'

interface Props {
  column: ColumnKey
  tasks: Task[]
  now: number
  index: number
  selectedId: string | null
  liveTools: Record<string, string>
  skips: Map<string, Skip>
  onSelect: (task: Task) => void
  /** 只有 Backlog 列给新建入口 —— 新卡一律从想法池起步。 */
  onCreate?: (() => void) | undefined
}

export function Column({
  column, tasks, now, index, selectedId, liveTools, skips, onSelect, onCreate,
}: Props): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: column })
  const meta = COLUMN_META[column]

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'settle flex min-w-[208px] flex-1 flex-col border-e border-hairline/70 last:border-e-0',
        isOver && 'bg-sodium/[0.035]',
      )}
      style={{ animationDelay: `${String(index * 45)}ms` }}
    >
      {/* 列头：微标签 + 计数格，一条发丝线把它和内容分开。 */}
      <header className="flex items-baseline gap-2 border-b border-hairline px-3 py-2.5">
        <span className="lamp self-center" data-state={meta.lamp} />
        <h2 className="chrome-label !text-[10px] !text-ink-dim">{meta.label}</h2>
        <span className="flex-1" />
        {onCreate === undefined ? null : (
          <button
            aria-label="新建任务"
            title="新建任务"
            onClick={onCreate}
            className={cn(
              'flex size-4 items-center justify-center rounded-sm border border-hairline text-ink-faint',
              'transition-colors hover:border-sodium hover:text-sodium',
            )}
          >
            <Plus className="size-2.5" />
          </button>
        )}
        <span className="mono rounded-sm border border-hairline px-1 text-[10px] leading-4 text-ink-faint">
          {tasks.length}
        </span>
      </header>
      <p className="cjk-label border-b border-hairline/40 px-3 py-1 !text-[10px] !text-ink-faint/60">
        {meta.hint}
      </p>

      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
        {/* 列内可排序：position 决定自动驾驶的派发顺序，所以拖动即调优先级。 */}
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            now={now}
            selected={selectedId === task.id}
            liveTool={liveTools[task.id]}
            skip={skips.get(task.id)}
            onSelect={onSelect}
          />
        ))}
        {/* 空列给一个矮的虚线槽位，像机架上空着的插槽；撑满整列会太吵。 */}
        </SortableContext>
        {tasks.length === 0 ? (
          <div className="mx-1.5 mt-1.5 h-14 rounded-lg border border-dashed border-hairline/60" />
        ) : null}
      </div>
    </section>
  )
}
