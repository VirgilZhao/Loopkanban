import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import {
  Archive, ArchiveRestore, Check, GitMerge, Play, RotateCcw, Square, Trash2, TriangleAlert,
} from 'lucide-react'
import { api, ApiError, subscribeRun } from '@/api.ts'
import { DiffView } from '@/components/DiffView.tsx'
import { TaskEditor } from '@/components/TaskEditor.tsx'
import { cn } from '@/lib/utils.ts'
import type { Agent, DiffView as Diff, Run, StreamEvent, Task, TaskEdit } from '@/types.ts'

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
  const [overlaps, setOverlaps] = useState<string[]>([])
  const [events, setEvents] = useState<StreamEvent[]>([])
  // 删除不可撤销，所以要点两次：第一次只是把按钮"上膛"。
  const [confirmDelete, setConfirmDelete] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const latest = runs[0]
  const archived = task.archivedAt !== undefined
  // 只有想法池与队列里的卡能删。再往后 Agent 已经动过仓库，该走的是终止 / 废弃。
  const deletable = task.column === 'backlog' || task.column === 'ready'

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

  // 写入范围重叠预警：同仓库、正在跑、路径前缀相撞的任务。
  useEffect(() => {
    if (task.writeScopes.length === 0) { setOverlaps([]); return undefined }
    let cancelled = false
    void api.overlaps(task.id)
      .then(({ overlaps: ids }) => { if (!cancelled) setOverlaps(ids) })
      .catch(() => { if (!cancelled) setOverlaps([]) })
    return () => { cancelled = true }
  }, [task.id, task.revision])

  // 只在有执行记录时拉 diff；卡片状态变了要重拉（打回后又跑了一轮）。
  useEffect(() => {
    if (latest === undefined) { setDiff(null); return undefined }
    let cancelled = false
    void api.diff(task.id)
      .then(({ diff: view }) => { if (!cancelled) setDiff(view) })
      .catch(() => { if (!cancelled) setDiff(null) })
    return () => { cancelled = true }
  }, [task.id, task.revision, latest])

  // 换了一张卡就把"上膛"收回去 —— 上一张卡的危险状态不该跟着漂到下一张。
  useEffect(() => { setConfirmDelete(false) }, [task.id])

  // 上膛也不该一直挂着：手滑点开之后忘了，下一次随手一点就把卡删了。
  useEffect(() => {
    if (!confirmDelete) return undefined
    const timer = setTimeout(() => { setConfirmDelete(false) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [confirmDelete])

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

  /** 删除这张卡。删完面板里已经没有可看的东西了，直接关掉。 */
  const remove = (): void => {
    setBusy(true)
    void api.remove(task.id, task.revision)
      .then(() => { onChanged(); onClose() })
      .catch((error: unknown) => {
        if (error instanceof ApiError) onError(error.code, error.message)
      })
      .finally(() => { setBusy(false); setConfirmDelete(false) })
  }

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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[82vh] max-h-[820px] w-[860px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-lg border-hairline bg-panel p-0 sm:max-w-[92vw]"
      >
        <header className="flex items-start gap-2 border-b border-hairline px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="tag">{task.id}</span>
              <span className="lamp" data-state={archived ? 'idle' : task.column} />
              <span className="chrome-label !text-[9px]">{task.column}</span>
            </div>
            <DialogTitle asChild>
              <h2 className="mt-1.5 text-[14px] font-medium leading-snug text-ink">{task.subject}</h2>
            </DialogTitle>
            <DialogDescription className="sr-only">任务详情与执行面板</DialogDescription>
          </div>
          <button
            disabled={busy || task.column === 'running'}
            title={task.column === 'running' ? '正在执行的卡片不能归档，先终止执行' : undefined}
            onClick={() => {
              void act(() => (archived
                ? api.unarchive(task.id, task.revision)
                : api.archive(task.id, task.revision)))
            }}
            className={cn(
              'chrome-label flex items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5',
              'transition-colors hover:border-sodium hover:text-sodium',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {archived
              ? <><ArchiveRestore className="size-2.5" />取出</>
              : <><Archive className="size-2.5" />归档</>}
          </button>
          {deletable ? (
            <button
              disabled={busy}
              title={confirmDelete
                ? '再点一次就删掉了，不可撤销'
                : '删除这张卡：执行历史与它留下的分支、工作区一并抹掉'}
              onClick={() => {
                if (!confirmDelete) { setConfirmDelete(true); return }
                remove()
              }}
              className={cn(
                'chrome-label flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-40',
                confirmDelete
                  ? 'border-lamp-fail bg-lamp-fail/10 !text-lamp-fail'
                  : 'border-hairline hover:border-lamp-fail hover:!text-lamp-fail',
              )}
            >
              <Trash2 className="size-2.5" />{confirmDelete ? '确认删除' : '删除'}
            </button>
          ) : null}
          <button
            onClick={onClose}
            className="chrome-label rounded-md border border-hairline px-1.5 py-0.5 transition-colors hover:border-hairline-bright hover:text-ink"
          >
            esc
          </button>
        </header>

        {/* 归档的卡是冻结的：派活、验收、改需求全部拒绝，只剩"取出"和"删除"
            两个动作（删除和归档指向同一个方向，不必先取出来再删一次）。
            与其把按钮摆在那儿等服务端拒绝，不如直接换成一条说明。 */}
        {archived ? (
          <div className="flex items-start gap-2 border-b border-hairline bg-raised/40 px-3 py-2">
            <Archive className="mt-[2px] size-3 flex-none text-ink-faint" />
            <p className="min-w-0 text-[11px] leading-snug text-ink-faint">
              已归档{task.archivedAt === undefined ? '' : ` · ${new Date(task.archivedAt).toLocaleString()}`}。
              它留在 {task.column} 列但不出现在看板上，也不会被自动认领。
              取出后回到原位。
            </p>
          </div>
        ) : null}

        {/* 派活 / 取消。只有 ready 的卡能派，running 的能停。 */}
        {!archived && (task.column === 'ready' || task.column === 'running') ? (
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
                    title={agent.permissionCaveat?.detail}
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
                      'chrome-label flex items-center gap-1 rounded-md border border-hairline px-2 py-1',
                      'transition-colors hover:border-sodium hover:text-sodium',
                      'disabled:cursor-not-allowed disabled:opacity-40',
                    )}
                  >
                    <Play className="size-2.5" />{agent.id}
                    {agent.permissionCaveat === undefined ? null : (
                      <span className="cjk-label !text-[10px] !text-sodium">{agent.permissionCaveat.label}</span>
                    )}
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
                  'chrome-label flex items-center gap-1 rounded-md border border-lamp-fail/50 px-2 py-1 text-lamp-fail',
                  'transition-colors hover:bg-lamp-fail/10 disabled:opacity-40',
                )}
              >
                <Square className="size-2.5" />终止执行
              </button>
            )}
          </div>
        ) : null}

        {/* 写入范围撞车预警。建议性的 —— Bash 和代码生成器都能绕过它。 */}
        {overlaps.length === 0 ? null : (
          <div className="flex items-start gap-2 border-b border-lamp-fail/30 bg-lamp-fail/[0.06] px-3 py-2">
            <TriangleAlert className="mt-[2px] size-3 flex-none text-lamp-fail" />
            <p className="text-[11px] leading-snug text-lamp-fail">
              写入范围与正在执行的 <span className="mono">{overlaps.join('、')}</span> 重叠，
              可能撞车。这只是提示，不是锁。
            </p>
          </div>
        )}

        {/* 验收：通过 / 打回 / 废弃。只有 review 列的卡看得到。 */}
        {!archived && task.column === 'review' ? (
          <div className="border-b border-hairline px-3 py-2">
            {/* 失败的执行也停在这一列，所以必须一眼看出这次是成是败 ——
                否则"通过"按钮会摆在一堆没跑完的活旁边。 */}
            {latest !== undefined && latest.status !== 'completed' ? (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-2 py-1.5">
                <TriangleAlert className="mt-[2px] size-3 flex-none text-lamp-fail" />
                <p className="min-w-0 text-[11px] leading-snug text-lamp-fail">
                  这次执行{latest.status === 'aborted' ? '被终止' : '失败'}了。
                  {latest.diagnostic === undefined ? null : (
                    <span className="mono block break-words">{latest.diagnostic}</span>
                  )}
                  看完日志后打回重跑，或者废弃。
                </p>
              </div>
            ) : null}

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
                onClick={() => { void act(() => api.discard(task.id)) }}
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
                  'min-w-0 flex-1 rounded-md border border-hairline bg-void px-2 py-1 text-[12px]',
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
              通过只把改动提交到分支 <span className="mono">{latest?.branch ?? ''}</span>，不动你的主工作区；
              废弃会删掉分支并把卡退回 Backlog。
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
                  'data-[state=active]:border-sodium data-[state=active]:!bg-transparent',
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

          <TabsContent value="spec" className="mt-0 flex min-h-0 flex-1 flex-col">
            {task.feedback === undefined ? null : (
              <div className="border-b border-sodium-deep/40 bg-sodium/[0.06] px-3 py-2">
                <p className="cjk-label mb-1 !text-[10px] !text-sodium">待处理的评审意见</p>
                <p className="whitespace-pre-wrap text-[12px] text-sodium">{task.feedback}</p>
              </div>
            )}
            <TaskEditor
              task={task}
              agents={agents}
              busy={busy}
              onSave={(edit: TaskEdit) => { void act(() => api.edit(task.id, task.revision, edit)) }}
            />
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
      </DialogContent>
    </Dialog>
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
        'cjk-label flex items-center gap-1 rounded-md border border-hairline px-2 py-1 !text-[11px]',
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
