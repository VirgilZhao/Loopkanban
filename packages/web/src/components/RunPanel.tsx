import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import {
  Archive, ArchiveRestore, Bot, Check, ExternalLink, GitBranch, GitMerge, GitPullRequest, Play,
  RefreshCw, Send, Square, Trash2, TriangleAlert, User, X,
} from 'lucide-react'
import { api, ApiError, subscribeRun, type NextRound } from '@/api.ts'
import { DiffView } from '@/components/DiffView.tsx'
import { FilePreviewPane } from '@/components/FilePreview.tsx'
import { TaskEditor } from '@/components/TaskEditor.tsx'
import { summarize } from '@/lib/events.ts'
import { maybe, useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { modelOptions, taskTitle } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import type {
  Agent, DiffView as Diff, PrCapability, Project, PullRequest, Run, StreamEvent, Task, TaskComment,
  TaskEdit,
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

/** 面板里的分页，顺序即翻卡的顺序。`talk` 要等讨论里有话才出现。 */
const TABS = ['spec', 'talk', 'diff', 'stream', 'runs'] as const
type Tab = (typeof TABS)[number]

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
  // 这张卡开过的 PR，以及这个仓库到底能不能开 PR。后者决定"通过并合并"
  // 那颗按钮的行为 —— 开不了就退回本地合并，并把原因写在按钮下面。
  const [prs, setPrs] = useState<PullRequest[]>([])
  const [capability, setCapability] = useState<PrCapability | null>(null)
  const [prNote, setPrNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  // 讨论里点开的那份文档。Agent 写的方案就在它自己的 worktree 里，
  // 链接在浏览器里是死的 —— 这里把它读回来盖在弹窗上。
  const [preview, setPreview] = useState<string | null>(null)
  // 删除不可撤销，所以要点两次：第一次只是把按钮"上膛"。
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tab, setTab] = useState<Tab>('spec')
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
  /**
   * 在这张卡上说一句就等于"再改一版"的两列。
   *
   * Review 一直如此；Done 也算 —— "合上去才发现还差一条"本来就是同一张卡
   * 的下一轮，另开一张新卡会把讨论、工作区、已经合过的 PR 全丢掉。所以
   * 这两列**即使一句话都还没有**也要摆出讨论，那正是触发下一轮的入口。
   */
  const canTalk = task.column === 'review' || task.column === 'done'
  /**
   * 摆不摆讨论这一页。
   *
   * 别的列看的是「有没有话」：新建的卡那儿一片空白，摆着只会让人以为漏看了
   * 什么；要交代什么去规格里写。而「有没有」而不是「Agent 回没回」——
   * 只有 Agent 回过才显示的话，一条早于首轮执行的人类留言就成了看不见的
   * 东西，而它照样会被塞进下一次执行的 prompt 与 TASK.md 里。
   */
  const discussed = comments.length > 0 || canTalk
  /** 这张卡还有没有 PR 开着 —— 有的话"刷新状态"才有意义。 */
  const pending = prs.some((pr) => pr.state === 'open')
  /** 开着的 PR 里有冲突的：基线在开完之后又往前走了，得再走一遍那条路。 */
  const stale = prs.some((pr) => pr.state === 'open' && pr.mergeable === 'conflicting')
  /** 干活的那条分支。没跑过的卡还没有分支可言。 */
  const branch = latest?.branch
  /** 此刻真正摆出来的分页。 */
  const visible = TABS.filter((value) => value !== 'talk' || discussed)

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

  // 换了一张卡先把上一张的讨论清掉，免得新卡的请求回来之前串台。
  useEffect(() => { setComments([]) }, [task.id])

  // 讨论跟着卡的 revision 走：跑完一轮 Agent 会往里加一条回复。
  useEffect(() => {
    let cancelled = false
    void api.comments(task.id)
      .then(({ comments: loaded }) => { if (!cancelled) setComments(loaded) })
      // 拉失败就留着手上这份：清空会让整条线程连同讨论 tab 一起消失，
      // 而一次网络抖动不是"这张卡没有讨论"。
      .catch(() => {})
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

  // PR 跟着卡的 revision 走：开完一条、或者巡检把它收进 Done，这里都要跟上。
  // 顺带问一次"这个仓库能不能开 PR" —— 那是按钮行为的依据，不能等到点下去
  // 才发现本机没有 gh。
  useEffect(() => {
    let cancelled = false
    void api.prs(task.id)
      .then(({ prs: list, capability: caps }) => {
        if (cancelled) return
        setPrs(list)
        setCapability(caps)
      })
      // 拉失败就留着手上这份：清空会让已经开出去的 PR 从界面上消失，
      // 而一次网络抖动不是"这张卡没有 PR"。
      .catch(() => {})
    return () => { cancelled = true }
  }, [task.id, task.revision])

  // 换了一张卡，上一张的 PR 提示不该跟着漂过来。
  useEffect(() => { setPrNote(null) }, [task.id])

  // 换了一张卡就把"上膛"收回去 —— 上一张卡的危险状态不该跟着漂到下一张。
  // 预览与分页同理：上一张卡的文档不该盖在这一张上面，新卡也该从规格看起。
  useEffect(() => { setConfirmDelete(false); setPreview(null); setTab('spec') }, [task.id])

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

  /*
   * 预览开着的时候，esc 关的是预览，不是整张卡。
   *
   * 听 esc 的一共有两处，都要拦下来：Radix 的 Dialog 在 document 的**捕获
   * 阶段**听（所以后挂的监听抢不到它前面，只能靠下面 onEscapeKeyDown 里的
   * preventDefault），App 还在 window 上另听一份（捕获阶段 stopPropagation
   * 就到不了它那儿）。少拦一处，看完一份文档整张卡就跟着关了。
   */
  useEffect(() => {
    if (preview === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPreview(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [preview])

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

  /**
   * 「通过并合并」：开一条 PR，然后把话说清楚。
   *
   * 这里**不关弹窗**，与其他验收动作相反 —— PR 开出来之后还有下一步（去
   * GitHub 上看、合），那条链接就在下面这块里，关掉等于让人自己再点开一次。
   */
  const openPr = (): void => {
    setBusy(true)
    setPrNote(null)
    void api.openPr(task.id)
      .then(({ pr, created, prs: list }) => {
        setPrs(list)
        setPrNote({ tone: 'ok', text: t(created ? 'pr.opened' : 'pr.reused', { n: pr.number }) })
        onChanged()
      })
      .catch((error: unknown) => {
        if (!(error instanceof ApiError)) return
        if (error.code === 'merge-conflict') {
          /*
           * 冲突不关弹窗：卡虽然回了队列，但接下来要看的东西全在这儿 ——
           * 讨论里那条"怎么解"的留言、以及解完之后再点一次的这颗按钮。
           * 文件名从响应体里取，不从那句中文 detail 里抠。
           */
          const files = error.body['files']
          const dispatched = typeof error.body['dispatched'] === 'string'
          // 卡回没回队列由服务端说了算，**不能靠猜**：上一轮的冲突还没解完时
          // 这条路也会走到，而那种情况下卡一直停在 Review —— 照着"已经回队列了"
          // 说，人会对着一张明明还在 Review 的卡去队列里找它。
          const requeued = error.body['requeued'] === true
          setPrNote({
            tone: 'warn',
            text: [
              Array.isArray(files) && files.length > 0
                ? t('pr.conflict', { files: (files as string[]).join(t('sidebar.agentsSeparator')) })
                : null,
              dispatched ? t('pr.conflictDispatched')
                : requeued ? t('pr.conflictHandoff')
                : t('pr.conflictStuck'),
            ].filter((part) => part !== null).join(' '),
          })
          onChanged()
          return
        }
        onError(error.code, error.message)
        setPrNote({ tone: 'warn', text: error.message })
      })
      .finally(() => { setBusy(false) })
  }

  /** 问一遍 GitHub：合上了没有。合上了的话卡这就进 Done。 */
  const syncPr = (): void => {
    setBusy(true)
    setPrNote(null)
    void api.syncPrs(task.id)
      .then(({ prs: list, collected }) => {
        setPrs(list)
        setPrNote(collected.includes(task.id)
          ? { tone: 'ok', text: t('pr.collected') }
          : { tone: 'warn', text: t('pr.stillOpen') })
        onChanged()
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) setPrNote({ tone: 'warn', text: error.message })
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => { if (preview !== null) event.preventDefault() }}
        className={cn(
          'flex h-[82vh] max-h-[820px] gap-0 overflow-hidden rounded-xl border-hairline bg-panel p-0 shadow-lg',
          // 预览是在右边**新开一栏**，不是盖在卡上面：文档和需求本来就要对着
          // 看 —— 盖上去的话，读到一半想核对验收标准还得先把文档关掉。
          // 任务那栏缩到正常的一半，弹窗整体让出地方给文档。
          preview === null
            ? 'w-[860px] max-w-[92vw] sm:max-w-[92vw]'
            : 'w-[1320px] max-w-[96vw] sm:max-w-[96vw]',
          'transition-[width,max-width] duration-200',
        )}
      >
        {/* 任务这一栏。开着预览时缩到 430px —— 正好是它平时的一半。 */}
        <div className={cn(
          'flex min-w-0 flex-col',
          preview === null ? 'flex-1' : 'w-[430px] max-w-[45%] flex-none',
        )}>
          {/* 缩到半幅时按钮挤不下就整组换行 —— 标题给一个下限，不然
              `min-w-0` 会让它一路被压成一条窄缝，而按钮仍旧赖在同一行。 */}
          <header className="flex flex-wrap items-start gap-2 border-b border-hairline px-4 py-3">
            <div className="min-w-[240px] flex-1">
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
              {/* 基线之外还要标出**自己那条分支** —— 「我的改动到底在哪儿」
                  是打开这张卡最先想知道的事，而它此前只能去 Diff 页里翻。
                  没跑过的卡还没有分支，那时只说基线。 */}
              <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                <span>{project?.name ?? t('panel.unknownProject')}</span>
                <span className="inline-flex items-center gap-1">
                  {t('panel.baseLabel')} <span className="mono">{task.baseBranch}</span>
                </span>
                {branch === undefined ? null : (
                  <span className="inline-flex min-w-0 items-center gap-1 text-sodium-deep" title={t('panel.branchHint')}>
                    <GitBranch className="size-3 flex-none" />
                    <span className="mono min-w-0 truncate">{branch}</span>
                  </span>
                )}
              </DialogDescription>
            </div>
            {/* 三个按钮当一整组换行 —— 拆开换会变成「归档」留在标题那行、
                「删除」孤零零掉到下一行，看着像排版出了岔子。 */}
            <div className="ms-auto flex items-center gap-2">
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
            </div>
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
                {/* 主动作：能开 PR 就开 PR（改动推上去、开一条、冲突提前引爆），
                    开不了才退回本地合并。两种行为都写在下面那句说明里 ——
                    悄悄换一种做法，是这颗按钮最不该给的惊喜。 */}
                <Action
                  icon={capability?.ready === true ? <GitPullRequest /> : <GitMerge />}
                  label={t('panel.acceptMerge')} tone="primary"
                  // 能力还没问回来时先按不动：这颗按钮的两种行为差得很远
                  // （开 PR / 动你的主工作区），抢在答案之前点下去等于抽签。
                  busy={busy || capability === null}
                  onClick={capability?.ready === true
                    ? openPr
                    : () => { void act(() => api.accept(task.id, true)).then(closeIfOk) }}
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

              {capability === null ? null : (
                <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                  {capability.ready
                    ? t('pr.willOpen', { repo: capability.repo ?? '', base: task.baseBranch })
                    // 原因按码本地化 —— 服务端那句是中文的，直接贴给英文界面
                    // 就成了半句中文。认不出的码才退回它。
                    : t('pr.fallback', {
                        detail: maybe(t, `err.${capability.reason ?? ''}`, capability.detail ?? ''),
                      })}
                </p>
              )}
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                {t('panel.acceptNote', { branch: latest?.branch ?? '' })}
              </p>
            </div>
          ) : null}

          {/* 这张卡开出去的 PR。**Review 与 Done 都摆**：Review 里它是"去合"的
              入口，Done 里它是"这张卡到底怎么进主干的"那份账 —— 一张卡可以
              合过好几条（每一轮一条），全列出来才看得出经过。 */}
          {prs.length > 0 || prNote !== null ? (
            <div className="border-b border-hairline px-4 py-3">
              <div className="flex items-center gap-2">
                <GitPullRequest className="size-3.5 flex-none text-sodium" />
                <span className="chrome-label">{t('pr.title')}</span>
                <span className="flex-1" />
                {pending ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={syncPr}>
                    <RefreshCw />{t('pr.refresh')}
                  </Button>
                ) : null}
              </div>

              <ul className="mt-2 space-y-1.5">
                {prs.map((pr) => (
                  <li key={pr.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mono inline-flex flex-none items-center gap-1 text-sodium-deep hover:underline"
                    >
                      #{pr.number}<ExternalLink className="size-3" />
                    </a>
                    <span className={cn(
                      'chrome-label',
                      pr.state === 'merged' && '!text-lamp-ok',
                      pr.state === 'closed' && '!text-ink-faint',
                    )}>
                      {t(`pr.state.${pr.state}`)}
                    </span>
                    {/* 冲突只在还开着的 PR 上说 —— 合过的那条早就没这回事了。 */}
                    {pr.state === 'open' && pr.mergeable === 'conflicting' ? (
                      <span className="text-lamp-fail">{t('pr.conflicting')}</span>
                    ) : null}
                    <span className="mono min-w-0 truncate text-ink-faint">
                      {pr.branch} → {pr.baseBranch}
                    </span>
                    {pr.mergedAt === undefined ? null : (
                      <span className="mono flex-none text-ink-faint">
                        {new Date(pr.mergedAt).toLocaleString()}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {prNote === null ? null : (
                <p className={cn(
                  'mt-2 text-xs leading-relaxed',
                  prNote.tone === 'ok' ? 'text-lamp-ok' : 'text-sodium',
                )}>
                  {prNote.text}
                </p>
              )}
              {/* 合不合由人在 GitHub 上决定 —— 我们只负责在它真的合上之后
                  把卡收进 Done。所以这句提示必须摆着。 */}
              {pending ? (
                <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                  {stale ? t('pr.conflictingHint') : t('pr.pendingHint')}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* 顺序即翻卡的顺序：先看要做什么，再看做成了什么，最后才是过程。
              讨论 tab 会随线程有无进出，选中的那个可能中途消失 —— 受控着来，
              并在它不在了的时候退回规格；否则面板底下就是一片空白。 */}
          <Tabs
            value={visible.includes(tab) ? tab : 'spec'}
            onValueChange={(value) => { setTab(value as Tab) }}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="flex-none border-b border-hairline px-4 py-2.5">
              <TabsList>
                {visible.map((value) => (
                  <TabsTrigger key={value} value={value} className="px-3">
                    {t(`panel.tab.${value}`)}
                    {value === 'talk' ? (
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

            {discussed ? (
              <TabsContent value="talk" className="mt-0 flex min-h-0 flex-1 flex-col">
                <Discussion
                  task={task}
                  agents={agents}
                  comments={comments}
                  busy={busy}
                  onOpenFile={setPreview}
                  /** Review 与 Done 里留言都会把卡送回队列，按钮上得先说清楚。 */
                  requeues={canTalk}
                  onSend={async (body, edit) => {
                    setBusy(true)
                    try {
                      const { comments: next } = await api.comment(task.id, body, edit)
                      setComments(next)
                      onChanged()
                      // 说完就收工，回到看板 —— 话已经带给下一轮了，留在这儿没事可做。
                      onClose()
                      return null
                    } catch (error) {
                      // 失败留在原地。看板上那条通知在弹窗背后，所以错误还要
                      // 回给输入框自己显示一遍 —— 否则只看得见一个空框。
                      if (error instanceof ApiError) {
                        onError(error.code, error.message)
                        return error.message
                      }
                      return t('talk.sendFailed')
                    } finally {
                      setBusy(false)
                    }
                  }}
                />
              </TabsContent>
            ) : null}

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
        </div>

        {preview === null ? null : (
          <FilePreviewPane
            taskId={task.id}
            path={preview}
            onOpen={setPreview}
            onClose={() => { setPreview(null) }}
          />
        )}
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

/**
 * 讨论区那两个小下拉。
 *
 * 只可选、不可填 —— 能选的都是探测出来的，手打一个 CLI 不认的名字
 * 只会在派活那一刻才炸。
 */
function Picker({ value, label, disabled, onChange, children }: {
  value: string
  label: string
  disabled: boolean
  onChange: (value: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <select
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => { onChange(event.target.value) }}
      className={cn(
        'mono border-input h-8 max-w-[220px] rounded-md border bg-transparent px-2 text-xs shadow-xs',
        'transition-[color,box-shadow] outline-none dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </select>
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
 *
 * 输入框上还带着「下一轮交给谁、用哪个模型」：说"再改一版"和"这次换个人干"
 * 本来就是同一句话，不该逼人先去规格里存一遍再回来发言。改动跟着这条留言
 * 一起发出去 —— 光换个下拉不发言，等于什么都没说。
 */
function Discussion({ task, agents, comments, busy, requeues, onOpenFile, onSend }: {
  task: Task
  agents: Agent[]
  comments: TaskComment[]
  busy: boolean
  requeues: boolean
  /** 点开回复里的一条文档链接。 */
  onOpenFile: (path: string) => void
  /** 发出去；成功回 null，失败回一句能显示给人看的话（草稿会原样留着）。 */
  onSend: (body: string, next: NextRound) => Promise<string | null>
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [provider, setProvider] = useState(task.preferredProvider)
  const [model, setModel] = useState(task.model)
  const bottomRef = useRef<HTMLDivElement>(null)
  // 同规格表单的两种冻结：执行中的卡改了也存不进去，归档的卡内容是冻的。
  const locked = task.column === 'running' || task.archivedAt !== undefined
  const lockReason = task.column === 'running' ? t('editor.lockedRunning') : t('editor.lockedArchived')
  /** 选定的执行器；没选（"任意"）或本机没探测到，就没有模型这一说。 */
  const picked = agents.find((agent) => agent.id === provider)
  const models = picked === undefined ? [] : modelOptions(picked, model)
  // 卡上指定的执行器本机没探测到时也要能选回来 —— 下拉里少了它，
  // 一打开就等于把这张卡的选择改成了别人。
  const providers = provider !== undefined && picked === undefined
    ? [provider, ...agents.map((agent) => agent.id)]
    : agents.map((agent) => agent.id)

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [comments.length])

  // 卡被外部改动（跑完一轮、别处改了规格）后跟上，别拿着旧值去覆盖新状态。
  useEffect(() => {
    setProvider(task.preferredProvider)
    setModel(task.model)
  }, [task.id, task.revision])

  const send = (): void => {
    const body = draft.trim()
    if (body.length === 0) return
    setFailure(null)
    // 只送真正变了的字段：没动过就别提它，免得白白顶掉一个 revision。
    void onSend(body, {
      ...(provider === task.preferredProvider ? {} : { preferredProvider: provider }),
      ...(model === task.model ? {} : { model }),
    }).then((error) => {
      // 发不出去就把话留在框里。这一段是人一个字一个字敲的，
      // 而"卡刚被人认领了"这种拒绝重试一次就过去了 —— 不该让他重打一遍。
      if (error === null) setDraft('')
      else setFailure(error)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {comments.map((comment) => (
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
              {renderMarkdown(comment.body, { onOpenFile })}
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

        {/* 一台 Agent 都没探测到、卡上也没指定过谁：这儿没有可选的，不摆空下拉。 */}
        {providers.length === 0 ? null : (
          <div
            className="flex flex-wrap items-center gap-2"
            {...(locked ? { title: lockReason } : {})}
          >
            <span className="flex-none text-xs text-ink-faint">{t('talk.nextRound')}</span>
            <Picker
              value={provider ?? ''}
              disabled={busy || locked}
              label={t('editor.provider')}
              onChange={(next) => {
                // 换人就把模型清掉：模型名是各家 CLI 自己的说法，
                // 留着一个别人不认识的名字只会在派活时炸。（同规格表单）
                setProvider(next.length === 0 ? undefined : next)
                setModel(undefined)
              }}
            >
              <option value="">{t('editor.providerAny')}</option>
              {providers.map((id) => <option key={id} value={id}>{id}</option>)}
            </Picker>
            {/* 能不能指定模型是**探测**出来的：不认 --model 的 CLI 这儿就没有这一栏。 */}
            {picked === undefined || !picked.canPickModel || models.length === 0 ? null : (
              <Picker
                value={model ?? ''}
                disabled={busy || locked}
                label={t('editor.model')}
                onChange={(next) => { setModel(next.length === 0 ? undefined : next) }}
              >
                <option value="">{t('editor.modelDefault')}</option>
                {models.map((id) => <option key={id} value={id}>{id}</option>)}
              </Picker>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {failure === null ? (
            <p className="flex-1 text-xs text-ink-faint">
              {requeues ? t('talk.noteRequeue') : t('talk.note')}
            </p>
          ) : (
            <p className="flex-1 text-xs text-lamp-fail">{failure}</p>
          )}
          <Button size="sm" disabled={busy || draft.trim().length === 0} onClick={send}>
            <Send />{t('talk.send')}
          </Button>
        </div>
      </div>
    </div>
  )
}
