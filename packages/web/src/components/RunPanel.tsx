import { useEffect, useMemo, useRef, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { Check, GitMerge, Play, RotateCcw, Square, Trash2 } from 'lucide-react'
import { api, ApiError, subscribeRun } from '@/api.ts'
import { DiffView } from '@/components/DiffView.tsx'
import { cn } from '@/lib/utils.ts'
import type { Agent, DiffView as Diff, Run, StreamEvent, Task } from '@/types.ts'

/** 事件类型 → 展示样式。未知类型一律走 raw 的样子，不丢弃。 */
const EVENT_STYLE: Record<string, { label: string; tone: string }> = {
  session:  { label: 'SESSION',  tone: 'text-lamp-review' },
  notice:   { label: 'NOTICE',   tone: 'text-sodium' },
  text:     { label: 'TEXT',     tone: 'text-ink' },
  tool:     { label: 'TOOL',     tone: 'text-sodium-deep' },
  usage:    { label: 'USAGE',    tone: 'text-ink-faint' },
  finished: { label: 'FINISH',   tone: 'text-lamp-ok' },
  raw:      { label: 'RAW',      tone: 'text-ink-faint/60' },
}

/** raw 行是没被识别的原始输出，只留个头，别把整坨 JSON 倒进界面。 */
const RAW_MAX = 140

/** 把一条事件压成一行可读文本。 */
function summarize(event: StreamEvent): string {
  const p = event.payload
  switch (event.kind) {
    case 'session': {
      // 不同 CLI 给的字段不一样（codex 没有 model / apiKeySource），
      // 缺的就不显示，别用 "?" 占位假装它存在。
      const parts = [String(p['sessionId'] ?? '')]
      if (typeof p['model'] === 'string') parts.push(`model=${p['model']}`)
      if (typeof p['apiKeySource'] === 'string') parts.push(`apiKeySource=${p['apiKeySource']}`)
      return parts.join('  ')
    }
    case 'text': return String(p['text'] ?? '')
    case 'tool': return String(p['name'] ?? '')
    case 'notice': return String(p['text'] ?? '')
    case 'usage': return `in=${String(p['inputTokens'] ?? '-')} out=${String(p['outputTokens'] ?? '-')}${p['costUsd'] === undefined ? '' : ` $${String(p['costUsd'])}`}`
    case 'finished': return `${p['ok'] === true ? 'ok' : 'failed'} ${String(p['diagnostic'] ?? p['summary'] ?? '')}`
    default: {
      const text = String(p['line'] ?? JSON.stringify(p))
      return text.length > RAW_MAX ? `${text.slice(0, RAW_MAX)}…` : text
    }
  }
}

interface Props {
  task: Task
  agents: Agent[]
  onLiveTool: (taskId: string, tool: string | undefined) => void
  onChanged: () => void
  onError: (code: string, detail: string) => void
  onClose: () => void
}

export function RunPanel({ task, agents, onLiveTool, onChanged, onError, onClose }: Props): React.JSX.Element {
  const [runs, setRuns] = useState<Run[]>([])
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [feedback, setFeedback] = useState('')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const latest = runs[0]

  // 依赖 revision 而不只是 id：派活之后卡片 id 不变，只有 revision 会动。
  // 只看 id 的话，刚派出去的 Run 永远不会被拉到，事件流会一直空着。
  useEffect(() => {
    let cancelled = false
    void api.runsOf(task.id).then(({ runs: loaded }) => {
      if (cancelled) return
      setRuns((prev) => {
        // 换了一次新的执行才清空日志，同一次执行的刷新要保留已收到的事件。
        if (prev[0]?.id !== loaded[0]?.id) setEvents([])
        return loaded
      })
    })
    return () => { cancelled = true }
  }, [task.id, task.revision])

  useEffect(() => {
    if (latest === undefined) return undefined
    return subscribeRun(latest.id, (event) => {
      setEvents((prev) => (prev.some((e) => e.seq === event.seq) ? prev : [...prev, event]))
      if (event.kind === 'tool') onLiveTool(task.id, String(event.payload['name'] ?? ''))
      if (event.kind === 'finished') onLiveTool(task.id, undefined)
    })
  }, [latest, task.id, onLiveTool])

  // 只在有执行记录时拉 diff；卡片状态变了要重拉（打回后又跑了一轮）。
  useEffect(() => {
    if (latest === undefined) { setDiff(null); return undefined }
    let cancelled = false
    void api.diff(task.id)
      .then(({ diff: view }) => { if (!cancelled) setDiff(view) })
      .catch(() => { if (!cancelled) setDiff(null) })
    return () => { cancelled = true }
  }, [task.id, task.revision, latest])

  // 新事件到达时贴底，除非用户正在往回翻。
  useEffect(() => {
    const node = logRef.current
    if (node === null) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    if (atBottom) node.scrollTop = node.scrollHeight
  }, [events])

  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const event of events) {
      if (event.kind !== 'tool') continue
      const name = String(event.payload['name'] ?? '?')
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [events])

  /** 统一处理验收动作的忙碌态与错误上报。 */
  const act = async (call: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await call()
      onChanged()
    } catch (error) {
      if (error instanceof ApiError) onError(error.code, error.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="flex w-[400px] flex-none flex-col border-s border-hairline bg-panel">
      <header className="flex items-start gap-2 border-b border-hairline px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="tag">{task.id}</span>
            <span className="lamp" data-state={task.column} />
            <span className="chrome-label !text-[9px]">{task.column}</span>
          </div>
          <h2 className="mt-1.5 text-[14px] font-medium leading-snug text-ink">{task.subject}</h2>
        </div>
        <button
          onClick={onClose}
          className="chrome-label border border-hairline px-1.5 py-0.5 transition-colors hover:border-hairline-bright hover:text-ink"
        >
          esc
        </button>
      </header>

      {/* 派活 / 取消。只有 ready 的卡能派，running 的能停。 */}
      {task.column === 'ready' || task.column === 'running' ? (
        <div className="flex items-center gap-1.5 border-b border-hairline px-3 py-2">
          {task.column === 'ready' ? (
            <>
              <span className="cjk-label !text-[10px]">派给</span>
              {agents.length === 0 ? (
                <span className="cjk-label !text-lamp-fail">没有可用的 Agent CLI</span>
              ) : agents.map((agent) => (
                <button
                  key={agent.id}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void api.run(task.id, agent.id)
                      .then(() => { onChanged() })
                      .catch((error: unknown) => {
                        if (error instanceof ApiError) onError(error.code, error.message)
                      })
                      .finally(() => { setBusy(false) })
                  }}
                  className={cn(
                    'chrome-label flex items-center gap-1 border border-hairline px-2 py-1',
                    'transition-colors hover:border-sodium hover:text-sodium',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  <Play className="size-2.5" />{agent.id}
                </button>
              ))}
            </>
          ) : (
            <button
              disabled={busy || latest === undefined}
              onClick={() => {
                if (latest === undefined) return
                setBusy(true)
                void api.cancel(latest.id).then(() => { onChanged() }).finally(() => { setBusy(false) })
              }}
              className={cn(
                'chrome-label flex items-center gap-1 border border-lamp-fail/50 px-2 py-1 text-lamp-fail',
                'transition-colors hover:bg-lamp-fail/10 disabled:opacity-40',
              )}
            >
              <Square className="size-2.5" />终止执行
            </button>
          )}
        </div>
      ) : null}

      {/* 验收：通过 / 打回 / 废弃。只有 review 列的卡看得到。 */}
      {task.column === 'review' ? (
        <div className="border-b border-hairline px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Action
              icon={<Check className="size-2.5" />} label="通过" tone="ok" busy={busy}
              onClick={() => { void act(() => api.accept(task.id, false)) }}
            />
            <Action
              icon={<GitMerge className="size-2.5" />} label="通过并合并" busy={busy}
              onClick={() => { void act(() => api.accept(task.id, true)) }}
            />
            <span className="flex-1" />
            <Action
              icon={<Trash2 className="size-2.5" />} label="废弃" tone="fail" busy={busy}
              onClick={() => { void act(() => api.discard(task.id, 'failed')) }}
            />
          </div>

          <div className="mt-2 flex gap-1.5">
            <input
              value={feedback}
              onChange={(event) => { setFeedback(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && feedback.trim().length > 0) {
                  void act(() => api.requestChanges(task.id, feedback)).then(() => { setFeedback('') })
                }
              }}
              placeholder="要改什么？写清楚再打回"
              className={cn(
                'min-w-0 flex-1 rounded-[2px] border border-hairline bg-void px-2 py-1 text-[12px]',
                'placeholder:text-ink-faint/60 focus:border-sodium-deep focus:outline-none',
              )}
            />
            <Action
              icon={<RotateCcw className="size-2.5" />} label="打回" busy={busy || feedback.trim().length === 0}
              onClick={() => {
                void act(() => api.requestChanges(task.id, feedback)).then(() => { setFeedback('') })
              }}
            />
          </div>
          <p className="cjk-label mt-1.5 !text-[10px] !text-ink-faint/70">
            通过只把改动提交到分支 <span className="mono">{latest?.branch ?? ''}</span>，不动你的主工作区。
          </p>
        </div>
      ) : null}

      <Tabs defaultValue="stream" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="h-auto w-full justify-start rounded-none border-b border-hairline bg-transparent p-0">
          {([['stream', '事件流'], ['diff', 'Diff'], ['spec', '规格'], ['runs', '执行历史']] as const).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className={cn(
                'cjk-label rounded-none border-0 border-b-2 border-transparent px-3 py-1.5',
                'data-[state=active]:border-sodium data-[state=active]:bg-transparent',
                'data-[state=active]:!text-sodium data-[state=active]:shadow-none',
              )}
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="stream" className="mt-0 flex min-h-0 flex-1 flex-col">
          {latest === undefined ? (
            <Empty text="这张卡还没有执行记录" />
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-hairline/60 px-3 py-1.5">
                <span className="chrome-label">{latest.provider}</span>
                <span className="mono text-[10px] text-ink-faint">{latest.cliVersion}</span>
                <span className="flex-1" />
                <span className="mono text-[10px] text-ink-faint">{latest.branch}</span>
              </div>
              <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {events.map((event) => {
                  const style = EVENT_STYLE[event.kind] ?? EVENT_STYLE['raw']
                  return (
                    <div key={event.seq} className="flex gap-2 py-[3px] leading-relaxed">
                      <span className="mono w-[52px] flex-none text-[9px] text-ink-faint/60">
                        {style?.label}
                      </span>
                      <span className={cn('mono min-w-0 flex-1 break-words text-[11px]', style?.tone)}>
                        {summarize(event)}
                      </span>
                    </div>
                  )
                })}
                {events.length === 0 ? <Empty text="等待事件…" /> : null}
              </div>
              {toolCounts.length > 0 ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-hairline/60 px-3 py-1.5">
                  {toolCounts.map(([name, count]) => (
                    <span key={name} className="mono text-[10px] text-ink-faint">
                      {name}<span className="text-sodium-deep">×{count}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </TabsContent>

        <TabsContent value="diff" className="mt-0 flex min-h-0 flex-1 flex-col">
          {diff === null ? <Empty text="还没有可看的改动" /> : <DiffView diff={diff} />}
        </TabsContent>

        <TabsContent value="spec" className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <Field label="描述">
            <p className="whitespace-pre-wrap text-ink-dim">{task.description || '（空）'}</p>
          </Field>
          <Field label="验收标准">
            {task.acceptance.length === 0 ? (
              <p className="text-lamp-fail">未填写 —— 该任务无法进入 Ready</p>
            ) : (
              <ul className="space-y-1">
                {task.acceptance.map((item) => (
                  <li key={item} className="flex gap-2 text-ink-dim">
                    <span className="mono text-ink-faint">□</span>{item}
                  </li>
                ))}
              </ul>
            )}
          </Field>
          {task.feedback === undefined ? null : (
            <Field label="待处理的评审意见">
              <p className="whitespace-pre-wrap text-sodium">{task.feedback}</p>
            </Field>
          )}
          <Field label="仓库">
            <p className="mono text-[11px] text-ink-dim">{task.repoPath}</p>
            <p className="mono text-[11px] text-ink-faint">基线 {task.baseBranch}</p>
          </Field>
          {task.writeScopes.length > 0 ? (
            <Field label="写入范围（建议性）">
              {task.writeScopes.map((scope) => (
                <p key={scope} className="mono text-[11px] text-ink-dim">{scope}</p>
              ))}
            </Field>
          ) : null}
        </TabsContent>

        <TabsContent value="runs" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          {runs.length === 0 ? <Empty text="暂无执行记录" /> : runs.map((run) => (
            <div key={run.id} className="border-b border-hairline/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="lamp" data-state={run.status === 'completed' ? 'done' : run.status} />
                <span className="chrome-label">{run.provider}</span>
                <span className="mono text-[10px] text-ink-faint">{run.cliVersion}</span>
                <span className="flex-1" />
                <span className="mono text-[10px] text-ink-faint">
                  {run.endedAt === undefined ? '进行中' : `${String(Math.round((run.endedAt - run.startedAt) / 1000))}s`}
                </span>
              </div>
              {run.diagnostic === undefined ? null : (
                <p className="mono mt-1 text-[10px] text-lamp-fail">{run.diagnostic}</p>
              )}
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </aside>
  )
}

function Action({ icon, label, onClick, busy, tone }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  busy: boolean
  tone?: 'ok' | 'fail'
}): React.JSX.Element {
  return (
    <button
      disabled={busy}
      onClick={onClick}
      className={cn(
        'cjk-label flex items-center gap-1 border border-hairline px-2 py-1 !text-[11px]',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'ok' && 'hover:border-lamp-ok hover:!text-lamp-ok',
        tone === 'fail' && 'hover:border-lamp-fail hover:!text-lamp-fail',
        tone === undefined && 'hover:border-sodium hover:!text-sodium',
      )}
    >
      {icon}{label}
    </button>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="cjk-label p-6 text-center">{text}</p>
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-4">
      <h3 className="cjk-label mb-1.5 border-b border-hairline/50 pb-1 !text-[10px]">{label}</h3>
      {children}
    </div>
  )
}
