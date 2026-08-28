import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { api, ApiError } from '@/api.ts'
import { AppSidebar, type View } from '@/components/AppSidebar.tsx'
import { Column } from '@/components/Column.tsx'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog.tsx'
import { NewProjectDialog } from '@/components/NewProjectDialog.tsx'
import { RunPanel } from '@/components/RunPanel.tsx'
import { StatsBar } from '@/components/StatsBar.tsx'
import { ThemeToggle } from '@/components/ThemeToggle.tsx'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar.tsx'
import { insertPosition } from '@/lib/position.ts'
import { cn } from '@/lib/utils.ts'
import {
  COLUMNS, type Agent, type Column as ColumnKey, type Project, type RunStats, type SchedulerState,
  type Skip, type Task,
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
  'no-worktree': '这次执行没留下工作区（多半是起进程就失败了），没有东西可验收 —— 打回重跑或废弃。',
  'task-archived': '这张卡已归档。要动它先取消归档 —— 归档的卡是冻结的，不会被自动认领。',
  'already-archived': '这张卡已经归档了。',
  'not-archived': '这张卡没有归档。',
  'not-deletable': '只有 Backlog 与 Ready 的卡能删 —— 再往后 Agent 已经动过仓库了。要删就先废弃回想法池。',
  'no-project': '还没有项目。先在左侧新增一个 —— 任务得知道自己在哪个仓库里干活。',
  'task-not-found': '这张卡已经不在了，可能刚被删掉。',
}

/** 推一条桌面通知。没授权就安静地跳过 —— 不该为此打断用户。 */
function notify(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(`LoopKanban · ${title}`, { body, tag: body })
  } catch {
    // 某些浏览器在非安全上下文下会直接抛，忽略即可。
  }
}

export default function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  // 看哪一堆卡：概览（全部）或某个项目。
  const [view, setView] = useState<View>({ kind: 'overview' })
  const [newProject, setNewProject] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [liveTools, setLiveTools] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null)
  const [stats, setStats] = useState<RunStats | null>(null)
  const [schedulerBusy, setSchedulerBusy] = useState(false)
  // 归档默认不显示 —— 归档的意义就是从视野里拿走。
  const [showArchived, setShowArchived] = useState(false)
  // 上一次看到的列，用来判断"刚刚有卡进了 Review/Failed"，据此发通知。
  const seenColumns = useRef<Map<string, ColumnKey>>(new Map())

  const refresh = useCallback(async () => {
    const [{ tasks: loaded, projects: known }, state, summary] = await Promise.all([
      api.state(),
      api.scheduler().catch(() => null),
      api.stats().catch(() => null),
    ])
    setTasks(loaded)
    setProjects(known)
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

  // Run 结束时卡片会自己换列（running → review），界面必须跟上。
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

  // 无人值守的意义就在于你不用盯着。卡片进 Review 时推一条桌面通知，
  // 否则"关掉浏览器去睡觉"这件事就落不了地。
  // 成功和失败都走这一条 —— 两种结果都要人回来看一眼。
  useEffect(() => {
    const previous = seenColumns.current
    const first = previous.size === 0
    for (const task of tasks) {
      const before = previous.get(task.id)
      previous.set(task.id, task.column)
      if (first || before === undefined || before === task.column) continue
      if (task.column !== 'review' || task.archivedAt !== undefined) continue
      notify('待验收', task.subject)
    }
  }, [tasks])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const archivedCount = useMemo(() => tasks.filter((t) => t.archivedAt !== undefined).length, [tasks])

  const byColumn = useMemo(() => {
    const grouped = Object.fromEntries(COLUMNS.map((c) => [c, [] as Task[]])) as Record<ColumnKey, Task[]>
    for (const task of tasks) {
      if (task.archivedAt !== undefined && !showArchived) continue
      if (view.kind === 'project' && task.projectId !== view.id) continue
      grouped[task.column].push(task)
    }
    for (const list of Object.values(grouped)) list.sort((a, b) => a.position - b.position)
    return grouped
  }, [tasks, showArchived, view])

  /** 侧边栏上的项目计数。归档的卡不算 —— 归档就是从视野里拿走。 */
  const projectCounts = useMemo(() => {
    const counted: Record<string, number> = {}
    for (const task of tasks) {
      if (task.archivedAt !== undefined) continue
      counted[task.projectId] = (counted[task.projectId] ?? 0) + 1
    }
    return counted
  }, [tasks])

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  )

  /**
   * 新卡落到哪个项目。
   *
   * 概览里没有"当前项目"，只有一个项目时不必逼人先去点它 —— 别的情况就得
   * 明确选一个，否则任务不知道自己该在哪个仓库里干活。
   */
  const activeProject = view.kind === 'project'
    ? projectById.get(view.id) ?? null
    : projects.length === 1 ? projects[0] ?? null : null

  const selected = tasks.find((t) => t.id === selectedId) ?? null
  const dragged = tasks.find((t) => t.id === draggingId) ?? null

  // 「我的卡为什么不动」——调度器每一轮的跳过原因都摊到卡片上。
  const skipsByTask = useMemo(() => {
    const map = new Map<string, Skip>()
    for (const skip of scheduler?.lastTick?.skipped ?? []) map.set(skip.taskId, skip)
    return map
  }, [scheduler])

  /** 建一张空白卡并立刻选中它，用户接着在弹窗里填内容。 */
  const createTask = useCallback(() => {
    if (activeProject === null) return
    void (async () => {
      try {
        const { task } = await api.createTask({ projectId: activeProject.id, subject: '新任务' })
        await refresh()
        setSelectedId(task.id)
      } catch (error) {
        if (error instanceof ApiError) setNotice({ text: `${error.code} · ${error.message}`, tone: 'warn' })
      }
    })()
  }, [refresh, activeProject])

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
    // 归档的卡是冻结的。让它乐观地飞过去再被服务端弹回来只会让人以为是 bug。
    if (task.archivedAt !== undefined) return

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
    <SidebarProvider>
      <AppSidebar
        agents={agents}
        projects={projects}
        counts={projectCounts}
        total={tasks.filter((t) => t.archivedAt === undefined).length}
        view={view}
        onView={setView}
        onNewProject={() => { setNewProject(true) }}
        onDeleteProject={setDeleting}
        onCreate={createTask}
        canCreate={activeProject !== null}
        archivedCount={archivedCount}
        showArchived={showArchived}
        onToggleArchived={() => { setShowArchived((on) => !on) }}
        scheduler={scheduler}
        schedulerBusy={schedulerBusy}
        running={runningCount}
        onScheduler={(patch) => { void changeScheduler(patch) }}
      />

      <SidebarInset>
        {/* ── 顶栏：侧边栏开关 + 当前视图 ─────────────────────── */}
        <header className="flex h-12 flex-none items-center gap-2 border-b border-hairline px-3">
          <SidebarTrigger />
          <span className="h-4 w-px bg-hairline" />
          <h1 className="flex-none whitespace-nowrap text-[13px] font-semibold tracking-tight text-ink">
            {view.kind === 'overview' ? '概览' : projectById.get(view.id)?.name ?? '项目'}
          </h1>
          {view.kind === 'overview' ? (
            <span className="chrome-label !text-[8px]">所有项目</span>
          ) : (
            <span className="mono min-w-0 flex-1 truncate text-[10px] text-ink-faint" title={projectById.get(view.id)?.repoPath}>
              {projectById.get(view.id)?.repoPath}
              <span className="ms-2">基线 {projectById.get(view.id)?.baseBranch}</span>
            </span>
          )}
          <span className="flex-1" />
          <ThemeToggle />
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
              className="chrome-label rounded-md border border-current/30 px-1.5 py-0.5 opacity-70 transition-opacity hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        )}

        {/* ── 看板 ───────────────────────────────────────────── */}
        <DndContext
          sensors={sensors}
          onDragStart={(e: DragStartEvent) => { setDraggingId(String(e.active.id)) }}
          onDragCancel={() => { setDraggingId(null) }}
          onDragEnd={(e) => { void handleDragEnd(e) }}
        >
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
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
                // 概览里同一列会来自不同仓库，卡上得写清楚它是谁的。
                projectName={view.kind === 'overview'
                  ? (id: string) => projectById.get(id)?.name
                  : undefined}
                onCreate={column === 'backlog' && activeProject !== null ? createTask : undefined}
              />
            ))}
          </div>

          {/* 拖动时跟手的浮层；没有它，卡片在跨列时会显得原地消失。 */}
          <DragOverlay dropAnimation={null}>
            {dragged === null ? null : (
              <div className="rounded-xl border border-sodium bg-panel px-3 py-2.5 shadow-lg">
                <span className="tag">{dragged.id}</span>
                <p className="mt-1.5 line-clamp-2 font-medium text-ink">{dragged.subject}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {/* ── 任务详情：弹窗 ─────────────────────────────────── */}
        {selected === null ? null : (
          <RunPanel
            task={selected}
            project={projectById.get(selected.projectId) ?? null}
            agents={agents}
            onLiveTool={onLiveTool}
            onChanged={() => { void refresh() }}
            onError={(code, detail) => {
              setNotice({ text: ERROR_HINT[code] ?? `${code} · ${detail}`, tone: 'warn' })
            }}
            onClose={() => { setSelectedId(null) }}
          />
        )}

        {deleting === null ? null : (
          <DeleteProjectDialog
            project={deleting}
            taskCount={tasks.filter((t) => t.projectId === deleting.id).length}
            onSubmit={() => api.deleteProject(deleting.id)}
            onDeleted={() => {
              // 删掉的正是当前视角的话，退回概览 —— 否则界面停在一个不存在的项目上。
              if (view.kind === 'project' && view.id === deleting.id) setView({ kind: 'overview' })
              setDeleting(null)
              void refresh()
            }}
            onClose={() => { setDeleting(null) }}
          />
        )}

        {newProject ? (
          <NewProjectDialog
            onSubmit={async (input) => (await api.createProject(input)).project}
            onCreated={(project) => {
              setNewProject(false)
              setProjects((prev) => [...prev, project])
              // 建完就切过去 —— 用户下一步多半是往里加卡。
              setView({ kind: 'project', id: project.id })
              void refresh()
            }}
            onClose={() => { setNewProject(false) }}
          />
        ) : null}

        {stats === null ? null : <StatsBar stats={stats} />}
      </SidebarInset>
    </SidebarProvider>
  )
}
