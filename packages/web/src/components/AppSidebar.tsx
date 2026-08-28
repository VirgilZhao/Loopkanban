import { Archive, Bot, FolderGit2, LayoutGrid, Plus } from 'lucide-react'
import { Autopilot } from '@/components/Autopilot.tsx'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarSeparator,
} from '@/components/ui/sidebar.tsx'
import { cn } from '@/lib/utils.ts'
import type { Agent, Project, SchedulerState, SchedulerSettings } from '@/types.ts'

/** 当前在看哪一堆卡：全部，或某个项目。 */
export type View = { readonly kind: 'overview' } | { readonly kind: 'project'; readonly id: string }

interface Props {
  agents: Agent[]
  projects: Project[]
  /** 每个项目的任务数；概览用 total。 */
  counts: Record<string, number>
  total: number
  view: View
  onView: (view: View) => void
  onNewProject: () => void
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
  agents, projects, counts, total, view, onView, onNewProject, onCreate, canCreate,
  archivedCount, showArchived, onToggleArchived,
  scheduler, schedulerBusy, running, onScheduler,
}: Props): React.JSX.Element {
  return (
    <Sidebar>
      {/* 品牌位。收起时只剩那个方块标记。 */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className={cn(
              'flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2',
              'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-2! group-data-[state=collapsed]/sidebar:justify-center',
            )}>
              <span className={cn(
                'flex size-4 flex-none items-center justify-center rounded-[3px]',
                'bg-sidebar-primary text-[9px] font-bold text-sidebar-primary-foreground',
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
                <span className="chrome-label !text-[8px]">agent dispatch</span>
              </div>
            </div>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton
              variant="primary"
              onClick={onCreate}
              disabled={!canCreate}
              title={canCreate ? '新建任务' : '先选一个项目 —— 任务得知道自己在哪个仓库里干活'}
            >
              <Plus />
              <span>新建任务</span>
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
                  title="所有项目的任务"
                >
                  <LayoutGrid />
                  <span>概览</span>
                  <SidebarMenuBadge>{total}</SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 项目：点进去只看这一个仓库的卡。 */}
        <SidebarGroup>
          <div className="flex items-center gap-1">
            <SidebarGroupLabel className="flex-1">项目</SidebarGroupLabel>
            <button
              type="button"
              aria-label="新增项目"
              title="新增项目"
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
                  <SidebarMenuButton onClick={onNewProject} title="新增项目">
                    <Plus />
                    <span className="text-sidebar-foreground/70">还没有项目</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    isActive={view.kind === 'project' && view.id === project.id}
                    onClick={() => { onView({ kind: 'project', id: project.id }) }}
                    title={`${project.repoPath}\n基线 ${project.baseBranch}`}
                  >
                    <FolderGit2 />
                    <span>{project.name}</span>
                    <SidebarMenuBadge>{counts[project.id] ?? 0}</SidebarMenuBadge>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* 本机探测到的 CLI。没探测到的 provider 不会出现，任务也选不到它。 */}
        <SidebarGroup>
          <SidebarGroupLabel>本机 Agent</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {agents.length === 0 ? (
                <SidebarMenuItem>
                  <div className={cn(
                    'flex h-8 items-center gap-2 rounded-md p-2 text-sm text-lamp-fail',
                    'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-2! group-data-[state=collapsed]/sidebar:justify-center',
                  )}>
                    <Bot className="size-4 flex-none" />
                    <span className="cjk-label truncate !text-lamp-fail group-data-[state=collapsed]/sidebar:hidden">
                      未探测到 Agent CLI
                    </span>
                  </div>
                </SidebarMenuItem>
              ) : agents.map((agent) => (
                <SidebarMenuItem key={agent.id}>
                  <div
                    className={cn(
                      'flex h-8 items-center gap-2 rounded-md p-2 text-sm',
                      'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-2! group-data-[state=collapsed]/sidebar:justify-center',
                    )}
                    title={[agent.bin, agent.version, agent.permissionCaveat?.detail].filter(Boolean).join('\n')}
                  >
                    <span className="lamp flex-none" data-state="done" />
                    <span className="chrome-label truncate !text-sidebar-foreground/80 group-data-[state=collapsed]/sidebar:hidden">
                      {agent.id}
                    </span>
                    {/* 档位名字对不上实际约束、或者不支持续跑，都要在这儿说出来。 */}
                    {agent.canResume ? null : (
                      <span className="cjk-label !text-[10px] !text-lamp-fail group-data-[state=collapsed]/sidebar:hidden">
                        无续跑
                      </span>
                    )}
                    {agent.permissionCaveat === undefined ? null : (
                      <span className="cjk-label truncate !text-[10px] !text-sodium group-data-[state=collapsed]/sidebar:hidden">
                        {agent.permissionCaveat.label}
                      </span>
                    )}
                    <SidebarMenuBadge className="mono !text-[10px]">
                      {/^[\d.]+/.exec(agent.version)?.[0] ?? agent.version}
                    </SidebarMenuBadge>
                  </div>
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
                  title={showArchived ? '隐藏归档的卡' : '显示归档的卡'}
                >
                  <Archive />
                  <span>归档</span>
                  <SidebarMenuBadge>{archivedCount}</SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {scheduler === null ? null : (
          <>
            <div className="group-data-[state=collapsed]/sidebar:hidden">
              <Autopilot
                settings={scheduler.settings}
                running={running}
                busy={schedulerBusy}
                onChange={onScheduler}
              />
            </div>
            {/* 收起时至少留一盏灯：自动驾驶是否开着，任何时候都不该看不见。 */}
            <div
              className="hidden justify-center py-1 group-data-[state=collapsed]/sidebar:flex"
              title={scheduler.settings.autopilot ? '自动驾驶开启' : '自动驾驶关闭'}
            >
              <span
                className="lamp"
                data-state={scheduler.settings.autopilot ? (running > 0 ? 'running' : 'done') : 'idle'}
              />
            </div>
          </>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
