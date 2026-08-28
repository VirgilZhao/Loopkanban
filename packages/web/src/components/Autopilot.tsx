import { Minus, Plus } from 'lucide-react'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { SchedulerSettings } from '@/types.ts'

interface Props {
  settings: SchedulerSettings
  running: number
  busy: boolean
  onChange: (patch: Partial<SchedulerSettings>) => void
}

/**
 * 自动驾驶开关，坐在侧边栏底部 —— 它决定 Agent 是否无人值守地动你的代码，
 * 所以给它一整块地方，而不是挤在工具条里当第七颗按钮。
 */
export function Autopilot({ settings, running, busy, onChange }: Props): React.JSX.Element {
  const t = useT()
  const { autopilot, maxPerProvider } = settings

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/20 p-2">
      {/* 开关本体。 */}
      <button
        disabled={busy}
        onClick={() => { onChange({ autopilot: !autopilot }) }}
        title={autopilot ? t('autopilot.turnOff') : t('autopilot.turnOn')}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          autopilot
            ? 'border-sodium bg-sodium/10 text-sodium'
            : 'border-sidebar-border text-ink-faint hover:border-hairline-bright hover:text-ink-dim',
        )}
      >
        {/* 拨杆：开时滑到右侧并点亮。 */}
        <span
          className={cn(
            'relative h-2.5 w-5 flex-none rounded-full border transition-colors',
            autopilot ? 'border-sodium bg-sodium/25' : 'border-hairline-bright',
          )}
        >
          <span
            className={cn(
              'absolute top-[1px] size-[7px] rounded-full transition-all duration-200',
              autopilot ? 'left-[11px] bg-sodium shadow-[0_0_5px_currentColor]' : 'left-[1px] bg-ink-faint',
            )}
          />
        </span>
        <span className="chrome-label !text-current">autopilot</span>
        <span className="flex-1" />
        <span className="cjk-label !text-[10px] !text-current">{autopilot ? t('autopilot.on') : t('autopilot.off')}</span>
      </button>

      <div className="flex items-center gap-1.5 px-0.5">
        {/* 并发上限。开着自动驾驶时才有意义，所以关着就淡下去。 */}
        <div className={cn('flex items-center gap-1', !autopilot && 'opacity-40')}>
          {/* 上限是按执行器算的：claude 排满了不该顺带把 codex 也堵住。 */}
          <span className="chrome-label" title={t('autopilot.limitHint')}>limit / agent</span>
          <Step
            label={t('autopilot.less')} disabled={busy || maxPerProvider <= 1}
            onClick={() => { onChange({ maxPerProvider: maxPerProvider - 1 }) }}
          >
            <Minus className="size-2.5" />
          </Step>
          <span className="mono w-3 text-center text-[12px] text-ink">{maxPerProvider}</span>
          <Step
            label={t('autopilot.more')} disabled={busy}
            onClick={() => { onChange({ maxPerProvider: maxPerProvider + 1 }) }}
          >
            <Plus className="size-2.5" />
          </Step>
        </div>

        <span className="flex-1" />

        <div className="flex items-center gap-1.5">
          <span className="lamp" data-state={running > 0 ? 'running' : 'idle'} />
          <span className="chrome-label">running</span>
          <span className="mono text-[12px] text-ink">{running}</span>
        </div>
      </div>
    </div>
  )
}

function Step({ children, onClick, disabled, label }: {
  children: React.ReactNode
  onClick: () => void
  disabled: boolean
  label: string
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-4 items-center justify-center rounded-sm border border-hairline text-ink-faint',
        'transition-colors hover:border-sodium hover:text-sodium',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-hairline disabled:hover:text-ink-faint',
      )}
    >
      {children}
    </button>
  )
}
