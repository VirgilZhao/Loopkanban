import { useEffect, useState } from 'react'
import { CircleCheck, CircleDashed, Eye, Inbox, LoaderCircle, Plus, TriangleAlert } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Button } from '@/components/ui/button.tsx'
import { useT, type MessageKey } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import {
  COLUMN_META, type Column as ColumnKey, type Executor, type LiveLine, type PendingDecision,
  type PullRequest, type RunFailure, type Skip, type Task,
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

/**
 * 页签自己也是个落点，id 前缀在这儿定，由 App 的 handleDragEnd 解回列名。
 *
 * 不能直接拿列名当 id：那一页正摆着的时候，面板本身已经用掉了这个 id，
 * 同一个 DndContext 里两个落点重名，dnd-kit 只认得住一个。
 */
export const TAB_DROP = 'tab:'

/**
 * 看板上的一块面板：它装哪几列、这几列怎么摆在一起。
 *
 * 列不等于面板 —— 领域层的五列一列都没少，只是有两组本来就是一件事的
 * 两半，摆成两块板反而要人来回对照（见 App 的 PANELS）。
 */
export interface PanelSpec {
  readonly key: string
  /** 装哪几列。`merge` 按这个顺序从上往下接，`tabs` 按这个顺序排页签。 */
  readonly columns: readonly ColumnKey[]
  /**
   * 这几列怎么摆：
   * - `single`：一列一块板。
   * - `merge`：接成一张表，每张卡在卡面上标出自己停在哪一列。
   * - `tabs`：列头切页签，一次只摆一页。
   */
  readonly layout: 'single' | 'merge' | 'tabs'
  /** 合并出来的板自己的名字（Loop）。单列与页签用列名，不必写。 */
  readonly label?: string
  /** 合并出来的板自己的说明。不写就用当前那一列的 `column.<key>.hint`。 */
  readonly hint?: MessageKey
  /** 合并出来的板自己的图标。不写就用当前那一列的。 */
  readonly icon?: React.ComponentType<{ className?: string }>
}

interface Props {
  panel: PanelSpec
  /** 全部五列的卡。面板自己从里面挑它要摆的那几列 —— 页签切换不必惊动上面。 */
  byColumn: Record<ColumnKey, Task[]>
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
  /** 每张卡跑过几轮；一轮都没跑过的卡不在里面。 */
  rounds: Record<string, number>
  /** 等人拍板的决策（权限审批 / 提问）；没有的卡不在里面。 */
  pending: Record<string, PendingDecision[]>
  /** 全部执行器。卡面要按 id 说出"这张卡归谁"。 */
  executors: Executor[]
  skips: Map<string, Skip>
  onSelect: (task: Task) => void
  /** 概览里同一列会来自不同仓库，给出项目名让卡片自报家门；单项目视图下不传。 */
  projectName?: ((projectId: string) => string | undefined) | undefined
  /** 新建入口。只有装着 Backlog 的那块板给 —— 新卡一律从想法池起步。 */
  onCreate?: (() => void) | undefined
}

/**
 * 列头上的一个页签。
 *
 * 它同时是个落点：拖着卡悬在另一页上就替人翻过去，松手也直接算数 ——
 * 不然把 Review 的卡拖进 Done 得先松手、切页、再拖一次。
 */
function BoardTab({ column, active, count, onSelect }: {
  column: ColumnKey
  active: boolean
  count: number
  onSelect: (column: ColumnKey) => void
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `${TAB_DROP}${column}` })
  useEffect(() => {
    if (isOver && !active) onSelect(column)
  }, [isOver, active, column, onSelect])

  return (
    <button
      ref={setNodeRef}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => { onSelect(column) }}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold leading-none',
        'transition-colors duration-150',
        active ? 'bg-sodium/[0.10] text-ink' : 'text-ink-faint hover:text-ink',
        isOver && !active && 'bg-sodium/[0.16] text-ink',
      )}
    >
      {COLUMN_META[column].label}
      <span className="mono text-[10px] tabular-nums text-ink-faint">{count}</span>
    </button>
  )
}

export function Column({
  panel, byColumn, now, index, selectedId, live, attachments, prs, failures, rounds, pending, skips,
  executors, onSelect, projectName, onCreate,
}: Props): React.JSX.Element {
  const t = useT()
  const head = panel.columns[0] ?? 'backlog'
  const [tab, setTab] = useState<ColumnKey>(head)
  const tabbed = panel.layout === 'tabs'
  const merged = panel.layout === 'merge'
  // 页签的板一次只摆一页；另外两种把它装的列全摆出来。
  const shown: readonly ColumnKey[] = tabbed ? [tab] : panel.columns
  // 卡按 columns 的顺序分段接起来。Loop 里排着的在上、在跑的在下 ——
  // 这样"拖到最下面"就还是"排到队尾"（见 App 的 handleDragEnd）。
  const tasks = shown.flatMap((column) => byColumn[column])
  // 这块板当前代表哪一列：落点归到它，列头的说明也取它的。
  const active = shown[0] ?? head
  // running 不接受手动搬进去（领域层只让调度器进），所以合并的板把落点
  // 归给排队的那一列。
  const drop = merged ? head : active

  const { setNodeRef, isOver } = useDroppable({ id: drop })
  const Icon = panel.icon ?? COLUMN_ICON[active]
  // 真有 Agent 在跑时，图标才转。租约过期的卡是"待回收"，不是在跑 ——
  // 让它转下去就是在演一个已经死掉的进程。空列同理：一个空转的转圈是假信号。
  const running = panel.columns.includes('running')
    ? byColumn.running.filter((task) => task.lease !== undefined && task.lease.expiresAt > now)
    : []
  // 这块板里有几张是没跑成的。列头写一个数，是因为 Review 会长 —— 标记在卡上，
  // 而那张卡可能在滚动条下面。
  const broken = tasks.filter((task) => failures[task.id] !== undefined).length

  return (
    <section
      ref={setNodeRef}
      className={cn(
        // 列是一块卡片面板：xl 圆角、发丝边、一层浅影，列头与内容之间一条通栏分隔线。
        // `min-h-0`：一竖条里上下叠着两列时，卡多的那个不许把另一个挤没 ——
        // 它自己内部本来就会滚。
        'settle flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline',
        // 宽度由外面那条竖列定（见 App 的 PANELS）。
        'bg-panel shadow-sm transition-colors duration-150',
        isOver && 'border-sodium-deep/60 shadow-md',
      )}
      style={{ animationDelay: `${String(index * 45)}ms` }}
    >
      {/* 列头：图标 + 列名（或页签）+ 一句说明；右侧是新建入口与计数章。 */}
      <header className="flex flex-none items-start gap-2 px-3.5 pb-3 pt-3.5">
        <Icon className={cn(
          'mt-px size-4 flex-none text-ink-faint',
          running.length > 0 && 'text-sodium',
          // 比默认的一圈一秒慢一半 —— 这块界面上唯二恒动的东西，急不得。
          running.length > 0 && 'animate-spin [animation-duration:2s] motion-reduce:animate-none',
        )} />
        <div className="min-w-0 flex-1">
          {tabbed ? (
            // 一进一出的两页摆在同一条列头上，切页就是换看哪一头。
            <div role="tablist" className="-ms-1.5 -mt-1 flex items-center gap-0.5">
              {panel.columns.map((column) => (
                <BoardTab
                  key={column}
                  column={column}
                  active={column === tab}
                  count={byColumn[column].length}
                  onSelect={setTab}
                />
              ))}
            </div>
          ) : (
            <h2 className="truncate text-sm font-semibold leading-none text-ink">
              {panel.label ?? COLUMN_META[active].label}
            </h2>
          )}
          <p className="mt-1.5 truncate text-xs text-ink-faint">
            {t(panel.hint ?? `column.${active}.hint`)}
          </p>
        </div>
        {onCreate === undefined || !panel.columns.includes('backlog') ? null : (
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={t('sidebar.newTask')}
            title={t('sidebar.newTask')}
            // 新卡一律落想法池。这会儿正翻着另一页的话就替人翻回去 ——
            // 不然按下去，那张卡建在了一个看不见的地方。
            onClick={() => { setTab('backlog'); onCreate() }}
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
        {/* 合并的板上，"总共几张"不如"几张在跑"要紧：那是这块板此刻的真实负载。 */}
        {running.length === 0 ? null : (
          <span
            title={t('column.loop.running', { n: running.length })}
            className={cn(
              'mono flex h-6 items-center justify-center gap-1 rounded-md px-1.5',
              'border border-sodium-deep/40 bg-sodium/[0.07] text-xs tabular-nums text-sodium',
            )}
          >
            <span className="lamp" data-state="running" />{running.length}
          </span>
        )}
        {/* 页签自己带着计数了，右边不必再写一个总数。 */}
        {tabbed ? null : (
          <span className={cn(
            'mono flex h-6 min-w-6 items-center justify-center rounded-md border border-hairline px-1.5',
            'text-xs tabular-nums text-ink-faint',
          )}>
            {tasks.length}
          </span>
        )}
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
            rounds={rounds[task.id]}
            pending={pending[task.id]}
            skip={skips.get(task.id)}
            projectName={projectName?.(task.projectId)}
            // 一张表里混着两列的卡，卡面就得自报停在哪一步 ——
            // 不标的话，"排着"和"在跑"在这块板上长得一模一样。
            stage={merged ? task.column : undefined}
            executor={executors.find((executor) => executor.id === task.executorId)}
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
