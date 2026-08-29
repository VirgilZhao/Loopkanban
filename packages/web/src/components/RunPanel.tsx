import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import {
  Archive, ArchiveRestore, Check, CircleAlert, CircleStop, ExternalLink, FlaskConical,
  GitBranch, GitMerge, GitPullRequest, Play, RefreshCw, Square, Trash2, TriangleAlert, X,
} from 'lucide-react'
import { api, ApiError, subscribeRun } from '@/api.ts'
import { DecisionBar } from '@/components/DecisionBar.tsx'
import { DiffView } from '@/components/DiffView.tsx'
import { Discussion } from '@/components/Discussion.tsx'
import { FilePreviewPane } from '@/components/FilePreview.tsx'
import { TaskEditor } from '@/components/TaskEditor.tsx'
import { TestEnvLogPane, useTestEnv } from '@/components/TestEnvPanel.tsx'
import { summarize } from '@/lib/events.ts'
import { explain, useT } from '@/lib/i18n.tsx'
import { taskTitle } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import type {
  Agent, DiffView as Diff, PrCapability, Project, PullRequest, Run, RunDecision,
  StreamEvent, Task, TaskComment, TaskEdit,
} from '@/types.ts'

/** 事件类型 → 展示样式。未知类型一律走 raw 的样子，不丢弃。 */
const EVENT_STYLE: Record<string, { label: string; tone: string }> = {
  session:  { label: 'SESSION',  tone: 'text-lamp-review' },
  notice:   { label: 'NOTICE',   tone: 'text-sodium' },
  text:     { label: 'TEXT',     tone: 'text-ink' },
  tool:     { label: 'TOOL',     tone: 'text-sodium-deep' },
  usage:    { label: 'USAGE',    tone: 'text-ink-faint' },
  finished: { label: 'FINISH',   tone: 'text-lamp-ok' },
  decision: { label: 'ASK',      tone: 'text-sodium' },
  decision_resolved: { label: 'ASK', tone: 'text-sodium' },
  raw:      { label: 'RAW',      tone: 'text-ink-faint/60' },
}


/** 面板里的分页，顺序即翻卡的顺序。`talk` 要等讨论里有话才出现。 */
const TABS = ['spec', 'talk', 'diff', 'stream', 'runs'] as const
type Tab = (typeof TABS)[number]

interface Props {
  task: Task
  /** 任务所属项目。任务干活的地方是它派生出来的 worktree。 */
  project: Project | null
  /** 同项目的其它卡片，规格里挑关联用。 */
  siblings: Task[]
  agents: Agent[]
  /**
   * 打开时先摆出这份文档（右边那一栏）。
   *
   * 右侧面板的讨论里点一条文档链接会走这条路 —— 那块地方太窄，摊不开一份
   * 文档，所以把它交给这张弹窗。只在挂载那一刻读一次。
   */
  initialPreview?: string | undefined
  onChanged: () => void
  onClose: () => void
}

export function RunPanel({
  task, project, siblings, agents, initialPreview, onChanged, onClose,
}: Props): React.JSX.Element {
  const t = useT()
  const [runs, setRuns] = useState<Run[]>([])
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [comments, setComments] = useState<TaskComment[]>([])
  const [events, setEvents] = useState<StreamEvent[]>([])
  // 这一次执行里等人拍板的决策。面板打开时拉一遍，之后靠事件流增量跟上 ——
  // Agent 停下来等审批或等回答时，这张卡要立刻把话递到人眼前。
  const [decisions, setDecisions] = useState<RunDecision[]>([])
  // 这张卡开过的 PR，以及这个仓库到底能不能开 PR。后者决定"通过并合并"
  // 那颗按钮的行为 —— 开不了就退回本地合并，并把原因写在按钮下面。
  const [prs, setPrs] = useState<PullRequest[]>([])
  const [capability, setCapability] = useState<PrCapability | null>(null)
  const [prNote, setPrNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  // 讨论里点开的那份文档。Agent 写的方案就在它自己的 worktree 里，
  // 链接在浏览器里是死的 —— 这里把它读回来盖在弹窗上。
  const [preview, setPreview] = useState<string | null>(initialPreview ?? null)
  // 测试环境的日志开着没有。**和预览共用右边那一栏** —— 同时开两栏的话，
  // 卡片本身会被挤成一条缝，而它才是这张弹窗的主语。
  const [logOpen, setLogOpen] = useState(false)
  // 删除不可撤销，所以要点两次：第一次只是把按钮"上膛"。
  const [confirmDelete, setConfirmDelete] = useState(false)
  /**
   * 验收与归档的二次确认。这些是**对这张卡的最后一句话**：按下就回看板、
   * worktree 就没了。第一下只把按钮点亮成"确认 ×"，再点一下才真的执行；
   * 点别的按钮等于改了主意，焦点跟着换过去。
   */
  const [armed, setArmed] = useState<'merge' | 'accept' | 'discard' | 'archive' | null>(null)
  /** 两段式按钮共用的点击逻辑：没上膛先上膛，上了膛才放行。 */
  const requireConfirm = (kind: 'merge' | 'accept' | 'discard' | 'archive', go: () => void): void => {
    if (armed !== kind) { setArmed(kind); return }
    setArmed(null)
    go()
  }
  const [tab, setTab] = useState<Tab>('spec')
  /*
   * 这张卡上出的岔子，就摆在这张卡上。
   *
   * 以前它是交给看板顶上那条通知的 —— 而那条通知在弹窗**背后**：点了"通过"
   * 之后什么都没发生，原因躺在一块看不见的地方。派活、验收、改需求、传附件，
   * 全都是在这张弹窗里按下去的，回话就该回在这儿。
   */
  const [failure, setFailure] = useState<string | null>(null)
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
  /** 还在等人的决策。只有这一轮真的在跑时才弹卡 —— 旧轮次里的都是历史。 */
  const pendingDecisions = latest?.status === 'running'
    ? decisions.filter((decision) => decision.status === 'pending')
    : []
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
    // 换了一次执行就换一批决策：先清掉旧的，别让上一轮的提问挂在这一轮上。
    setDecisions([])
    void api.decisions(latest.id)
      .then(({ decisions: loaded }) => { setDecisions(loaded) })
      .catch(() => {})
    return subscribeRun(latest.id, (event) => {
      setEvents((prev) => (prev.some((e) => e.seq === event.seq) ? prev : [...prev, event]))
      // 决策的生命周期事件直接触发一次重拉：一条列表本来就没几条，
      // 重拉比在两处各自维护增删逻辑不容易错。
      if (event.kind === 'decision' || event.kind === 'decision_resolved') {
        void api.decisions(latest.id)
          .then(({ decisions: loaded }) => { setDecisions(loaded) })
          .catch(() => {})
      }
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
  // 那条错误也一样：它说的是上一张卡上的事。
  useEffect(() => {
    setConfirmDelete(false); setPreview(initialPreview ?? null); setTab('spec'); setFailure(null); setArmed(null)
  }, [task.id])

  // 上膛也不该一直挂着：手滑点开之后忘了，下一次随手一点就把卡删了。
  useEffect(() => {
    if (!confirmDelete) return undefined
    const timer = setTimeout(() => { setConfirmDelete(false) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [confirmDelete])

  // 验收与归档的二次确认同删除一个道理：第一下只是点亮，忘了的话几秒后自己退膛。
  useEffect(() => {
    if (armed === null) return undefined
    const timer = setTimeout(() => { setArmed(null) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [armed])

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

  /**
   * 把一次失败摆到面板顶上。
   *
   * 每个动作按下去之前先清一次：上一次的错误留在那儿，会让人以为刚点的这下
   * 也失败了。
   */
  const reportCode = (code: string, detail: string): void => { setFailure(explain(t, code, detail)) }
  const report = (error: unknown): void => {
    if (error instanceof ApiError) reportCode(error.code, error.message)
  }

  /*
   * 测试环境挂在这一层而不是挂在日志那一栏上：那一栏可以合上，而日志那条
   * SSE 一断，服务端就开始收环境。合上一栏日志不该等于"我验完了"。
   * 启动命令与配置文件在项目设置里配 —— 这里只管起停。
   */
  const testEnv = useTestEnv({
    taskId: task.id,
    enabled: !archived && task.column === 'review',
    onError: reportCode,
  })
  const side = preview !== null ? 'preview' : logOpen ? 'testenv' : null

  /*
   * 亲手按下"停止"之后，那一栏自动合上 —— 它已经没有下文了，留着只是占地方。
   *
   * **只认这一种收场**。进程自己崩了、闲置被回收、跑满 30 分钟被收掉，日志
   * 恰恰是唯一能说明"刚才发生了什么"的东西，那种时候合上等于把证据收走。
   */
  useEffect(() => {
    if (testEnv.env?.status === 'exited' && testEnv.env.stoppedBy === 'manual') setLogOpen(false)
  }, [testEnv.env?.status, testEnv.env?.stoppedBy])

  /*
   * 预览开着的时候，esc 关的是预览，不是整张卡。
   *
   * 听 esc 的一共有两处，都要拦下来：Radix 的 Dialog 在 document 的**捕获
   * 阶段**听（所以后挂的监听抢不到它前面，只能靠下面 onEscapeKeyDown 里的
   * preventDefault），App 还在 window 上另听一份（捕获阶段 stopPropagation
   * 就到不了它那儿）。少拦一处，看完一份文档整张卡就跟着关了。
   */
  useEffect(() => {
    if (side === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      // 预览压在日志上面（后开的那个），所以先关它 —— 关完还能看见日志。
      if (preview !== null) setPreview(null)
      else setLogOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [side, preview])

  /** 删除这张卡。删完面板里已经没有可看的东西了，直接关掉。 */
  const remove = (): void => {
    setBusy(true)
    setFailure(null)
    void api.remove(task.id, task.revision)
      .then(() => { onChanged(); onClose() })
      .catch(report)
      .finally(() => { setBusy(false); setConfirmDelete(false) })
  }

  /** 动作成功就收工回看板；失败留在原地。 */
  const closeIfOk = (ok: boolean): void => { if (ok) onClose() }

  /** 把这张卡派给某个执行器。 */
  const dispatch = (provider: string): void => {
    setBusy(true)
    setFailure(null)
    void api.run(task.id, provider)
      .then(() => { onChanged() })
      .catch(report)
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
    setFailure(null)
    try {
      await call()
      onChanged()
      return true
    } catch (error) {
      report(error)
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
        // 说在 PR 那一段里就够了 —— 按钮就在它上面，不必再往面板顶上抄一份。
        setPrNote({ tone: 'warn', text: explain(t, error.code, error.message) })
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
        onEscapeKeyDown={(event) => { if (side !== null) event.preventDefault() }}
        className={cn(
          'flex h-[72vh] gap-0 overflow-hidden rounded-xl border-hairline bg-panel p-0 shadow-lg',
          // 预览是在右边**新开一栏**，不是盖在卡上面：文档和需求本来就要对着
          // 看 —— 盖上去的话，读到一半想核对验收标准还得先把文档关掉。
          // 任务那栏缩到正常的一半，弹窗整体让出地方给文档。
          side === null
            ? 'w-[860px] max-w-[92vw] sm:max-w-[92vw]'
            : 'w-[1320px] max-w-[96vw] sm:max-w-[96vw]',
          'transition-[width,max-width] duration-200',
        )}
      >
        {/* 任务这一栏。开着预览时缩到 430px —— 正好是它平时的一半。 */}
        <div className={cn(
          'flex min-w-0 flex-col',
          side === null ? 'flex-1' : 'w-[430px] max-w-[45%] flex-none',
        )}>
          {/* 标题文字与动作按钮分成两行：文字独占一行才读得开，按钮缩成
              一排小的贴在下面 —— 挤在标题旁边的话，长标题和长分支名都会
              被压成一列窄条。 */}
          <header className="border-b border-hairline px-4 py-3">
            <div className="flex items-start gap-2">
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
                {/* 基线之外还要标出**自己那条分支** —— 「我的改动到底在哪儿」
                    是打开这张卡最先想知道的事，而它此前只能去 Diff 页里翻。 */}
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
              <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('panel.close')} title={t('panel.closeHint')}>
                <X />
              </Button>
            </div>

            {/* 动作按钮组：测试环境的起停、验收的三句话、归档，全在这一行。
                拆到弹窗中段的话，人要上下扫两遍才凑得齐"我能对这张卡做什么"。
                统一 xs 规格 —— 它们是高频小动作，不该在标题旁边抢地盘。 */}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {/* 测试环境只留这一颗：没起就是"启动"，起着就是"停止"。
                  配置在项目设置里 —— 这里不配命令，只管跑起来看日志。 */}
              {!archived && task.column === 'review' ? (
                testEnv.live ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy || testEnv.busy}
                    onClick={testEnv.stop}
                    className="border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail"
                  >
                    <CircleStop />{t('testenv.stop')}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    disabled={busy || testEnv.busy}
                    onClick={() => { testEnv.start(); setLogOpen(true) }}
                  >
                    <FlaskConical />{t('testenv.start')}
                  </Button>
                )
              ) : null}
              {/* 验收：通过并合并 / 通过 / 废弃。只有 review 列的卡看得到。
                  要它再改一版，去讨论里留言。三颗都要二次确认 —— 判下去
                  worktree 就没了，手滑一下的代价不该由用户来担。 */}
              {!archived && task.column === 'review' ? (
                <>
                  <Action
                    icon={capability?.ready === true ? <GitPullRequest /> : <GitMerge />}
                    label={armed === 'merge' ? t('panel.acceptMergeArmed') : t('panel.acceptMerge')}
                    tone="primary" armed={armed === 'merge'}
                    title={armed === 'merge' ? t('panel.armedHint') : undefined}
                    // 能力还没问回来时先按不动：这颗按钮的两种行为差得很远
                    // （开 PR / 动你的主工作区），抢在答案之前点下去等于抽签。
                    busy={busy || capability === null}
                    onClick={() => requireConfirm('merge', () => {
                      if (capability?.ready === true) { openPr(); return }
                      void act(() => api.accept(task.id, true)).then(closeIfOk)
                    })}
                  />
                  <Action
                    icon={<Check />}
                    label={armed === 'accept' ? t('panel.acceptArmed') : t('panel.accept')}
                    tone="ok" armed={armed === 'accept'}
                    title={armed === 'accept' ? t('panel.armedHint') : undefined}
                    busy={busy}
                    onClick={() => requireConfirm('accept', () => {
                      void act(() => api.accept(task.id, false)).then(closeIfOk)
                    })}
                  />
                  <Action
                    icon={<Trash2 />}
                    label={armed === 'discard' ? t('panel.discardArmed') : t('panel.discard')}
                    tone="fail" armed={armed === 'discard'}
                    title={armed === 'discard' ? t('panel.armedHint') : undefined}
                    busy={busy}
                    onClick={() => requireConfirm('discard', () => {
                      void act(() => api.discard(task.id)).then(closeIfOk)
                    })}
                  />
                </>
              ) : null}
              <Button
                variant="outline"
                size="xs"
                disabled={busy || task.column === 'running'}
                title={armed === 'archive'
                  ? t('panel.armedHint')
                  : (task.column === 'running' ? t('panel.archiveBlocked') : undefined)}
                onClick={() => requireConfirm('archive', () => {
                  void act(() => (archived
                    ? api.unarchive(task.id, task.revision)
                    : api.archive(task.id, task.revision)))
                })}
                className={cn(
                  armed === 'archive' && 'border-sodium bg-sodium/15 text-sodium hover:bg-sodium/20 hover:text-sodium',
                )}
              >
                {archived
                  ? <><ArchiveRestore />{t('panel.unarchive')}</>
                  : armed === 'archive'
                    ? <><Archive />{t('panel.archiveArmed')}</>
                    : <><Archive />{t('panel.archive')}</>}
              </Button>
              {deletable ? (
                <Button
                  variant="outline"
                  size="xs"
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
            </div>
          </header>

          {/* 出岔子就说在这儿 —— 紧挨着刚才按下去的那些按钮，而不是弹窗背后
              的看板上。留到人自己收走：一条一闪而过的提示，等于没说。 */}
          {failure === null ? null : (
            <div
              role="alert"
              className="flex items-start gap-2 border-b border-lamp-fail/40 bg-lamp-fail/[0.07] px-4 py-2.5"
            >
              <CircleAlert className="mt-[2px] size-3.5 flex-none text-lamp-fail" />
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-lamp-fail">{failure}</p>
              <button
                type="button"
                onClick={() => { setFailure(null) }}
                className="chrome-label flex-none rounded-md border border-lamp-fail/30 px-1.5 py-0.5 text-lamp-fail opacity-70 transition-opacity hover:opacity-100"
              >
                {t('panel.errorDismiss')}
              </button>
            </div>
          )}

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
                    setFailure(null)
                    void api.cancel(latest.id)
                      .then(() => { onChanged() })
                      .catch(report)
                      .finally(() => { setBusy(false) })
                  }}
                  className="border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail"
                >
                  <Square />{t('panel.stop')}
                </Button>
              )}
            </div>
          ) : null}

          {/* 上一次执行失败的话，先把失败摆在明处 —— 验收按钮在头顶上，
              "这次是成是败"的理由也得跟着到头顶去，不然"通过"会摆在一堆
              没跑完的活旁边。 */}
          {!archived && task.column === 'review' && latest !== undefined && latest.status !== 'completed' ? (
            <div className="border-b border-hairline px-4 py-3">
              <div className="flex items-start gap-2 rounded-md border border-lamp-fail/40 bg-lamp-fail/[0.06] px-3 py-2">
                <TriangleAlert className="mt-[3px] size-3.5 flex-none text-lamp-fail" />
                <p className="min-w-0 text-xs leading-relaxed text-lamp-fail">
                  {latest.status === 'aborted' ? t('panel.runAborted') : t('panel.runFailed')}
                  {latest.diagnostic === undefined ? null : (
                    <span className="mono block break-words">{latest.diagnostic}</span>
                  )}
                  {t('panel.runFailedHint')}
                </p>
              </div>
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

          {/* 等人拍板的决策摆在所有分页之上 —— 它比任何一页的内容都急：
              Agent 此刻什么都没做，就在等这一眼。 */}
          {pendingDecisions.length === 0 ? null : (
            <DecisionBar runId={latest?.id ?? ''} decisions={pendingDecisions} onReport={report} />
          )}

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
                siblings={siblings}
                agents={agents}
                busy={busy}
                onError={reportCode}
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
                  onSend={async (body, edit, attachmentIds) => {
                    setBusy(true)
                    try {
                      const { comments: next } = await api.comment(task.id, body, edit, attachmentIds)
                      setComments(next)
                      onChanged()
                      // 说完就收工，回到看板 —— 话已经带给下一轮了，留在这儿没事可做。
                      onClose()
                      return null
                    } catch (error) {
                      // 失败留在原地，那句话就贴在输入框下面 —— 草稿还在框里，
                      // 人的下一个动作就在那儿，没必要再往面板顶上抄一份。
                      if (error instanceof ApiError) return explain(t, error.code, error.message)
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

        {side === 'preview' && preview !== null ? (
          <FilePreviewPane
            taskId={task.id}
            path={preview}
            onOpen={setPreview}
            onClose={() => { setPreview(null) }}
          />
        ) : null}
        {side === 'testenv' ? (
          <TestEnvLogPane handle={testEnv} onClose={() => { setLogOpen(false) }} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Action({ icon, label, onClick, busy, tone, armed, title }: {  icon: React.ReactNode
  label: string
  onClick: () => void
  busy: boolean
  /** primary 是这一屏的主动作，实心；ok / fail 只借个色，形制仍是描边。 */
  tone?: 'primary' | 'ok' | 'fail'
  /** 二次确认点亮态：换上琥珀色，提醒"下一手就来真的了"。 */
  armed?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <Button
      size="xs"
      variant={tone === 'primary' && armed !== true ? 'default' : 'outline'}
      disabled={busy}
      title={title}
      onClick={onClick}
      className={cn(
        tone === 'ok' && 'border-lamp-ok/40 text-lamp-ok hover:bg-lamp-ok/10 hover:text-lamp-ok',
        tone === 'fail' && 'border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail',
        armed === true && 'border-sodium bg-sodium/15 text-sodium hover:bg-sodium/20 hover:text-sodium',
      )}
    >
      {icon}{label}
    </Button>
  )
}


function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="cjk-label p-6 text-center">{text}</p>
}

