import { useEffect, useRef, useState } from 'react'
import { Archive, Bot, Eye, FolderGit2, LayoutGrid, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { Autopilot } from '@/components/Autopilot.tsx'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { LanguageToggle } from '@/components/LanguageToggle.tsx'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar.tsx'
import { useT } from '@/lib/i18n.tsx'
import type { ProjectActivity } from '@/lib/task.ts'
import { cn, shortVersion } from '@/lib/utils.ts'
import type { Agent, Project, SchedulerState, SchedulerSettings } from '@/types.ts'

/** 当前在看哪一堆卡：全部，或某个项目。 */
export type View = { readonly kind: 'overview' } | { readonly kind: 'project'; readonly id: string }

interface Props {
  agents: Agent[]
  /** 正在重新探测本机 CLI。 */
  agentsBusy: boolean
  /** 重新探测本机装了哪些 CLI、各自什么版本、支持什么。 */
  onRefreshAgents: () => void
  /** 每个执行器当前跑着几张卡。 */
  runningByAgent: Record<string, number>
  projects: Project[]
  /** 每个项目的卡都停在哪儿：右边那个计数、活动灯、review 角标都从这儿来。 */
  activity: Record<string, ProjectActivity>
  total: number
  view: View
  onView: (view: View) => void
  onNewProject: () => void
  onDeleteProject: (project: Project) => void
  onRenameProject: (project: Project, name: string) => void
  /**
   * 新建一张卡。概览里点按钮先弹项目清单选落点，选中的项目会作为参数传进来；
   * 项目视角下直接开窗，不传参 —— 落在当前视角的项目里。
   */
  onCreate: (project?: Project) => void
  /**
   * 没处落卡时按钮才是灰的：概览里连一个项目都没有（这时连清单都弹不出来），
   * 或项目视角下项目还没加载出来。
   */
  canCreate: boolean
  archivedCount: number
  showArchived: boolean
  onToggleArchived: () => void
  /** 建了几个执行器。常驻计数 —— 一个都没有时那儿是空的，得看得出来。 */
  executorCount: number
  /** 执行器那一页开着没有。 */
  executorsOpen: boolean
  onExecutors: () => void
  scheduler: SchedulerState | null
  schedulerBusy: boolean
  running: number
  onScheduler: (patch: Partial<SchedulerSettings>) => void
}

export function AppSidebar({
  agents, agentsBusy, onRefreshAgents, runningByAgent, projects, activity, total, view, onView, onNewProject, onDeleteProject, onRenameProject,
  onCreate, canCreate, archivedCount, showArchived, onToggleArchived,
  executorCount, executorsOpen, onExecutors,
  scheduler, schedulerBusy, running, onScheduler,
}: Props): React.JSX.Element {
  const t = useT()
  /** 每个执行器有几个位子。调度器没起来时按 1 显示，别在界面上编一个数字。 */
  const limitPerAgent = scheduler?.settings.maxPerProvider ?? 1
  // 正在改名的那个项目。双击名字进入，回车 / 失焦落定，Esc 放弃。
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <Sidebar>
      {/* 品牌位。收起时只剩那个方块标记。 */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className={cn(
              'flex h-12 w-full items-center gap-2.5 overflow-hidden rounded-md p-2',
              'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-0! group-data-[state=collapsed]/sidebar:justify-center',
            )}>
              {/* 标记的高度就是右边两行字的高度 —— 一个方块配一行字会显得它在往上飘。 */}
              <span className={cn(
                'flex size-8 flex-none items-center justify-center rounded-md',
                'bg-sidebar-primary text-[13px] font-bold tracking-tight text-sidebar-primary-foreground',
              )}>
                LK
              </span>
              <div className="flex min-w-0 flex-col group-data-[state=collapsed]/sidebar:hidden">
                <span
                  className="truncate text-[13px] font-semibold tracking-tight text-sidebar-foreground"
                  style={{ fontFamily: 'var(--font-chrome)' }}
                >
                  LOOP<span className="text-sodium">KANBAN</span>
                </span>
                <span className="chrome-label !text-[8px]">{t('sidebar.tagline')}</span>
              </div>
              {/* 语言开关挨着标题 —— 它换的正是这块牌子底下所有的字。 */}
              <LanguageToggle className="ms-auto group-data-[state=collapsed]/sidebar:hidden" />
            </div>
          </SidebarMenuItem>

          <SidebarMenuItem>
            {view.kind === 'overview' ? (
              // 概览没有"当前项目"可落卡 —— 先弹清单让人选，选完才建卡开窗。
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    variant="primary"
                    disabled={!canCreate}
                    title={canCreate ? t('sidebar.newTask') : t('sidebar.newTaskBlocked')}
                  >
                    <Plus />
                    <span>{t('sidebar.newTask')}</span>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                {/* 菜单与按钮同宽：看起来就是从按钮底下弹下来的，而不是凭空出现。 */}
                <DropdownMenuContent
                  side="bottom"
                  align="start"
                  className="min-w-(--radix-dropdown-menu-trigger-width)"
                >
                  <DropdownMenuLabel>{t('sidebar.newTaskPickProject')}</DropdownMenuLabel>
                  {projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      title={project.repoPath}
                      onSelect={() => { onCreate(project) }}
                    >
                      <FolderGit2 />
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              // 项目视角下落点已定，点了直接开窗。
              <SidebarMenuButton
                variant="primary"
                onClick={() => { onCreate() }}
                disabled={!canCreate}
                title={canCreate ? t('sidebar.newTask') : t('sidebar.newTaskBlocked')}
              >
                <Plus />
                <span>{t('sidebar.newTask')}</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* 概览：不分项目，所有卡摊在一块看板上。 */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view.kind === 'overview'}
                  onClick={() => { onView({ kind: 'overview' }) }}
                  title={t('sidebar.overviewHint')}
                >
                  <LayoutGrid />
                  <span>{t('sidebar.overview')}</span>
                  <SidebarMenuBadge>{total}</SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 项目：点进去只看这一个仓库的卡。 */}
        <SidebarGroup>
          <div className="flex items-center gap-1">
            <SidebarGroupLabel className="flex-1">{t('sidebar.projects')}</SidebarGroupLabel>
            <button
              type="button"
              aria-label={t('sidebar.addProject')}
              title={t('sidebar.addProject')}
              onClick={onNewProject}
              className={cn(
                'flex size-5 flex-none items-center justify-center rounded-md text-sidebar-foreground/70',
                'transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                'group-data-[state=collapsed]/sidebar:hidden',
              )}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={onNewProject} title={t('sidebar.addProject')}>
                    <Plus />
                    <span className="text-sidebar-foreground/70">{t('sidebar.noProjects')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  {renaming === project.id ? (
                    <RenameRow
                      project={project}
                      onCancel={() => { setRenaming(null) }}
                      onCommit={(name) => {
                        setRenaming(null)
                        if (name !== project.name) onRenameProject(project, name)
                      }}
                    />
                  ) : (
                  <ProjectRow
                    project={project}
                    activity={activity[project.id]}
                    isActive={view.kind === 'project' && view.id === project.id}
                    onOpen={() => { onView({ kind: 'project', id: project.id }) }}
                    onRename={() => { setRenaming(project.id) }}
                  />
                  )}
                  {renaming === project.id ? null : (
                    <SidebarMenuAction
                      aria-label={t('sidebar.deleteProjectNamed', { name: project.name })}
                      title={t('sidebar.deleteProject')}
                      onClick={() => { onDeleteProject(project) }}
                      className="hover:!text-lamp-fail"
                    >
                      <Trash2 />
                    </SidebarMenuAction>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 归档开关沉到底部。计数常驻 —— 不然被收走的卡就真的无迹可寻了。
            执行器挨着它：两个都是"不在看板上、但随时要点开看一眼"的东西。 */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={showArchived}
                  onClick={onToggleArchived}
                  title={showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}
                >
                  <Archive />
                  <span>{t('sidebar.archive')}</span>
                  <SidebarMenuBadge>{archivedCount}</SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={executorsOpen}
                  onClick={onExecutors}
                  title={t('sidebar.executorsHint')}
                >
                  <Users />
                  <span>{t('sidebar.executors')}</span>
                  <SidebarMenuBadge>{executorCount}</SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/*
        自动驾驶与本机 Agent 挨着放：一个定"能同时跑几个"，一个显示"这几个位子
        眼下被谁占着"。分处两地时，看完上限还得抬头去找占用，中间隔着项目列表。
      */}
      <SidebarFooter>
        {scheduler === null ? null : (
          <>
            <div className="group-data-[state=collapsed]/sidebar:hidden">
              <Autopilot
                settings={scheduler.settings}
                busy={schedulerBusy}
                onChange={onScheduler}
              />
            </div>
            {/* 收起时至少留一盏灯：自动驾驶是否开着，任何时候都不该看不见。 */}
            <div
              className="hidden justify-center py-1 group-data-[state=collapsed]/sidebar:flex"
              title={scheduler.settings.autopilot ? t('sidebar.autopilotOn') : t('sidebar.autopilotOff')}
            >
              <span
                className="lamp"
                data-state={scheduler.settings.autopilot ? (running > 0 ? 'running' : 'done') : 'idle'}
              />
            </div>
          </>
        )}

        {/*
          本机探测到的 CLI。没探测到的 provider 不会出现，任务也选不到它。
          行距比上面的导航紧：这是一份只读的状态清单，不是可点的菜单，
          按菜单的行高排会白占掉一屏底部。
        */}
        <SidebarGroup className="p-0">
          {/* 标签与刷新按钮同一行 —— 和上面「项目 +」那行是同一个手势。 */}
          <div className="flex items-center gap-1 group-data-[state=collapsed]/sidebar:hidden">
            <SidebarGroupLabel className="h-6 flex-1">{t('sidebar.agents')}</SidebarGroupLabel>
            <button
              type="button"
              aria-label={t('sidebar.refreshAgents')}
              disabled={agentsBusy}
              title={t('sidebar.refreshAgentsHint')}
              onClick={onRefreshAgents}
              className={cn(
                'flex size-5 flex-none items-center justify-center rounded-md text-sidebar-foreground/70',
                'transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
              )}
            >
              {/* 探测要为每个 CLI 起子进程，慢到看得见，所以让它转起来。 */}
              <RefreshCw className={cn('size-3.5', agentsBusy && 'animate-spin')} />
            </button>
          </div>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0">
              {agents.length === 0 ? (
                <SidebarMenuItem>
                  <div className={cn(
                    'flex h-7 items-center gap-2 rounded-md px-2 text-sm text-lamp-fail',
                    'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-2! group-data-[state=collapsed]/sidebar:justify-center',
                  )}>
                    <Bot className="size-4 flex-none" />
                    <span className="cjk-label truncate !text-lamp-fail group-data-[state=collapsed]/sidebar:hidden">
                      {t('sidebar.noAgents')}
                    </span>
                  </div>
                </SidebarMenuItem>
              ) : agents.map((agent) => {
                const busy = runningByAgent[agent.id] ?? 0
                return (
                <SidebarMenuItem key={agent.id}>
                  <div
                    className={cn(
                      'flex h-7 items-center gap-2 rounded-md px-2 text-sm',
                      'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-2! group-data-[state=collapsed]/sidebar:justify-center',
                    )}
                    title={[
                      agent.bin,
                      agent.version,
                      t('sidebar.slots', { running: busy, limit: limitPerAgent }),
                      agent.permissionCaveat?.detail,
                    ].filter(Boolean).join('\n')}
                  >
                    {/* 灯跟着这个执行器有没有活在跑 —— 不是"装没装"。 */}
                    <span className="lamp flex-none" data-state={busy > 0 ? 'running' : 'done'} />
                    <span className="chrome-label truncate !text-sidebar-foreground/80 group-data-[state=collapsed]/sidebar:hidden">
                      {agent.id}
                    </span>
                    {/* 档位名字对不上实际约束、或者不支持续跑，都要在这儿说出来。 */}
                    {agent.canResume ? null : (
                      <span className="cjk-label !text-[10px] !text-lamp-fail group-data-[state=collapsed]/sidebar:hidden">
                        {t('sidebar.noResume')}
                      </span>
                    )}
                    {agent.permissionCaveat === undefined ? null : (
                      <span className="cjk-label truncate !text-[10px] !text-sodium group-data-[state=collapsed]/sidebar:hidden">
                        {agent.permissionCaveat.label}
                      </span>
                    )}
                    <span className="mono ms-auto text-[10px] text-sidebar-foreground/60 group-data-[state=collapsed]/sidebar:hidden">
                      {shortVersion(agent.version)}
                    </span>
                    {/* 占了几个执行位 / 一共几个。上限是按执行器算的。 */}
                    <SidebarMenuBadge className={cn('mono !ms-0', busy > 0 && '!text-sodium')}>
                      {String(busy)}/{String(limitPerAgent)}
                    </SidebarMenuBadge>
                  </div>
                </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  )
}

/**
 * 项目列表里的一行。
 *
 * 除了名字，它还得回答两件在这一层看不见、点进去才知道的事：
 *
 * 一、这个项目**眼下动着没有**。有卡在跑、或有卡排着队等执行位，就给一盏
 * 会呼吸的灯 —— 无人值守的意义是你不用盯着看板，那余光扫过边栏时至少要
 * 认得出"机器还没停"。跑着的那盏亮且快，排队的那盏灰而慢，两者分得开。
 *
 * 二、有没有**东西在等你**。跑完的卡停在 Review 上不会自己往前走，所以那
 * 个数字得一直挂在行上。它不随鼠标躲开 —— 删除按钮压在最右边那个计数上，
 * 够不着它。
 */
function ProjectRow({ project, activity, isActive, onOpen, onRename }: {
  project: Project
  /** 一张卡都没有的项目根本不在这张表里，所以可能是 undefined。 */
  activity: ProjectActivity | undefined
  isActive: boolean
  onOpen: () => void
  onRename: () => void
}): React.JSX.Element {
  const t = useT()
  const { total = 0, ready = 0, running = 0, review = 0 } = activity ?? {}
  // 跑着的压过排着队的：两样都有时，"在跑"才是这一行此刻的实情。
  const pulse = running > 0 ? 'running' : ready > 0 ? 'queued' : null
  // 灯和角标都只是一个形状，说不出自己是什么意思 —— 悬停时把话补齐。
  const title = [
    t('sidebar.projectHint', { path: project.repoPath, branch: project.baseBranch }),
    running > 0 ? t('sidebar.projectRunning', { n: running }) : null,
    ready > 0 ? t('sidebar.projectQueued', { n: ready }) : null,
    review > 0 ? t('sidebar.projectReview', { n: review }) : null,
  ].filter((line) => line !== null).join('\n')

  return (
    <SidebarMenuButton
      isActive={isActive}
      onClick={onOpen}
      onDoubleClick={onRename}
      title={title}
    >
      <FolderGit2 />
      {/* 名字让位给右边那两个数字：长名字截断，不把它们挤出可视区。 */}
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {pulse === null ? null : (
        <span
          className="lamp group-data-[state=collapsed]/sidebar:hidden"
          data-state={pulse}
          aria-hidden
        />
      )}
      {review === 0 ? null : (
        <SidebarMenuBadge className="gap-0.5 bg-lamp-review/15 px-1.5 !text-lamp-review">
          <Eye className="size-3" />
          {/* 眼睛是装饰（lucide 自带 aria-hidden），数字自己也说不清是什么数
              —— 读屏念到这一行会是"项目名 1 3"，两个数字分不出谁是谁。
              所以把看得见的那个数藏出无障碍树，改念完整那句话。 */}
          <span aria-hidden>{review}</span>
          <span className="sr-only">{t('sidebar.projectReview', { n: review })}</span>
        </SidebarMenuBadge>
      )}
      {/* 鼠标移上来时计数让位给删除按钮 —— 240px 宽的边栏里塞不下两个东西，
          而此刻你要的是那颗按钮。 */}
      <SidebarMenuBadge className="group-hover/menu-item:invisible">{total}</SidebarMenuBadge>
    </SidebarMenuButton>
  )
}

/**
 * 就地改名。
 *
 * 落定的时机取三个：回车、失焦、以及点到别处 —— 与 Finder / 编辑器的侧栏
 * 一致。Esc 放弃；名字改空了当作放弃，而不是把项目变成一行空白。
 */
function RenameRow({ project, onCommit, onCancel }: {
  project: Project
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(project.name)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = (): void => {
    const next = value.trim()
    if (next.length === 0) { onCancel(); return }
    onCommit(next)
  }

  return (
    <div className="flex h-8 w-full items-center gap-2 rounded-md bg-sidebar-accent p-2">
      <FolderGit2 className="size-4 flex-none text-sidebar-accent-foreground" />
      <input
        ref={ref}
        value={value}
        onChange={(event) => { setValue(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') onCancel()
        }}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-sm text-sidebar-accent-foreground outline-none',
          'selection:bg-sidebar-primary selection:text-sidebar-primary-foreground',
        )}
      />
    </div>
  )
}
