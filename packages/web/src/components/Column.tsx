import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils.ts'
import { COLUMN_META, type Column as ColumnKey, type Task } from '@/types.ts'
import { TaskCard } from './TaskCard.tsx'

interface Props {
  column: ColumnKey
  tasks: Task[]
  now: number
  index: number
  selectedId: string | null
  liveTools: Record<string, string>
  onSelect: (task: Task) => void
}

export function Column({ column, tasks, now, index, selectedId, liveTools, onSelect }: Props): React.JSX.Element {
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
        <span className="mono border border-hairline px-1 text-[10px] leading-4 text-ink-faint">
          {tasks.length}
        </span>
      </header>
      <p className="cjk-label border-b border-hairline/40 px-3 py-1 !text-[10px] !text-ink-faint/60">
        {meta.hint}
      </p>

      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            now={now}
            selected={selectedId === task.id}
            liveTool={liveTools[task.id]}
            onSelect={onSelect}
          />
        ))}
        {/* 空列给一个矮的虚线槽位，像机架上空着的插槽；撑满整列会太吵。 */}
        {tasks.length === 0 ? (
          <div className="mx-1.5 mt-1.5 h-14 rounded-[3px] border border-dashed border-hairline/40" />
        ) : null}
      </div>
    </section>
  )
}
