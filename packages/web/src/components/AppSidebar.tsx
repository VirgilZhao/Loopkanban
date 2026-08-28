import { useEffect, useRef, useState } from 'react'
import { Archive, Bot, FolderGit2, LayoutGrid, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Autopilot } from '@/components/Autopilot.tsx'
import { LanguageToggle } from '@/components/LanguageToggle.tsx'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar.tsx'
import { useT } from '@/lib/i18n.tsx'
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
  /** 每个项目的任务数；概览用 total。 */
  counts: Record<string, number>
  total: number
  view: View
  onView: (view: View) => void
  onNewProject: () => void
  onDeleteProject: (project: Project) => void
  onRenameProject: (project: Project, name: string) => void
  onCreate: () => void
  /** 概览里没有"当前项目"，新建任务无处可落，这时按钮是灰的。 */
  canCreate: boolean
  archivedCount: number
  showArchived: boolean
  onToggleArchived: () => void
  scheduler: SchedulerState | null
  schedulerBusy: boolean
  running: number
  onScheduler: (patch: Partial<SchedulerSettings>) => void
}

export function AppSidebar({
  agents, agentsBusy, onRefreshAgents, runningByAgent, projects, counts, total, view, onView, onNewProject, onDeleteProject, onRenameProject,
  onCreate, canCreate, archivedCount, showArchived, onToggleArchived,
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
            <SidebarMenuButton
              variant="primary"
              onClick={onCreate}
              disabled={!canCreate}
              title={canCreate ? t('sidebar.newTask') : t('sidebar.newTaskBlocked')}
            >
              <Plus />
              <span>{t('sidebar.newTask')}</span>
            </SidebarMenuButton>
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
                  <SidebarMenuButton
                    isActive={view.kind === 'project' && view.id === project.id}
                    onClick={() => { onView({ kind: 'project', id: project.id }) }}
                    onDoubleClick={() => { setRenaming(project.id) }}
                    title={t('sidebar.projectHint', { path: project.repoPath, branch: project.baseBranch })}
                  >
                    <FolderGit2 />
                    <span>{project.name}</span>
                    {/* 鼠标移上来时计数让位给删除按钮 —— 240px 宽的边栏里
                        塞不下两个东西，而此刻你要的是那颗按钮。 */}
                    <SidebarMenuBadge className="group-hover/menu-item:invisible">
                      {counts[project.id] ?? 0}
                    </SidebarMenuBadge>
                  </SidebarMenuButton>
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

        {/* 归档开关沉到底部。计数常驻 —— 不然被收走的卡就真的无迹可寻了。 */}
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
