import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, rectIntersection, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { api, ApiError } from '@/api.ts'
import { PanelRightOpen, RefreshCw, Settings } from 'lucide-react'
import { AppSidebar, type View } from '@/components/AppSidebar.tsx'
import { BaseBranchPicker } from '@/components/BaseBranchPicker.tsx'
import { ChatPanel } from '@/components/ChatPanel.tsx'
import { Column, TAB_DROP, type PanelSpec } from '@/components/Column.tsx'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog.tsx'
import { ExecutorsPage } from '@/components/ExecutorsPage.tsx'
import { FileBrowser } from '@/components/FileBrowser.tsx'
import { NewProjectDialog } from '@/components/NewProjectDialog.tsx'
import { ProjectSettingsDialog } from '@/components/ProjectSettingsDialog.tsx'
import { RunPanel } from '@/components/RunPanel.tsx'
import { StatsBar } from '@/components/StatsBar.tsx'
import { ThemeToggle } from '@/components/ThemeToggle.tsx'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar.tsx'
import { explain, useT, type MessageKey } from '@/lib/i18n.tsx'
import { insertPosition } from '@/lib/position.ts'
import { doneOrder, isUntouchedDraft, projectActivity, taskTitle } from '@/lib/task.ts'
import { cn, shortVersion } from '@/lib/utils.ts'
import {
  COLUMNS, type Agent, type Column as ColumnKey, type Executor, type LiveLine,
  type PendingDecision, type Project, type PullRequest, type RunFailure, type RunStats,
  type SchedulerState, type Skip, type Task,
} from '@/types.ts'

/** 卡片上的时长要走字，但每秒重渲染整块看板没必要，5 秒一次足够。 */
const CLOCK_MS = 5_000

/**
 * 眼下这块地方在看什么。
 *
 * 前两个是顶栏那对页签：看板，还是这个项目的文件 —— 文件浏览挂在**项目**上
 * 而不是全局，它要逛的是某个仓库，概览里没有"某个"。
 *
 * `executors` 不在那对页签里，它从侧边栏进：执行器是**跨项目**的东西
 * （同一位大壮给所有仓库干活），摆进项目页签里会让人以为它归某个仓库。
 */
type Page = 'tasks' | 'files' | 'executors'

/** 页签的顺序与文案。任务在前 —— 那是这个工具的本业。 */
const PAGES: readonly { key: Page; label: MessageKey }[] = [
  { key: 'tasks', label: 'header.tabTasks' },
  { key: 'files', label: 'header.tabFiles' },
]

/**
 * 看板的版面：从左到右几块面板，每块装哪几列。
 *
 * 领域层的五列一列都没少，但**五列不等于五块板** —— 有两组本来就是一件事
 * 的两半，分成两块只会逼人来回对照：
 *
 * - **Loop**：ready 与 running 是同一条队的前后脚。合成一张表，排着的在上、
 *   在跑的在下，卡面上各自标出自己停在哪一步（见 TaskCard 的 `stage`），
 *   "排了几张、跑着几张"是一眼的事。
 * - **Backlog / Done**：一进一出，都是不在流水线上的卡 —— 一个还没开工，
 *   一个已经收工。做成一块板的两页，一次只看一头，省下的宽度留给中间那两块
 *   真正要盯的。
 */
const PANELS: readonly PanelSpec[] = [
  { key: 'pool', columns: ['backlog', 'done'], layout: 'tabs' },
  { key: 'loop', columns: ['ready', 'running'], layout: 'merge', label: 'Loop', hint: 'column.loop.hint', icon: RefreshCw },
  { key: 'review', columns: ['review'], layout: 'single' },
]

/**
 * 落点判定：先看指针正落在谁身上，指针悬空时才退回按重叠面积算。
 *
 * dnd-kit 默认按面积挑落点，而列头上那两个页签是套在整块面板里的小落点 ——
 * 按面积算永远是面板赢，页签一辈子轮不到，把 Review 的卡拖进 Done 就没了
 * 入口（见 Column 的 BoardTab）。按指针算时小的那个近，页签才碰得到。
 *
 * 对卡片之间的落点判定没有影响：一张卡也是"小的那个"，指针落在它身上时
 * 它一样排在面板前面。
 */
const collisionDetection: CollisionDetection = (args) => {
  const under = pointerWithin(args)
  return under.length > 0 ? under : rectIntersection(args)
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
  const t = useT()
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  // 看哪一堆卡：概览（全部）或某个项目。
  const [view, setView] = useState<View>({ kind: 'overview' })
  const [page, setPage] = useState<Page>('tasks')
  const [newProject, setNewProject] = useState(false)
  // 项目设置弹窗。测试环境的启动命令与配置文件也收在里面 —— 那是项目的事实。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  // 执行器跟着看板轮询一起来：卡面、@ 补全、配置里那一栏都要按 id 说出名字。
  const [executors, setExecutors] = useState<Executor[]>([])
  const [defaultExecutorId, setDefaultExecutorId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 运行中卡片的最后一条事件，跟着看板轮询一起来 —— 详情弹窗关着也看得见。
  const [live, setLive] = useState<Record<string, LiveLine>>({})
  // 每张卡挂了几个附件，跟着看板轮询一起来 —— 卡上那枚回形针靠它。
  const [attachments, setAttachments] = useState<Record<string, number>>({})
  // 每张卡开过哪些 PR，同样跟着轮询来 —— Done 的卡要在卡面上标出它是靠
  // 哪几条 PR 进主干的，不必点开。
  const [prs, setPrs] = useState<Record<string, PullRequest[]>>({})
  // Review 里上一轮没跑成的卡。那一列成败同处，不标出来就得一张张点开看。
  const [failures, setFailures] = useState<Record<string, RunFailure>>({})
  // 每张卡跑过几轮。卡面上的轮次标记靠它；一轮没跑过的卡不在里面。
  const [rounds, setRounds] = useState<Record<string, number>>({})
  // 等人拍板的决策（权限审批 / 提问）挂在哪张卡上。Agent 停下来等人的时候，
  // 卡面必须有个东西喊人 —— 不然关着弹窗就什么都不知道。
  const [pending, setPending] = useState<Record<string, PendingDecision[]>>({})
  // 看板自己的那条通知：拖拽被拒、改项目、探测 CLI。**任务弹窗里的错误不走
  // 这儿** —— 那条横幅在弹窗背后，说了也看不见，它自己会显示（见 RunPanel）。
  const [notice, setNotice] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null)
  const [stats, setStats] = useState<RunStats | null>(null)
  const [schedulerBusy, setSchedulerBusy] = useState(false)
  // 正在重新探测本机 CLI。按钮据此转起来，并挡住连点。
  const [agentsBusy, setAgentsBusy] = useState(false)
  // 归档默认不显示 —— 归档的意义就是从视野里拿走。
  const [showArchived, setShowArchived] = useState(false)
  // 右侧聊天。占掉最右边两列的宽度，默认开着 —— 它是这一屏的常驻部分，
  // 不是要人先找出来的东西。收起来时看板占满。
  const [chatOpen, setChatOpen] = useState(true)
  /**
   * 详情弹窗开在哪张卡上，以及要不要先摆出某份文档。
   *
   * 卡的日常（信息、配置、对话）都在右侧面板里，**点卡片不再弹窗** ——
   * 弹窗留给宽屏才装得下的东西：diff、事件流、PR、测试环境、权限审批。
   */
  const [details, setDetails] = useState<{ taskId: string; file?: string } | null>(null)
  // 上一次看到的列，用来判断"刚刚有卡进了 Review/Failed"，据此发通知。
  const seenColumns = useRef<Map<string, ColumnKey>>(new Map())
  // 刚建出来、还一次没存过的那张卡。叉掉弹窗时它得跟着消失。
  const draftId = useRef<string | null>(null)
  // 建卡的请求还在路上。双击"新建任务"不该建出两张卡 —— 多出来的那张
  // 没人认领（draftId 只记得住一张），会一直空着躺在想法池里。
  const creating = useRef(false)

  /** 眼下有没有弹窗开着（详情、新建项目、项目设置、删项目）。 */
  const dialogOpen = details !== null || newProject || settingsOpen || deleting !== null

  const refresh = useCallback(async () => {
    const [
      {
        tasks: loaded, projects: known, live: lines, attachments: clips, prs: pulls,
        failures: broken, rounds: laps, pending: waiting,
        executors: crew, defaultExecutorId: boss,
      },
      state, summary,
    ] = await Promise.all([
      api.state(),
      api.scheduler().catch(() => null),
      api.stats().catch(() => null),
    ])
    setTasks(loaded)
    setProjects(known)
    setLive(lines)
    setAttachments(clips)
    setPrs(pulls)
    setFailures(broken)
    setRounds(laps)
    setPending(waiting)
    setExecutors(crew)
    setDefaultExecutorId(boss)
    if (state !== null) setScheduler(state)
    if (summary !== null) setStats(summary)
  }, [])

  /**
   * 重新探测本机装了哪些 CLI。
   *
   * 探测要为每个 CLI 起子进程，慢到看得见，所以要有"正在转"的状态；失败了
   * 就说出来 —— 悄悄什么都不变，会让人以为自己刚装的东西没被认出来。
   */
  const refreshAgents = useCallback(async () => {
    setAgentsBusy(true)
    try {
      const { agents: found } = await api.refreshAgents()
      setAgents(found)
      setNotice(found.length === 0
        ? { text: t('sidebar.agentsNoneFound'), tone: 'warn' }
        : {
            text: t('sidebar.agentsRefreshed', {
              list: found.map((a) => `${a.id} ${shortVersion(a.version)}`).join(t('sidebar.agentsSeparator')),
            }),
            tone: 'info',
          })
    } catch (error: unknown) {
      setNotice({
        text: error instanceof ApiError ? `${error.code} · ${error.message}` : t('sidebar.agentsRefreshFailed'),
        tone: 'warn',
      })
    } finally {
      setAgentsBusy(false)
    }
  }, [t])

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
      notify(t('notify.review'), taskTitle(task))
    }
  }, [tasks, t])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 有弹窗开着时这一下是关弹窗（弹窗自己处理），不该顺手把卡也放开 ——
      // 从详情退回来，人还想接着在面板上对着这张卡说话。
      if (event.key === 'Escape' && !dialogOpen) setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [dialogOpen])

  const archivedCount = useMemo(() => tasks.filter((t) => t.archivedAt !== undefined).length, [tasks])

  const byColumn = useMemo(() => {
    const grouped = Object.fromEntries(COLUMNS.map((c) => [c, [] as Task[]])) as Record<ColumnKey, Task[]>
    for (const task of tasks) {
      if (task.archivedAt !== undefined && !showArchived) continue
      if (view.kind === 'project' && task.projectId !== view.id) continue
      grouped[task.column].push(task)
    }
    for (const list of Object.values(grouped)) list.sort((a, b) => a.position - b.position)
    // Done 是唯一不按 position 排的列：那里的 position 是这张卡在 Review 里
    // 留下的残值，只反映当初排队的先后，作为"完成清单"的顺序毫无意义。
    // 按完成时间从新到旧 —— 刚做完的在最上面，往下就是越来越旧的历史。
    grouped.done.sort((a, b) => doneOrder(b) - doneOrder(a))
    return grouped
  }, [tasks, showArchived, view])

  /** 每个执行器当前跑着几张卡。租约上写的 provider 才是真正在跑的那个。 */
  const runningByAgent = useMemo(() => {
    const counted: Record<string, number> = {}
    for (const task of tasks) {
      const provider = task.lease?.provider
      if (task.column !== 'running' || provider === undefined) continue
      counted[provider] = (counted[provider] ?? 0) + 1
    }
    return counted
  }, [tasks])

  /** 侧边栏上每个项目的计数、活动灯和 review 角标。 */
  const activity = useMemo(() => projectActivity(tasks), [tasks])

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  )

  /**
   * 新卡落到哪个项目。
   *
   * 项目视角下就是那个项目；概览里没有"当前项目"，只有一个项目时把它当默认
   * —— 顶栏的路径、基线、设置入口和想法池的"+"都指着它。
   */
  const activeProject = view.kind === 'project'
    ? projectById.get(view.id) ?? null
    : projects.length === 1 ? projects[0] ?? null : null

  const selected = tasks.find((t) => t.id === selectedId) ?? null
  /** 详情弹窗开在哪张卡上。卡没了（删掉、被别处收走）弹窗就自然合上。 */
  const detailed = details === null ? null : tasks.find((t) => t.id === details.taskId) ?? null
  const dragged = tasks.find((t) => t.id === draggingId) ?? null

  // 「我的卡为什么不动」——调度器每一轮的跳过原因都摊到卡片上。
  const skipsByTask = useMemo(() => {
    const map = new Map<string, Skip>()
    for (const skip of scheduler?.lastTick?.skipped ?? []) map.set(skip.taskId, skip)
    return map
  }, [scheduler])

  /**
   * 建一张空白卡并立刻选中它，用户接着在弹窗里填内容。
   *
   * 概览里点了侧边栏的"新建任务"会先弹项目清单，选中的项目从这里传进来；
   * 项目视角下（以及想法池的"+"）不传，落当前视角的项目。
   */
  const createTask = useCallback((project?: Project) => {
    const target = project ?? activeProject
    if (target === null || creating.current) return
    creating.current = true
    void (async () => {
      try {
        // 建一张空白卡，内容在弹窗里写 —— 先落地，再动笔。
        const { task } = await api.createTask({ projectId: target.id })
        // 记下它是"新建的"：一次没存就关掉的话，这张空卡要收回去。
        draftId.current = task.id
        await refresh()
        setSelectedId(task.id)
      } catch (error) {
        if (error instanceof ApiError) setNotice({ text: explain(t, error.code, error.message), tone: 'warn' })
      } finally {
        creating.current = false
      }
    })()
  }, [refresh, activeProject, t])

  /**
   * 关掉任务弹窗。
   *
   * 新卡是先落地再动笔的，所以"没点保存就叉掉"应当等于"没建过"：那张空白卡
   * 跟着收走，想法池里不该留下一排只有 id 的卡片。只收自己刚建的那一张，且
   * 它确实一个字都没写 —— 别的卡关窗就只是关窗。
   *
   * 卡已经不在了不算失败 —— 它可能刚被面板里的删除按钮带走，那正是我们
   * 想要的结果。别的失败要说出来：那张空卡还留在想法池里，不吭声的话用户
   * 只会以为这个功能坏了。
   */
  const closeTask = useCallback((task: Task | null) => {
    setSelectedId(null)
    if (task === null || draftId.current !== task.id) return
    draftId.current = null
    if (!isUntouchedDraft(task)) return
    void api.remove(task.id, task.revision)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'task-not-found') return
        setNotice({
          text: error instanceof ApiError
            ? explain(t, error.code, error.message)
            : t('card.draftCleanupFailed'),
          tone: 'warn',
        })
      })
      .finally(() => { void refresh() })
  }, [refresh, t])

  /**
   * 换项目的基线分支。
   *
   * 只影响此后新建的卡：已经建出来的卡各自记着自己的基线，跟着改会让某张
   * 正在 Review 的卡的 diff 与合并目标在脚下换掉。
   */
  const changeBaseBranch = useCallback((project: Project, baseBranch: string) => {
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, baseBranch } : p)))
    void api.updateProject(project.id, { baseBranch })
      .catch((error: unknown) => {
        if (error instanceof ApiError) setNotice({ text: explain(t, error.code, error.message), tone: 'warn' })
        void refresh()
      })
  }, [refresh, t])

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
      if (error instanceof ApiError) setNotice({ text: explain(t, error.code, error.message), tone: 'warn' })
    } finally {
      setSchedulerBusy(false)
    }
  }, [refresh, t])

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

    // 落点可能是一张卡（列内插到它前面）、一块面板（放到那一列的列尾），
    // 或者面板列头上的一个页签（那一页的列尾 —— 见 Column 的 BoardTab）。
    const overTask = tasks.find((t) => t.id === overId)
    const targetColumn = overTask === undefined
      ? ((overId.startsWith(TAB_DROP) ? overId.slice(TAB_DROP.length) : overId) as ColumnKey)
      // 落在一张正在跑的卡上：running 只有调度器进得去，所以归到它上面那一段
      // （Loop 里排队的 ready）的队尾 —— 那一段就摆在运行段上面，"拖到最下面"
      // 本来就是"排到队尾"的意思。
      : overTask.column === 'running' ? 'ready' : overTask.column
    if (!COLUMNS.includes(targetColumn)) return

    // 锚点只在落点确实是同一列的那张卡时才算数；被改写过列的（running）按列尾处理。
    const anchor = overTask !== undefined && overTask.column === targetColumn ? overTask : null
    const position = insertPosition(tasks, task, targetColumn, anchor)
    if (targetColumn === task.column && position === task.position) return

    // 乐观更新，失败时用服务端的真相覆盖回来。
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, column: targetColumn, position } : t)))
    try {
      const { task: updated } = await api.move(task.id, task.revision, targetColumn, position)
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (error) {
      if (error instanceof ApiError) {
        setNotice({
          text: explain(t, error.code, error.message),
          tone: error.status === 409 ? 'info' : 'warn',
        })
      }
      await refresh()
    }
  }, [tasks, refresh, t])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const runningCount = byColumn.running.length

  return (
    <SidebarProvider>
      <AppSidebar
        agents={agents}
        agentsBusy={agentsBusy}
        onRefreshAgents={() => { void refreshAgents() }}
        runningByAgent={runningByAgent}
        projects={projects}
        activity={activity}
        total={tasks.filter((t) => t.archivedAt === undefined).length}
        view={view}
        onView={setView}
        onNewProject={() => { setNewProject(true) }}
        onDeleteProject={setDeleting}
        onRenameProject={(project, name) => {
          // 乐观改名：一个字段的重命名不值得让边栏闪一下。失败就用服务端的真相盖回来。
          setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, name } : p)))
          void api.updateProject(project.id, { name })
            .catch((error: unknown) => {
              if (error instanceof ApiError) setNotice({ text: explain(t, error.code, error.message), tone: 'warn' })
              void refresh()
            })
        }}
        onCreate={createTask}
        // 概览里点新建会先弹清单选项目，只要还有项目就可点；项目视角下
        // 项目得真的在 —— 没加载出来时按钮灰着。
        canCreate={view.kind === 'project' ? activeProject !== null : projects.length > 0}
        archivedCount={archivedCount}
        showArchived={showArchived}
        onToggleArchived={() => { setShowArchived((on) => !on) }}
        executorCount={executors.length}
        onExecutors={() => { setPage((now) => (now === 'executors' ? 'tasks' : 'executors')) }}
        executorsOpen={page === 'executors'}
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
            {view.kind === 'overview' ? t('header.overview') : projectById.get(view.id)?.name ?? t('header.project')}
          </h1>
          {view.kind === 'overview' ? (
            <span className="chrome-label !text-[8px]">{t('header.allProjects')}</span>
          ) : (
            <>
              <span className="mono min-w-0 truncate text-[10px] text-ink-faint" title={projectById.get(view.id)?.repoPath}>
                {projectById.get(view.id)?.repoPath}
              </span>
              {/* 基线就地可改：它是建项目时猜出来的默认值，猜错了每张新卡都会
                  长在一堆无关改动上面，得有个不用删项目就能纠正的地方。
                  路径那一段会被截断，它不能跟着一起被截掉。 */}
              {activeProject === null ? null : (
                <BaseBranchPicker
                  project={activeProject}
                  onChange={(branch) => { changeBaseBranch(activeProject, branch) }}
                />
              )}
            </>
          )}
          <span className="flex-1" />

          {/* 看板 / 文件。文件浏览要逛的是某个仓库，概览里没有"某个"，
              所以没选定项目时它是灰的 —— 点了才被拒绝更难受。 */}
          <div className="flex flex-none items-center gap-0.5 rounded-md border border-hairline p-0.5">
            {PAGES.map(({ key, label }) => {
              const blocked = key === 'files' && activeProject === null
              return (
                <button
                  key={key}
                  type="button"
                  disabled={blocked}
                  aria-current={page === key}
                  title={blocked ? t('header.tabFilesBlocked') : undefined}
                  onClick={() => { setPage(key) }}
                  className={cn(
                    'rounded-sm px-2 py-0.5 text-[11px] transition-colors',
                    page === key ? 'bg-raised text-ink' : 'text-ink-faint hover:text-ink',
                    blocked && 'opacity-40 hover:text-ink-faint',
                  )}
                >
                  {t(label)}
                </button>
              )
            })}
          </div>

          {/* 项目设置：基本信息（名称、基线）与测试环境（启动命令、要拷进
              worktree 的配置文件）都在这儿配 —— 它们是项目的事实，不跟着
              某一张卡走。 */}
          {activeProject === null ? null : (
            <button
              type="button"
              onClick={() => { setSettingsOpen(true) }}
              title={t('settings.title')}
              aria-label={t('settings.title')}
              className="flex size-7 flex-none items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-ink"
            >
              <Settings className="size-4" />
            </button>
          )}

          {/* 聊天收起来之后要有个地方把它叫回来。开着的时候不摆 —— 收起的
              按钮就在面板自己头上，两个地方各管一头。 */}
          {page === 'tasks' && !chatOpen ? (
            <button
              type="button"
              onClick={() => { setChatOpen(true) }}
              title={t('chat.expand')}
              aria-label={t('chat.expand')}
              className="flex size-7 flex-none items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-raised hover:text-ink"
            >
              <PanelRightOpen className="size-4" />
            </button>
          ) : null}

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
              {t('header.dismiss')}
            </button>
          </div>
        )}

        {/* ── 执行器 ─────────────────────────────────────────── */}
        {page !== 'executors' ? null : (
          <ExecutorsPage
            tasks={tasks}
            // 增删改、换默认都会影响看板上那些卡显示的名字，重新拉一遍。
            onChanged={() => { void refresh() }}
          />
        )}

        {/* ── 文件浏览 ───────────────────────────────────────── */}
        {page !== 'files' ? null : activeProject === null ? (
          <p className="flex flex-1 items-center justify-center px-6 text-center text-ink-faint">
            {projects.length === 0 ? t('files.noProject') : t('header.tabFilesBlocked')}
          </p>
        ) : (
          // key 让换项目时整个重挂：工作区、目录、打开的文件、终端里跑过的
          // 命令，没有一样该跟着漂到另一个仓库上去。
          <FileBrowser key={activeProject.id} project={activeProject} />
        )}

        {/* ── 看板 ───────────────────────────────────────────── */}
        {page !== 'tasks' ? null : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={(e: DragStartEvent) => { setDraggingId(String(e.active.id)) }}
          onDragCancel={() => { setDraggingId(null) }}
          onDragEnd={(e) => { void handleDragEnd(e) }}
        >
          {/* 看板与聊天并排，3 : 2 —— 右边空出来的正好是两列的宽度。
              看板这边是几块面板（见 PANELS），装不下就在自己这块里横向滚动：
              把列硬挤扁，卡片会先失去可读性。 */}
          <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className={cn(
            'flex min-w-0 gap-3 overflow-x-auto',
            chatOpen ? 'flex-[3]' : 'flex-1',
          )}>
            {PANELS.map((panel, index) => (
              <div key={panel.key} className={cn(
                'flex flex-1 flex-col',
                // 竖列的最小宽度得写死：不写的话它按里面卡片的最小内容宽算，
                // 一条长 id 或长链接就能把某一条撑宽、把整块看板顶到横向滚动。
                // 聊天开着时窄一档 —— 再窄下去，卡片标题就只剩两三个字。
                chatOpen ? 'min-w-[180px]' : 'min-w-[220px]',
              )}>
                <Column
                  panel={panel}
                  // 入场从左往右依次落位。
                  index={index}
                  byColumn={byColumn}
                  now={now}
                  selectedId={selectedId}
                  live={live}
                  attachments={attachments}
                  prs={prs}
                  failures={failures}
                  rounds={rounds}
                  pending={pending}
                  skips={skipsByTask}
                  executors={executors}
                  // 点一张卡就是把它交给右边那块面板 —— 面板收着的话先叫出来，
                  // 否则点下去只有一圈选中框，人不知道内容去了哪儿。
                  onSelect={(task) => { setSelectedId(task.id); setChatOpen(true) }}
                  // 概览里同一列会来自不同仓库，卡上得写清楚它是谁的。
                  projectName={view.kind === 'overview'
                    ? (id: string) => projectById.get(id)?.name
                    : undefined}
                  onCreate={activeProject === null ? undefined : createTask}
                />
              </div>
            ))}
          </div>

          {chatOpen ? (
            <ChatPanel
              task={selected}
              project={selected === null
                ? activeProject
                : projectById.get(selected.projectId) ?? null}
              projects={projects}
              // 只给同项目的卡：关联跨不了项目 —— 任务在这个项目派生的 worktree
              // 里干活，指向别的仓库里的卡，Agent 既读不到也用不上。
              siblings={selected === null
                ? []
                : tasks.filter((t) => t.projectId === selected.projectId && t.id !== selected.id)}
              agents={agents}
              executors={executors}
              defaultExecutorId={defaultExecutorId}
              index={PANELS.length + 1}
              // 上限拦住超宽屏：再宽下去，面板就成了空白多过内容的一大片。
              className="flex-[2] min-w-[300px] max-w-[560px]"
              onChanged={() => {
                // 动过一次（建卡、留言、存规格、挪动）就不再是"没写过的新卡"，
                // 取消选中时不该再把它当空白草稿收走。看板状态是异步刷的，
                // 这个标记不能等它。
                draftId.current = null
                void refresh()
              }}
              onCreated={(made) => {
                // 从聊天里建出来的卡自带描述，不是空白草稿 —— 取消选中时留着它。
                draftId.current = null
                setSelectedId(made.id)
              }}
              onDeselect={() => { closeTask(selected) }}
              onOpenDetails={(file) => {
                if (selected === null) return
                setDetails({ taskId: selected.id, ...(file === undefined ? {} : { file }) })
              }}
              onCollapse={() => { setChatOpen(false) }}
            />
          ) : null}
          </div>

          {/* 拖动时跟手的浮层；没有它，卡片在跨列时会显得原地消失。 */}
          <DragOverlay dropAnimation={null}>
            {dragged === null ? null : (
              <div className="rounded-xl border border-sodium bg-panel px-3 py-2.5 shadow-lg">
                <span className="tag">{dragged.id}</span>
                <p className="mt-1.5 line-clamp-2 text-ink">{taskTitle(dragged)}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        )}

        {/* ── 任务详情：弹窗 ───────────────────────────────────
            日常在右边那块面板里过，这张弹窗只管宽屏才装得下的东西：
            diff、事件流、PR、测试环境、权限审批。 */}
        {detailed === null ? null : (
          <RunPanel
            // 带着文档开的话，换一份就整个重挂 —— 初值只在挂载那一刻读一次。
            key={`${detailed.id}:${details?.file ?? ''}`}
            task={detailed}
            project={projectById.get(detailed.projectId) ?? null}
            // 只给同项目的卡：关联跨不了项目 —— 任务在这个项目派生的 worktree
            // 里干活，指向别的仓库里的卡，Agent 既读不到也用不上。
            siblings={tasks.filter((t) => t.projectId === detailed.projectId && t.id !== detailed.id)}
            agents={agents}
            executors={executors}
            defaultExecutorId={defaultExecutorId}
            initialPreview={details?.file}
            onChanged={() => {
              draftId.current = null
              void refresh()
            }}
            // 关弹窗只是关弹窗：卡还选着，面板上接着过日子。
            onClose={() => { setDetails(null) }}
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

        {settingsOpen && activeProject !== null ? (
          <ProjectSettingsDialog
            project={activeProject}
            onSaved={(saved) => { setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p))) }}
            onClose={() => { setSettingsOpen(false) }}
          />
        ) : null}

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

        {/* 统计条只在看板下面。文件页的底边归命令行 —— 两条都贴着，
            界面下沿会变成一层叠一层的东西。 */}
        {stats === null || page !== 'tasks' ? null : <StatsBar stats={stats} />}
      </SidebarInset>
    </SidebarProvider>
  )
}
