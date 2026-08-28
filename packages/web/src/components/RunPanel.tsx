import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import {
  Archive, ArchiveRestore, Bot, Check, GitMerge, Play, Send, Square, Trash2, TriangleAlert, User, X,
} from 'lucide-react'
import { api, ApiError, subscribeRun } from '@/api.ts'
import { DiffView } from '@/components/DiffView.tsx'
import { TaskEditor } from '@/components/TaskEditor.tsx'
import { summarize } from '@/lib/events.ts'
import { useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { taskTitle } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import type {
  Agent, DiffView as Diff, Project, Run, StreamEvent, Task, TaskComment, TaskEdit,
} from '@/types.ts'

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

interface Props {
  task: Task
  /** 任务所属项目。任务干活的地方是它派生出来的 worktree。 */
  project: Project | null
  agents: Agent[]
  onChanged: () => void
  onError: (code: string, detail: string) => void
  onClose: () => void
}

export function RunPanel({
  task, project, agents, onChanged, onError, onClose,
}: Props): React.JSX.Element {
  const t = useT()
  const [runs, setRuns] = useState<Run[]>([])
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [events, setEvents] = useState<StreamEvent[]>([])
  // 删除不可撤销，所以要点两次：第一次只是把按钮"上膛"。
  const [confirmDelete, setConfirmDelete] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const latest = runs[0]
  // 跑过几轮 = 这张卡有几条执行记录。第二轮起 Agent 接的是同一个会话（见
  // runner 的续跑），所以这个数就是"这次会话来回了几趟"，不是重新开始了几次。
  const rounds = runs.length
  const archived = task.archivedAt !== undefined
  /** 卡上指定的执行器，且本机确实探测到了它。 */
  const pinned = agents.find((agent) => agent.id === task.preferredProvider)
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

  // 讨论跟着卡的 revision 走：跑完一轮 Agent 会往里加一条回复。
  useEffect(() => {
    let cancelled = false
    void api.comments(task.id)
      .then(({ comments: loaded }) => { if (!cancelled) setComments(loaded) })
      .catch(() => { if (!cancelled) setComments([]) })
    return () => { cancelled = true }
  }, [task.id, task.revision, runs.length])

  useEffect(() => {
    if (latest === undefined) return undefined
    return subscribeRun(latest.id, (event) => {
      setEvents((prev) => (prev.some((e) => e.seq === event.seq) ? prev : [...prev, event]))
    })
  }, [latest])

  // 只在有执行记录时拉 diff；卡片状态变了要重拉（留言之后又跑了一轮）。
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

  /** 动作成功就收工回看板；失败留在原地。 */
  const closeIfOk = (ok: boolean): void => { if (ok) onClose() }

  /** 把这张卡派给某个执行器。 */
  const dispatch = (provider: string): void => {
    setBusy(true)
    void api.run(task.id, provider)
      .then(() => { onChanged() })
      .catch((error: unknown) => {
        if (error instanceof ApiError) onError(error.code, error.message)
      })
      .finally(() => { setBusy(false) })
  }

  /**
   * 统一处理验收动作的忙碌态与错误上报。
   *
   * 返回是否成功 —— 保存之后要关掉弹窗，而失败时必须留在原地，
   * 否则用户的改动连同那条错误一起消失了。
   */
  const act = async (call: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await call()
      onChanged()
      return true
    } catch (error) {
      if (error instanceof ApiError) onError(error.code, error.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[82vh] max-h-[820px] w-[860px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl border-hairline bg-panel p-0 shadow-lg sm:max-w-[92vw]"
      >
        <header className="flex items-start gap-2 border-b border-hairline px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="tag">{task.id}</span>
              <span className="lamp" data-state={archived ? 'idle' : task.column} />
              <span className="chrome-label !text-[9px]">{task.column}</span>
              {rounds > 0 ? (
                <span
                  className="mono text-[10px] text-sodium-deep"
                  title={t('panel.roundsHint')}
                >
                  {t('panel.rounds', { n: rounds })}
                </span>
              ) : null}
            </div>
            <DialogTitle asChild>
              <h2 className="mt-2 line-clamp-2 text-[15px] font-semibold leading-snug text-ink">
                {taskTitle(task)}
              </h2>
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-ink-faint">
              {project?.name ?? t('panel.unknownProject')} · {t('panel.baseLabel')}{' '}
              <span className="mono">{task.baseBranch}</span>
            </DialogDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || task.column === 'running'}
            {...(task.column === 'running' ? { title: t('panel.archiveBlocked') } : {})}
            onClick={() => {
              void act(() => (archived
                ? api.unarchive(task.id, task.revision)
                : api.archive(task.id, task.revision)))
            }}
          >
            {archived
              ? <><ArchiveRestore />{t('panel.unarchive')}</>
              : <><Archive />{t('panel.archive')}</>}
          </Button>
          {deletable ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              title={confirmDelete ? t('panel.deleteArmed') : t('panel.deleteHint')}
              onClick={() => {
                if (!confirmDelete) { setConfirmDelete(true); return }
                remove()
              }}
              className={cn(
                'border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail',
                confirmDelete && 'border-lamp-fail bg-lamp-fail/10',
              )}
            >
              <Trash2 />{confirmDelete ? t('panel.deleteConfirm') : t('panel.delete')}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('panel.close')} title={t('panel.closeHint')}>
            <X />
          </Button>
        </header>

        {/* 归档的卡是冻结的：派活、验收、改需求全部拒绝，只剩"取出"和"删除"
            两个动作（删除和归档指向同一个方向，不必先取出来再删一次）。
            与其把按钮摆在那儿等服务端拒绝，不如直接换成一条说明。 */}
        {archived ? (
          <div className="flex items-start gap-2 border-b border-hairline bg-raised/40 px-4 py-2.5">
            <Archive className="mt-[3px] size-3.5 flex-none text-ink-faint" />
            <p className="min-w-0 text-xs leading-relaxed text-ink-faint">
              {task.archivedAt === undefined
                ? null
                : `${t('panel.archivedAt', { at: new Date(task.archivedAt).toLocaleString() })} `}
              {t('panel.archivedNote', { column: task.column })}
            </p>
          </div>
        ) : null}

        {/* 派活 / 取消。只有 ready 的卡能派，running 的能停。 */}
        {!archived && (task.column === 'ready' || task.column === 'running') ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
            {task.column === 'ready' ? (
              <>
                <span className="text-xs text-ink-faint">{t('panel.dispatchTo')}</span>
                {agents.length === 0 ? (
                  <span className="cjk-label !text-lamp-fail">{t('panel.noAgents')}</span>
                ) : task.preferredProvider === undefined ? (
                  // 没指定执行器：三个都摆出来，点哪个是哪个。
                  agents.map((agent) => (
                    <Button
                      key={agent.id}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      {...(agent.permissionCaveat === undefined ? {} : { title: agent.permissionCaveat.detail })}
                      onClick={() => { dispatch(agent.id) }}
                    >
                      <Play />{agent.id}
                      {agent.permissionCaveat === undefined ? null : (
                        <span className="text-xs text-sodium">{agent.permissionCaveat.label}</span>
                      )}
                    </Button>
                  ))
                ) : pinned === undefined ? (
                  // 指定的执行器本机没探测到。这里不给"换一个派"的口子 ——
                  // 卡上写着要谁干，就不该在派活这一步偷偷换人。
                  <span className="text-xs text-lamp-fail">
                    {t('panel.pinnedMissing', { provider: task.preferredProvider })}
                  </span>
                ) : (
                  <>
                    {/* 指定过了就只派给它，连模型一起标出来 —— 这一屏只剩一个动作。 */}
                    <Button
                      size="sm"
                      disabled={busy}
                      {...(pinned.permissionCaveat === undefined ? {} : { title: pinned.permissionCaveat.detail })}
                      onClick={() => { dispatch(pinned.id) }}
                    >
                      <Play />{pinned.id}{task.model === undefined ? '' : ` · ${task.model}`}
                    </Button>
                    {pinned.permissionCaveat === undefined ? null : (
                      <span className="text-xs text-sodium">{pinned.permissionCaveat.label}</span>
                    )}
                  </>
                )}
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || latest === undefined}
                onClick={() => {
                  if (latest === undefined) return
                  setBusy(true)
                  void api.cancel(latest.id).then(() => { onChanged() }).finally(() => { setBusy(false) })
                }}
                className="border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail"
              >
                <Square />{t('panel.stop')}
              </Button>
            )}
          </div>
        ) : null}

        {/* 验收：通过 / 废弃。要它再改一版，去讨论里留言。只有 review 列的卡看得到。 */}
        {!archived && task.column === 'review' ? (
          <div className="border-b border-hairline px-4 py-3">
            {/* 失败的执行也停在这一列，所以必须一眼看出这次是成是败 ——
                否则"通过"按钮会摆在一堆没跑完的活旁边。 */}
            {latest !== undefined && latest.status !== 'completed' ? (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2">
                <TriangleAlert className="mt-[3px] size-3.5 flex-none text-lamp-fail" />
                <p className="min-w-0 text-xs leading-relaxed text-lamp-fail">
                  {latest.status === 'aborted' ? t('panel.runAborted') : t('panel.runFailed')}
                  {latest.diagnostic === undefined ? null : (
                    <span className="mono block break-words">{latest.diagnostic}</span>
                  )}
                  {t('panel.runFailedHint')}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {/* 验收动作都是"对这张卡的最后一句话"：判完就回看板。
                  失败留在原地，让人看见错误再决定（同保存、同留言）。 */}
              <Action
                icon={<GitMerge />} label={t('panel.acceptMerge')} tone="primary" busy={busy}
                onClick={() => { void act(() => api.accept(task.id, true)).then(closeIfOk) }}
              />
              <Action
                icon={<Check />} label={t('panel.accept')} tone="ok" busy={busy}
                onClick={() => { void act(() => api.accept(task.id, false)).then(closeIfOk) }}
              />
              <span className="flex-1" />
              <Action
                icon={<Trash2 />} label={t('panel.discard')} tone="fail" busy={busy}
                onClick={() => { void act(() => api.discard(task.id)).then(closeIfOk) }}
              />
            </div>

            <p className="mt-2 text-xs leading-relaxed text-ink-faint">
              {t('panel.acceptNote', { branch: latest?.branch ?? '' })}
            </p>
          </div>
        ) : null}

        {/* 顺序即翻卡的顺序：先看要做什么，再看做成了什么，最后才是过程。 */}
        <Tabs defaultValue="spec" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex-none border-b border-hairline px-4 py-2.5">
            <TabsList>
              {(['spec', 'talk', 'diff', 'stream', 'runs'] as const).map((value) => (
                <TabsTrigger key={value} value={value} className="px-3">
                  {t(`panel.tab.${value}`)}
                  {value === 'talk' && comments.length > 0 ? (
                    <span className="mono text-[10px] text-ink-faint">{comments.length}</span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="spec" className="mt-0 flex min-h-0 flex-1 flex-col">
            <TaskEditor
              task={task}
              project={project}
              agents={agents}
              busy={busy}
              onError={onError}
              // 附件是即时生效的：传完 / 删完要让看板知道，卡片上那枚回形针
              // 的数字才跟得上。**不关弹窗** —— 人多半还要接着写需求。
              onChanged={onChanged}
              onSave={(edit: TaskEdit) => {
                // 存完就收工，回到看板；存失败留在原地，让人看见错误再决定。
                void act(() => api.edit(task.id, task.revision, edit)).then((ok) => { if (ok) onClose() })
              }}
            />
          </TabsContent>

          <TabsContent value="talk" className="mt-0 flex min-h-0 flex-1 flex-col">
            <Discussion
              comments={comments}
              busy={busy}
              /** Review 里留言会把卡送回队列，按钮上得先说清楚。 */
              requeues={task.column === 'review'}
              onSend={(body) => {
                setBusy(true)
                void api.comment(task.id, body)
                  .then(({ comments: next }) => {
                    setComments(next)
                    onChanged()
                    // 说完就收工，回到看板 —— 话已经带给下一轮了，留在这儿没事可做。
                    // 失败则留在原地，让人看见错误再决定（同保存）。
                    onClose()
                  })
                  .catch((error: unknown) => {
                    if (error instanceof ApiError) onError(error.code, error.message)
                  })
                  .finally(() => { setBusy(false) })
              }}
            />
          </TabsContent>

          <TabsContent value="diff" className="mt-0 flex min-h-0 flex-1 flex-col">
            {diff === null ? <Empty text={t('panel.noDiff')} /> : <DiffView diff={diff} />}
          </TabsContent>

          <TabsContent value="stream" className="mt-0 flex min-h-0 flex-1 flex-col">
            {latest === undefined ? (
              <Empty text={t('panel.noRun')} />
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-hairline/60 px-4 py-2">
                  <span className="chrome-label">{latest.provider}</span>
                  <span className="mono text-[10px] text-ink-faint">{latest.cliVersion}</span>
                  <span className="flex-1" />
                  <span className="mono text-[10px] text-ink-faint">{latest.branch}</span>
                </div>
                <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
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
                  {events.length === 0 ? <Empty text={t('panel.waiting')} /> : null}
                </div>
                {toolCounts.length > 0 ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-hairline/60 px-4 py-2">
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

          <TabsContent value="runs" className="mt-0 min-h-0 flex-1 overflow-y-auto">
            {runs.length === 0 ? <Empty text={t('panel.noRuns')} /> : runs.map((run, index) => (
              <div key={run.id} className="border-b border-hairline/60 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="lamp" data-state={run.status === 'completed' ? 'done' : run.status} />
                  {/* 最新的排在最前面，所以轮次要倒着数回去。 */}
                  <span className="mono text-[10px] text-sodium-deep">
                    {t('panel.round', { n: rounds - index })}
                  </span>
                  <span className="chrome-label">{run.provider}</span>
                  <span className="mono text-[10px] text-ink-faint">{run.cliVersion}</span>
                  <span className="flex-1" />
                  <span className="mono text-[10px] text-ink-faint">
                    {run.endedAt === undefined
                      ? t('panel.inProgress')
                      : `${String(Math.round((run.endedAt - run.startedAt) / 1000))}s`}
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
  /** primary 是这一屏的主动作，实心；ok / fail 只借个色，形制仍是描边。 */
  tone?: 'primary' | 'ok' | 'fail'
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant={tone === 'primary' ? 'default' : 'outline'}
      disabled={busy}
      onClick={onClick}
      className={cn(
        tone === 'ok' && 'border-lamp-ok/40 text-lamp-ok hover:bg-lamp-ok/10 hover:text-lamp-ok',
        tone === 'fail' && 'border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail',
      )}
    >
      {icon}{label}
    </Button>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="cjk-label p-6 text-center">{text}</p>
}

/**
 * 讨论线程：Agent 的回复与人的留言按时间排开，底下是输入框。
 *
 * 这条线程不只是给人看的记录 —— 下一次执行会把它整段交给 Agent，所以
 * 「说了什么」和「什么时候说的」都要能对上号。
 */
function Discussion({ comments, busy, requeues, onSend }: {
  comments: TaskComment[]
  busy: boolean
  requeues: boolean
  onSend: (body: string) => void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [comments.length])

  const send = (): void => {
    const body = draft.trim()
    if (body.length === 0) return
    onSend(body)
    setDraft('')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {comments.length === 0 ? (
          <Empty text={t('talk.empty')} />
        ) : comments.map((comment) => (
          <div key={comment.id} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              {comment.author === 'agent'
                ? <Bot className="size-3.5 text-sodium" />
                : <User className="size-3.5 text-ink-faint" />}
              <span className={cn(
                'text-xs font-medium',
                comment.author === 'agent' ? 'text-sodium' : 'text-ink',
              )}>
                {comment.author === 'agent' ? 'Agent' : t('talk.you')}
              </span>
              <span className="mono text-[10px] text-ink-faint">
                {new Date(comment.at).toLocaleString()}
              </span>
            </div>
            <div className={cn(
              'rounded-lg border px-3 py-2 text-[13px]',
              comment.author === 'agent'
                ? 'border-hairline bg-sunken/40'
                : 'border-sodium-deep/30 bg-sodium/[0.05]',
            )}>
              {renderMarkdown(comment.body)}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="flex-none space-y-2 border-t border-hairline px-4 py-3">
        <Textarea
          value={draft}
          disabled={busy}
          placeholder={requeues ? t('talk.placeholderRequeue') : t('talk.placeholder')}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            // ⌘/Ctrl + Enter 发出去；单独回车留给换行 —— 这里写的是段落，不是聊天。
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
          }}
          className="min-h-20"
        />
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-ink-faint">
            {requeues ? t('talk.noteRequeue') : t('talk.note')}
          </p>
          <Button size="sm" disabled={busy || draft.trim().length === 0} onClick={send}>
            <Send />{t('talk.send')}
          </Button>
        </div>
      </div>
    </div>
  )
}
