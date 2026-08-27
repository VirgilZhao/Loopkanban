import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { api, ApiError } from '@/api.ts'
import { Autopilot } from '@/components/Autopilot.tsx'
import { Column } from '@/components/Column.tsx'
import { RunPanel } from '@/components/RunPanel.tsx'
import { StatsBar } from '@/components/StatsBar.tsx'
import { insertPosition } from '@/lib/position.ts'
import { cn } from '@/lib/utils.ts'
import {
  COLUMNS, type Agent, type Column as ColumnKey, type RunStats, type SchedulerState, type Skip, type Task,
} from '@/types.ts'

/** 卡片上的时长要走字，但每秒重渲染整块看板没必要，5 秒一次足够。 */
const CLOCK_MS = 5_000

/**
 * 领域错误码 → 用户能照做的说明。
 *
 * 拖拽被拒时卡片会弹回原位，如果不解释清楚，用户只会觉得"拖不动"。
 * 所以这里给的不是错误名，而是下一步该做什么。
 */
const ERROR_HINT: Record<string, string> = {
  'acceptance-required': '这张卡还没有验收标准。补上之后才能进 Ready —— 否则 Agent 干完了也没人能判定对不对。',
  'illegal-transition': '不允许这样跨列。流转顺序是 Backlog → Ready → Running → Review → Done。',
  'blocked-by-dependency': '它依赖的任务还没完成。',
  'lease-held': '这张卡正被某个 Agent 持有，等它跑完或超时释放。',
  'revision-conflict': '这张卡刚被改动过，已为你重新加载。',
  'provider-unavailable': '这个 Agent CLI 本机没有探测到。装好它，或者换一个。',
  'launch-failed': '起进程失败。多半是 worktree 建不出来 —— 检查仓库路径和基线分支。',
  'no-runner': '当前实例没有启用执行器，只能看板不能派活。',
  'feedback-required': '打回要写明改什么，否则 Agent 只会把上次的活重做一遍。',
  'dirty-worktree': '你的主工作区有未提交改动，先处理干净再合并。改动已经提交在任务分支上，不会丢。',
  'wrong-branch': '你的主工作区不在基线分支上。改动已经提交在任务分支上，切回去再合并即可。',
  'no-run': '这张卡还没有执行记录。',
}

/** 推一条桌面通知。没授权就安静地跳过 —— 不该为此打断用户。 */
function notify(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(`OpenKanban · ${title}`, { body, tag: body })
  } catch {
    // 某些浏览器在非安全上下文下会直接抛，忽略即可。
  }
}

export default function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [liveTools, setLiveTools] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null)
  const [stats, setStats] = useState<RunStats | null>(null)
  const [schedulerBusy, setSchedulerBusy] = useState(false)
  // 上一次看到的列，用来判断"刚刚有卡进了 Review/Failed"，据此发通知。
  const seenColumns = useRef<Map<string, ColumnKey>>(new Map())

  const refresh = useCallback(async () => {
    const [{ tasks: loaded }, state, summary] = await Promise.all([
      api.state(),
      api.scheduler().catch(() => null),
      api.stats().catch(() => null),
    ])
    setTasks(loaded)
    if (state !== null) setScheduler(state)
    if (summary !== null) setStats(summary)
  }, [])

  useEffect(() => {
    void refresh()
    void api.agents().then(({ agents: found }) => { setAgents(found) })
  }, [refresh])

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, CLOCK_MS)
    return () => { clearInterval(timer) }
  }, [])

  // Run 结束时卡片会自己换列（running → review/failed），界面必须跟上。
  // 有 Agent 在跑时盯紧一点，闲着时放慢，别白烧 CPU。
  useEffect(() => {
    const busy = tasks.some((t) => t.column === 'running')
    const timer = setInterval(() => { void refresh() }, busy ? 1_500 : 6_000)
    return () => { clearInterval(timer) }
  }, [tasks, refresh])

  useEffect(() => {
    // 只有信息类提示自动消失；被拒绝的操作要留在屏幕上，
    // 否则用户看到的只是"卡片弹回去了"而没有原因。
    if (notice === null || notice.tone === 'warn') return undefined
    const timer = setTimeout(() => { setNotice(null) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [notice])

  // 无人值守的意义就在于你不用盯着。卡片进 Review 或 Failed 时推一条桌面通知,
  // 否则"关掉浏览器去睡觉"这件事就落不了地。
  useEffect(() => {
    const previous = seenColumns.current
    const first = previous.size === 0
    for (const task of tasks) {
      const before = previous.get(task.id)
      previous.set(task.id, task.column)
      if (first || before === undefined || before === task.column) continue
      if (task.column !== 'review' && task.column !== 'failed') continue
      notify(
        task.column === 'review' ? '待验收' : '执行失败',
        task.subject,
      )
    }
  }, [tasks])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const byColumn = useMemo(() => {
    const grouped = Object.fromEntries(COLUMNS.map((c) => [c, [] as Task[]])) as Record<ColumnKey, Task[]>
    for (const task of tasks) grouped[task.column].push(task)
    for (const list of Object.values(grouped)) list.sort((a, b) => a.position - b.position)
    return grouped
  }, [tasks])

  const selected = tasks.find((t) => t.id === selectedId) ?? null
  const dragged = tasks.find((t) => t.id === draggingId) ?? null

  // 「我的卡为什么不动」——调度器每一轮的跳过原因都摊到卡片上。
  const skipsByTask = useMemo(() => {
    const map = new Map<string, Skip>()
    for (const skip of scheduler?.lastTick?.skipped ?? []) map.set(skip.taskId, skip)
    return map
  }, [scheduler])

  /** 建一张空白卡并立刻选中它，用户接着在右侧面板里填内容。 */
  const createTask = useCallback(() => {
    void (async () => {
      try {
        const { task } = await api.createTask({ subject: '新任务' })
        await refresh()
        setSelectedId(task.id)
      } catch (error) {
        if (error instanceof ApiError) setNotice({ text: `${error.code} · ${error.message}`, tone: 'warn' })
      }
    })()
  }, [refresh])

  const changeScheduler = useCallback(async (patch: Parameters<typeof api.setScheduler>[0]) => {
    setSchedulerBusy(true)
    try {
      // 打开自动驾驶时顺手要一次通知权限：这正是用户希望"不用盯着"的时刻。
      if (patch.autopilot === true && 'Notification' in window && Notification.permission === 'default') {
        void Notification.requestPermission()
      }
      setScheduler(await api.setScheduler(patch))
      await refresh()
    } catch (error) {
      if (error instanceof ApiError) setNotice({ text: `${error.code} · ${error.message}`, tone: 'warn' })
    } finally {
      setSchedulerBusy(false)
    }
  }, [refresh])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    setDraggingId(null)
    const overId = event.over?.id
    if (typeof overId !== 'string') return
    // 拖到自己身上等于没动。不拦的话 insertPosition 会因为 siblings 已排除它、
    // findIndex 返回 -1 而把它排到列首 —— position 决定自动认领的派发顺序，
    // 一次微小的误拖就静默改了优先级。
    if (overId === event.active.id) return
    const task = tasks.find((t) => t.id === event.active.id)
    if (task === undefined) return

    // 落点可能是一张卡（列内插到它前面）或一整列（放到列尾）。
    const overTask = tasks.find((t) => t.id === overId)
    const targetColumn = overTask?.column ?? (overId as ColumnKey)
    if (!COLUMNS.includes(targetColumn)) return

    const position = insertPosition(tasks, task, targetColumn, overTask ?? null)
    if (targetColumn === task.column && position === task.position) return

    // 乐观更新，失败时用服务端的真相覆盖回来。
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, column: targetColumn, position } : t)))
    try {
      const { task: updated } = await api.move(task.id, task.revision, targetColumn, position)
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (error) {
      if (error instanceof ApiError) {
        setNotice({
          text: ERROR_HINT[error.code] ?? `${error.code} · ${error.message}`,
          tone: error.status === 409 ? 'info' : 'warn',
        })
      }
      await refresh()
    }
  }, [tasks, refresh])

  const onLiveTool = useCallback((taskId: string, tool: string | undefined) => {
    setLiveTools((prev) => {
      if (tool === undefined) {
        const { [taskId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [taskId]: tool }
    })
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const runningCount = byColumn.running.length

  return (
    <div className="flex h-full flex-col">
      {/* ── 顶栏：产品标识 + 本机 Agent 状态 ───────────────────── */}
      <header className="flex flex-none items-center gap-4 border-b border-hairline px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[15px] font-semibold tracking-tight text-ink"
            style={{ fontFamily: 'var(--font-chrome)' }}
          >
            OPEN<span className="text-sodium">KANBAN</span>
          </span>
          <span className="chrome-label !text-[8px]">agent dispatch</span>
        </div>

        <div className="h-4 w-px bg-hairline" />

        {/* 探测到的 CLI —— 没探测到的 provider 不会出现，任务也选不到它。 */}
        <div className="flex items-center gap-3">
          {agents.length === 0 ? (
            <span className="cjk-label !text-lamp-fail">未探测到 Agent CLI</span>
          ) : agents.map((agent) => (
            <div key={agent.id} className="flex items-center gap-1.5" title={`${agent.bin}\n${agent.version}`}>
              <span className="lamp" data-state="done" />
              <span className="chrome-label !text-ink-dim">{agent.id}</span>
              <span className="mono text-[10px] text-ink-faint">
                {/^[\d.]+/.exec(agent.version)?.[0] ?? agent.version}
              </span>
              {agent.canResume ? null : (
                <span className="cjk-label !text-[10px] !text-lamp-fail">无续跑</span>
              )}
            </div>
          ))}
        </div>

        <span className="flex-1" />

        {scheduler === null ? null : (
          <Autopilot
            settings={scheduler.settings}
            running={runningCount}
            busy={schedulerBusy}
            onChange={(patch) => { void changeScheduler(patch) }}
          />
        )}
      </header>

      {notice === null ? null : (
        <div className={cn(
          'flex flex-none items-center gap-3 border-b px-4 py-2',
          notice.tone === 'warn'
            ? 'border-lamp-fail/40 bg-lamp-fail/[0.07]'
            : 'border-sodium-deep/50 bg-sodium/[0.07]',
        )}>
          <span className="lamp" data-state={notice.tone === 'warn' ? 'failed' : 'running'} />
          <span className={cn('flex-1', notice.tone === 'warn' ? 'text-lamp-fail' : 'text-sodium')}>
            {notice.text}
          </span>
          <button
            onClick={() => { setNotice(null) }}
            className="chrome-label border border-current/30 px-1.5 py-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── 看板 + 详情面板 ────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <DndContext
          sensors={sensors}
          onDragStart={(e: DragStartEvent) => { setDraggingId(String(e.active.id)) }}
          onDragCancel={() => { setDraggingId(null) }}
          onDragEnd={(e) => { void handleDragEnd(e) }}
        >
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {COLUMNS.map((column, index) => (
              <Column
                key={column}
                column={column}
                index={index}
                tasks={byColumn[column]}
                now={now}
                selectedId={selectedId}
                liveTools={liveTools}
                skips={skipsByTask}
                onSelect={(task) => { setSelectedId(task.id) }}
                onCreate={column === 'backlog' ? createTask : undefined}
              />
            ))}
          </div>

          {/* 拖动时跟手的浮层；没有它，卡片在跨列时会显得原地消失。 */}
          <DragOverlay dropAnimation={null}>
            {dragged === null ? null : (
              <div className="rounded-[3px] border border-sodium bg-raised px-2.5 py-2 shadow-[0_10px_30px_oklch(0_0_0/0.7)]">
                <span className="tag">{dragged.id}</span>
                <p className="mt-1.5 line-clamp-2 text-ink">{dragged.subject}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {selected === null ? null : (
          <RunPanel
            task={selected}
            agents={agents}
            onLiveTool={onLiveTool}
            onChanged={() => { void refresh() }}
            onError={(code, detail) => {
              setNotice({ text: ERROR_HINT[code] ?? `${code} · ${detail}`, tone: 'warn' })
            }}
            onClose={() => { setSelectedId(null) }}
          />
        )}
      </div>

      {stats === null ? null : <StatsBar stats={stats} />}
    </div>
  )
}
