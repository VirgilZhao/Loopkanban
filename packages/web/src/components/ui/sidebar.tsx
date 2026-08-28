import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeft } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * 侧边栏骨架，形制取自 shadcn `sidebar` / tweakcn「Future Teal」的 dashboard 预览：
 * 独立的 `--sidebar-*` 令牌面、h-8 的圆角菜单项、12px 的分组标签、accent 高亮当前项。
 *
 * 这里只留了桌面这一路 —— OpenKanban 只监听 127.0.0.1，是台前工具，
 * 不需要 Sheet 抽屉那套移动端形态。收起时退成 3rem 的图标轨。
 */

/** 两个宽度都含 p-2 的天沟：展开 240 + 8×2，收起 48（正好一颗 size-8 按钮）+ 8×2。 */
const SIDEBAR_WIDTH = '16rem'
const SIDEBAR_WIDTH_ICON = '4rem'
const SIDEBAR_KEY = 'openkanban.sidebar'
const SIDEBAR_SHORTCUT = 'b'

interface SidebarContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

export function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext)
  if (context === null) throw new Error('useSidebar 必须在 SidebarProvider 内使用')
  return context
}

function SidebarProvider({
  defaultOpen = true,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & { defaultOpen?: boolean }) {
  const [open, setOpenState] = React.useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_KEY)
      return stored === null ? defaultOpen : stored === 'expanded'
    } catch {
      // 隐私模式下 localStorage 会抛，退回默认展开。
      return defaultOpen
    }
  })

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next)
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? 'expanded' : 'collapsed')
    } catch {
      // 同上，记不住不影响这次切换。
    }
  }, [])

  const toggle = React.useCallback(() => { setOpen(!open) }, [open, setOpen])

  // ⌘B / Ctrl+B —— 和编辑器里收起边栏的手势一致。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== SIDEBAR_SHORTCUT) return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [toggle])

  const value = React.useMemo(() => ({ open, setOpen, toggle }), [open, setOpen, toggle])

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={{
          '--sidebar-width': SIDEBAR_WIDTH,
          '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
          ...style,
        } as React.CSSProperties}
        className={cn('flex h-full w-full overflow-hidden bg-sidebar', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { open } = useSidebar()

  return (
    <div
      data-slot="sidebar"
      data-state={open ? 'expanded' : 'collapsed'}
      className={cn(
        // 不给右边框 —— 侧边栏与页面同色，分隔靠的是天沟和内容面板自己的圆角边。
        'group/sidebar peer flex h-full flex-none flex-col overflow-hidden p-2 text-sidebar-foreground',
        'w-[var(--sidebar-width)] transition-[width] duration-200 ease-linear',
        'data-[state=collapsed]:w-[var(--sidebar-width-icon)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn('flex flex-none flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn('flex flex-none flex-col gap-2 border-t border-sidebar-border p-2', className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70',
        'transition-opacity duration-200 ease-linear',
        'group-data-[state=collapsed]/sidebar:pointer-events-none group-data-[state=collapsed]/sidebar:opacity-0',
        className,
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="sidebar-group-content" className={cn('w-full text-sm', className)} {...props} />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li data-slot="sidebar-menu-item" className={cn('group/menu-item relative', className)} {...props} />
  )
}

const sidebarMenuButtonVariants = cva(
  cn(
    'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left',
    'outline-hidden ring-sidebar-ring transition-[width,height,padding,colors] focus-visible:ring-2',
    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
    'active:bg-sidebar-accent active:text-sidebar-accent-foreground',
    'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
    'group-data-[state=collapsed]/sidebar:size-8! group-data-[state=collapsed]/sidebar:p-2!',
  ),
  {
    variants: {
      size: {
        default: 'h-8 text-sm',
        lg: 'h-12 text-sm',
      },
      variant: {
        default: '',
        /** 主行动项（新建任务），对应 dashboard 里那颗 Quick Create。 */
        primary: cn(
          'bg-sidebar-primary text-sidebar-primary-foreground shadow-xs',
          'hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground',
          'active:bg-sidebar-primary/90 active:text-sidebar-primary-foreground',
        ),
      },
    },
    defaultVariants: { size: 'default', variant: 'default' },
  },
)

function SidebarMenuButton({
  className,
  isActive = false,
  size,
  variant,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof sidebarMenuButtonVariants> & { isActive?: boolean }) {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ size, variant }), className)}
      {...props}
    />
  )
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        'mono pointer-events-none ms-auto flex h-5 min-w-5 select-none items-center justify-center',
        'rounded-md px-1 text-[11px] tabular-nums text-sidebar-foreground/70',
        'group-data-[state=collapsed]/sidebar:hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-separator"
      className={cn('mx-2 h-px shrink-0 bg-sidebar-border', className)}
      {...props}
    />
  )
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<'button'>) {
  const { toggle, open } = useSidebar()

  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      aria-label={open ? '收起侧边栏' : '展开侧边栏'}
      title={`${open ? '收起' : '展开'}侧边栏 · ⌘B`}
      onClick={(event) => {
        onClick?.(event)
        toggle()
      }}
      className={cn(
        'flex size-7 flex-none items-center justify-center rounded-md text-ink-faint',
        'transition-colors hover:bg-raised hover:text-ink',
        className,
      )}
      {...props}
    >
      <PanelLeft className="size-4" />
    </button>
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        // 内容区是浮在 sidebar 底色上的一块圆角面板，左侧不留边距 ——
        // 那 8px 由侧边栏的天沟出，两边各出一半会显得松。
        'relative my-2 me-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
        'rounded-xl border border-hairline bg-background shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
}
