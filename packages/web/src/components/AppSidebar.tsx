import { Archive, Bot, CircleCheck, CircleDashed, Eye, Inbox, LoaderCircle, Plus } from 'lucide-react'
import { Autopilot } from '@/components/Autopilot.tsx'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarSeparator,
} from '@/components/ui/sidebar.tsx'
import { cn } from '@/lib/utils.ts'
import {
  COLUMNS, COLUMN_META, type Agent, type Column as ColumnKey, type SchedulerState, type SchedulerSettings,
} from '@/types.ts'

/** 列在导航里的图标。收起成图标轨之后，它是这一列仅剩的标识。 */
const COLUMN_ICON: Record<ColumnKey, React.ComponentType<{ className?: string }>> = {
  backlog: Inbox,
  ready: CircleDashed,
  running: LoaderCircle,
  review: Eye,
  done: CircleCheck,
}

interface Props {
  agents: Agent[]
  counts: Record<ColumnKey, number>
  /** 当前选中的卡在哪一列 —— 导航跟着人的注意力走，而不是记住上次点了哪儿。 */
  activeColumn: ColumnKey | null
  onNavigate: (column: ColumnKey) => void
  onCreate: () => void
  archivedCount: number
  showArchived: boolean
  onToggleArchived: () => void
  scheduler: SchedulerState | null
  schedulerBusy: boolean
  running: number
  onScheduler: (patch: Partial<SchedulerSettings>) => void
}

export function AppSidebar({
  agents, counts, activeColumn, onNavigate, onCreate,
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
            <SidebarMenuButton variant="primary" onClick={onCreate} title="新建任务">
              <Plus />
              <span>新建任务</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* 看板导航：列 + 计数。点一下把那一列滚到眼前。 */}
        <SidebarGroup>
          <SidebarGroupLabel>看板</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {COLUMNS.map((column) => {
                const Icon = COLUMN_ICON[column]
                const meta = COLUMN_META[column]
                return (
                  <SidebarMenuItem key={column}>
                    <SidebarMenuButton
                      isActive={activeColumn === column}
                      onClick={() => { onNavigate(column) }}
                      title={meta.hint}
                    >
                      <Icon className={cn(column === 'running' && counts.running > 0 && 'text-sodium')} />
                      <span>{meta.label}</span>
                      <SidebarMenuBadge>{counts[column]}</SidebarMenuBadge>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
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
