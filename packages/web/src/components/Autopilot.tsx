import { Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import type { SchedulerSettings } from '@/types.ts'

interface Props {
  settings: SchedulerSettings
  running: number
  busy: boolean
  onChange: (patch: Partial<SchedulerSettings>) => void
}

export function Autopilot({ settings, running, busy, onChange }: Props): React.JSX.Element {
  const { autopilot, maxConcurrent } = settings

  return (
    <div className="flex items-center gap-2.5">
      {/* 并发上限。开着自动驾驶时才有意义，所以关着就淡下去。 */}
      <div className={cn('flex items-center gap-1', !autopilot && 'opacity-40')}>
        <span className="chrome-label">limit</span>
        <Step
          label="减少并发" disabled={busy || maxConcurrent <= 1}
          onClick={() => { onChange({ maxConcurrent: maxConcurrent - 1 }) }}
        >
          <Minus className="size-2.5" />
        </Step>
        <span className="mono w-4 text-center text-[12px] text-ink">{maxConcurrent}</span>
        <Step
          label="增加并发" disabled={busy}
          onClick={() => { onChange({ maxConcurrent: maxConcurrent + 1 }) }}
        >
          <Plus className="size-2.5" />
        </Step>
      </div>

      {/* 开关本体。它决定 Agent 是否无人值守地动你的代码，所以给它开关该有的分量。 */}
      <button
        disabled={busy}
        onClick={() => { onChange({ autopilot: !autopilot }) }}
        title={autopilot ? '关闭后不再自动认领，已在跑的任务不受影响' : '打开后 Ready 里的卡会被自动派给 Agent'}
        className={cn(
          'flex items-center gap-2 border px-2 py-1 transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          autopilot
            ? 'border-sodium bg-sodium/10 text-sodium'
            : 'border-hairline text-ink-faint hover:border-hairline-bright hover:text-ink-dim',
        )}
      >
        {/* 拨杆：开时滑到右侧并点亮。 */}
        <span
          className={cn(
            'relative h-2.5 w-5 rounded-full border transition-colors',
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
      </button>

      <div className="flex items-center gap-1.5">
        <span className="lamp" data-state={running > 0 ? 'running' : 'idle'} />
        <span className="chrome-label">running</span>
        <span className="mono text-[12px] text-ink">{running}</span>
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
        'flex size-4 items-center justify-center border border-hairline text-ink-faint',
        'transition-colors hover:border-sodium hover:text-sodium',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-hairline disabled:hover:text-ink-faint',
      )}
    >
      {children}
    </button>
  )
}
