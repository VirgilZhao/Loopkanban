import { cn } from '@/lib/utils.ts'
import type { RunStats } from '@/types.ts'

/** 毫秒压成一眼能扫的形式。 */
function duration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`
  return `${String(Math.floor(ms / 60_000))}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`
}

export function StatsBar({ stats }: { stats: RunStats }): React.JSX.Element | null {
  if (stats.totalRuns === 0) return null

  const rate = stats.completed + stats.failed === 0
    ? null
    : stats.completed / (stats.completed + stats.failed)

  return (
    <footer className="flex flex-none flex-wrap items-center gap-x-5 gap-y-1 border-t border-hairline px-4 py-1.5">
      <Cell label="runs" value={String(stats.totalRuns)} />
      <Cell
        label="成功率"
        value={rate === null ? '—' : `${String(Math.round(rate * 100))}%`}
        tone={rate !== null && rate < 0.6 ? 'warn' : undefined}
      />
      <Cell label="失败" value={String(stats.failed)} tone={stats.failed > 0 ? 'warn' : undefined} />

      <span className="h-3 w-px bg-hairline" />

      {stats.providers.map((p) => (
        <Cell
          key={p.provider}
          label={p.provider}
          value={`${String(p.total)} · ${duration(p.medianMs)}`}
        />
      ))}

      <span className="flex-1" />

      {/* 成本只有 claude 报，codex 不报 —— 所以这是"已知部分"，不是全部。 */}
      <Cell
        label="已知成本"
        value={stats.costUsd > 0 ? `$${stats.costUsd.toFixed(2)}` : '—'}
        title="只有会上报成本的 CLI 才计入"
      />
      <Cell label="tokens" value={`${compact(stats.inputTokens)} / ${compact(stats.outputTokens)}`} />
    </footer>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function Cell({ label, value, tone, title }: {
  label: string
  value: string
  tone?: 'warn' | undefined
  title?: string
}): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1.5" title={title}>
      <span className="chrome-label">{label}</span>
      <span className={cn('mono text-[11px]', tone === 'warn' ? 'text-lamp-fail' : 'text-ink-dim')}>
        {value}
      </span>
    </span>
  )
}
