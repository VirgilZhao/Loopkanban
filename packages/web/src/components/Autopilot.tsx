import { Minus, Plus } from 'lucide-react'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { SchedulerSettings } from '@/types.ts'

interface Props {
  settings: SchedulerSettings
  busy: boolean
  onChange: (patch: Partial<SchedulerSettings>) => void
}

/**
 * 自动驾驶开关，坐在侧边栏底部 —— 它决定 Agent 是否无人值守地动你的代码，
 * 所以给它一整块地方，而不是挤在工具条里当第七颗按钮。
 */
export function Autopilot({ settings, busy, onChange }: Props): React.JSX.Element {
  const t = useT()
  const { autopilot, maxPerProvider, maxPerRepo } = settings

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

      {/* 两道并发上限。开着自动驾驶时才有意义，所以关着就淡下去。

          两道都得露在外面：只露"每个执行器"那道的话，仓库那道会以一个用户
          看不见也改不动的默认值把 Ready 卡住 —— 卡片上写着"并发已满"，而界面上
          的数字明明还没满，没人猜得到那是另一道闸。 */}
      <div className={cn('flex flex-col gap-1 px-0.5', !autopilot && 'opacity-40')}>
        {/* 上限是按执行器算的：claude 排满了不该顺带把 codex 也堵住。
            具体谁占了几个位子，就在下面那份本机 Agent 清单里逐个显示。 */}
        <Limit
          label="limit / agent" hint={t('autopilot.limitHint')} value={maxPerProvider} busy={busy}
          less={t('autopilot.less')} more={t('autopilot.more')}
          onChange={(next) => { onChange({ maxPerProvider: next }) }}
        />
        {/* 同一个仓库里同时跑几个。每个 Run 有自己的 worktree，所以调大是安全的；
            比"每个执行器"那道压得低一点，是为了少几次合并冲突，不是因为跑不了。 */}
        <Limit
          label="limit / repo" hint={t('autopilot.repoLimitHint')} value={maxPerRepo} busy={busy}
          less={t('autopilot.repoLess')} more={t('autopilot.repoMore')}
          onChange={(next) => { onChange({ maxPerRepo: next }) }}
        />
      </div>
    </div>
  )
}

/** 一行"标签 − 数字 +"。下限是 1：0 会让调度器静悄悄地什么都不派。 */
function Limit({ label, hint, value, busy, less, more, onChange }: {
  label: string
  hint: string
  value: number
  busy: boolean
  less: string
  more: string
  onChange: (next: number) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <span className="chrome-label flex-1 truncate" title={hint}>{label}</span>
      <Step label={less} disabled={busy || value <= 1} onClick={() => { onChange(value - 1) }}>
        <Minus className="size-2.5" />
      </Step>
      {/* 两位数是常态（默认就是 50 / 20），所以留够两位的宽度，别让数字挤到按钮上。 */}
      <span className="mono w-6 text-center text-[12px] text-ink">{value}</span>
      <Step label={more} disabled={busy} onClick={() => { onChange(value + 1) }}>
        <Plus className="size-2.5" />
      </Step>
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
        'flex size-4 flex-none items-center justify-center rounded-sm border border-hairline text-ink-faint',
        'transition-colors hover:border-sodium hover:text-sodium',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-hairline disabled:hover:text-ink-faint',
      )}
    >
      {children}
    </button>
  )
}
