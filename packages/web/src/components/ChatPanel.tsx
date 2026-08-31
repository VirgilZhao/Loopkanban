import { useEffect, useState } from 'react'
import { ArrowRight, MessageSquare, Maximize2, PanelRightClose, X } from 'lucide-react'
import { api, ApiError, subscribeRun } from '@/api.ts'
import { ChatThread } from '@/components/ChatThread.tsx'
import { DecisionBar } from '@/components/DecisionBar.tsx'
import { Discussion } from '@/components/Discussion.tsx'
import { RunStream } from '@/components/RunStream.tsx'
import { TaskEditor } from '@/components/TaskEditor.tsx'
import { Button } from '@/components/ui/button.tsx'
import { explain, useT } from '@/lib/i18n.tsx'
import { isUntouchedDraft, taskTitle } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import {
  COLUMN_META, type Agent, type Executor, type Project, type Run, type RunDecision,
  type StreamEvent, type Task, type TaskComment, type TaskEdit,
} from '@/types.ts'

/** 选中一张卡之后，这块面板里的两页。聊天在前 —— 它是这块面板的本业。 */
const TABS = ['talk', 'spec'] as const
type Tab = (typeof TABS)[number]

interface Props {
  /** 选中的卡。null 就是**建卡模式**：在这儿写一句话，就是一张新卡。 */
  task: Task | null
  /** 选中卡所属的项目；建卡模式下是新卡的落点。 */
  project: Project | null
  /** 所有项目。建卡模式下落点不明（概览、多个项目）时要先挑一个。 */
  projects: Project[]
  /** 同项目的其它卡，配置里挑关联与依赖用。 */
  siblings: Task[]
  agents: Agent[]
  /** 全部执行器：聊天、@ 补全、配置里那一栏都靠它。 */
  executors: Executor[]
  /** 谁是默认执行器。 */
  defaultExecutorId: string | null
  /** 卡被动过（建卡、留言、存规格、移动）—— 看板得重新拉一遍。 */
  onChanged: () => void
  /** 刚建出来的卡。外面把它选中，面板随即切到这张卡上。 */
  onCreated: (task: Task) => void
  /** 取消选中，回到建卡模式。 */
  onDeselect: () => void
  /** 打开详情弹窗；带 file 时先摆出那份文档。 */
  onOpenDetails: (file?: string) => void
  onCollapse: () => void
  className?: string | undefined
  /** 入场动画的次序，接着看板那几列往下排。 */
  index?: number
}

/**
 * 看板右侧的那块面板：**一张卡的全部日常都在这儿**。
 *
 * 没选卡时它是**跟默认执行器聊天**的地方：把想做的事说清楚，它来出卡（见
 * ChatThread）。从前这儿是个"写一句话就是一张卡"的输入框，毛病是一句话直接
 * 变成需求，中间没有任何人帮你想清楚。
 * 选中一张卡之后它变成这张卡的对话：Agent 的回复与人的留言排在一起，Review
 * 时说一句就是"再改一版"（那正是过去要点开弹窗、切到讨论页才能干的事）；
 * 另一页是这张卡的配置，需求、验收标准、交给谁、权限都在里面就地改。
 *
 * 摆在这儿而不是弹窗里，是因为这些事要**对着看板做** —— 一边看着卡在哪一列，
 * 一边说下一步。弹窗会把看板盖掉，那就等于没有并排的意义。
 *
 * 宽屏才装得下的东西（diff、事件流、PR、测试环境、权限审批）仍然在详情弹窗
 * 里，面板右上角那颗按钮叫得出来 —— 550px 宽的地方摆 diff，是把它摆成一条缝。
 */
export function ChatPanel({
  task, project, projects, siblings, agents, executors, defaultExecutorId,
  onChanged, onCreated, onDeselect, onOpenDetails, onCollapse, className, index = 0,
}: Props): React.JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<Tab>('talk')
  const [comments, setComments] = useState<TaskComment[]>([])
  const [busy, setBusy] = useState(false)
  /** 这块面板上出的岔子，就说在这块面板上 —— 看板顶上那条横幅在很远的地方。 */
  const [failure, setFailure] = useState<string | null>(null)
  /** 新卡落到哪个项目；没挑过就跟着当前视角走。 */
  const [target, setTarget] = useState<string | null>(null)
  /** 刚从这儿建出来的那张卡。回执只对它显示，别的卡不摆。 */
  const [fresh, setFresh] = useState<string | null>(null)
  /** 这张卡的执行记录，最新的在前。 */
  const [runs, setRuns] = useState<Run[]>([])
  /**
   * 每一轮的事件，按 Run 分开放。
   *
   * 正在跑的那一轮走 SSE（服务端先补历史再接直播）；**历史轮次点开才去拿**
   * —— 一张跑过十轮的卡，一进来就把十轮几千条事件全读回来，只是为了绝大
   * 多数时候没人会展开的东西。
   */
  const [events, setEvents] = useState<Record<string, StreamEvent[]>>({})
  /** 只拿到最后一段的那些轮次。摊开时要说一声。 */
  const [clipped, setClipped] = useState<Record<string, boolean>>({})
  /** 正在读事件的那些轮次。 */
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  /** 这一轮里等人拍板的事：权限审批与提问。 */
  const [decisions, setDecisions] = useState<RunDecision[]>([])

  const targetProject = projects.find((p) => p.id === target) ?? project ?? projects[0] ?? null
  /** 眼下由谁在聊 —— 默认执行器。头上那句说明要说出他的名字。 */
  const chatting = executors.find((executor) => executor.id === defaultExecutorId) ?? executors[0]
  const latest = runs[0]
  /** 这一轮还在跑。跑着的时候对话是活的，输入框按住。 */
  const live = latest?.status === 'running'
  /**
   * 还在等人的决策。
   *
   * 只认这一轮真的在跑的时候 —— 旧轮次里那些都是历史，摆出来会让人对着一个
   * 早就结束的提问发呆。
   */
  const waiting = live ? decisions.filter((decision) => decision.status === 'pending') : []

  // 换一张卡就换一套上下文：上一张的讨论、错误、正在写的页都不该跟过来。
  // 一个字都还没写的新卡（侧边栏或想法池那颗"+"建出来的）直接摆配置 ——
  // 那张卡上还没有可聊的东西，要交代什么得先写下来。
  useEffect(() => {
    setComments([])
    setEvents({})
    setClipped({})
    setLoading({})
    setDecisions([])
    setRuns([])
    setFailure(null)
    setTab(task !== null && isUntouchedDraft(task) ? 'spec' : 'talk')
  }, [task?.id])

  // 讨论跟着卡的 revision 走：跑完一轮 Agent 会往里加一条回复。
  useEffect(() => {
    if (task === null) return undefined
    let cancelled = false
    void api.comments(task.id)
      .then(({ comments: loaded }) => { if (!cancelled) setComments(loaded) })
      // 拉失败就留着手上这份：清空会让整条线程消失，而一次网络抖动
      // 不是"这张卡没有讨论"。
      .catch(() => {})
    return () => { cancelled = true }
  }, [task?.id, task?.revision])

  // 执行记录跟着 revision 走：派出去一轮之后卡的 id 不变，只有 revision 会动。
  // 只看 id 的话，刚派出去的那一轮永远不会被拉到，对话里就一直没有它。
  useEffect(() => {
    if (task === null) return undefined
    let cancelled = false
    void api.runsOf(task.id)
      .then(({ runs: loaded }) => { if (!cancelled) setRuns(loaded) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [task?.id, task?.revision])

  // 订阅最新那一轮：服务端会先补历史再接实时，所以这一条既是回放也是直播。
  //
  // **只订阅还在跑的那一轮**。已经收场的那一轮开一条流，等于抱着一个永远
  // 不会再有新消息的连接（服务端还得为它按时发心跳）—— 它一次性读回来就够。
  // 但它要**主动**读：那是人最可能想看的一轮，不该还得先点一下。
  useEffect(() => {
    if (latest === undefined) return undefined
    if (latest.status !== 'running') { loadLog(latest.id); return undefined }
    setDecisions([])
    void api.decisions(latest.id)
      .then(({ decisions: loaded }) => { setDecisions(loaded) })
      .catch(() => {})
    return subscribeRun(latest.id, (event) => {
      setEvents((prev) => {
        const mine = prev[latest.id] ?? []
        if (mine.some((e) => e.seq === event.seq)) return prev
        return { ...prev, [latest.id]: [...mine, event] }
      })
      // 决策的增删直接重拉一遍：一轮里本来就没几条，重拉比在两处各自
      // 维护增删逻辑不容易错。
      if (event.kind === 'decision' || event.kind === 'decision_resolved') {
        void api.decisions(latest.id)
          .then(({ decisions: loaded }) => { setDecisions(loaded) })
          .catch(() => {})
      }
    })
  }, [latest?.id, latest?.status])

  /**
   * 把某一轮的过程读回来。点开才读，读过不再读。
   *
   * 正在跑的那一轮不走这儿 —— 它的事件由 SSE 一路推过来，再读一次只会
   * 和推过来的那些打架。
   */
  const loadLog = (runId: string): void => {
    if (runId === latest?.id && live) return
    if (events[runId] !== undefined || loading[runId] === true) return
    setLoading((prev) => ({ ...prev, [runId]: true }))
    void api.runLog(runId)
      .then(({ events: loaded, truncated }) => {
        setEvents((prev) => ({ ...prev, [runId]: loaded }))
        if (truncated) setClipped((prev) => ({ ...prev, [runId]: true }))
      })
      // 读不到就让它空着：那一行折叠头还在，再点一次会重试。硬报错太吵 ——
      // 这是"想回头看看"，不是人正在等结果的操作。
      .catch(() => {})
      .finally(() => { setLoading((prev) => ({ ...prev, [runId]: false })) })
  }

  /** 按发生顺序排的执行记录。第几轮就是它在这个数组里的位置。 */
  const chronological = [...runs].sort((a, b) => a.startedAt - b.startedAt)

  const streamOf = (run: Run, index: number): React.JSX.Element => (
    <RunStream
      key={run.id}
      run={run}
      round={index + 1}
      events={events[run.id] ?? []}
      live={run.id === latest?.id && live}
      truncated={clipped[run.id] === true}
      loading={loading[run.id] === true}
      onOpen={() => { loadLog(run.id) }}
    />
  )

  /**
   * 每一轮的过程挂在哪条留言前面。
   *
   * 一轮跑完会往讨论里写一条总结，所以"这一轮的过程"该紧挨着**它自己**的
   * 那条总结，而不是全堆到线程末尾 —— 堆在末尾的话，第一轮的过程会排在
   * 第三轮的结论后面，时间线读起来是反的。
   *
   * 认的是时间：一轮归它开跑之后的第一条留言。留言里没人接的（正在跑的
   * 那一轮、以及跑完还没写下总结的那一轮）留到最后，跟在整条线程后面。
   */
  const { pinned, trailing } = (() => {
    const map = new Map<string, React.JSX.Element[]>()
    const rest: React.JSX.Element[] = []
    chronological.forEach((run, index) => {
      const node = streamOf(run, index)
      const owner = comments.find((comment) => comment.at >= run.startedAt)
      if (owner === undefined) { rest.push(node); return }
      map.set(owner.id, [...(map.get(owner.id) ?? []), node])
    })
    return { pinned: map, trailing: rest }
  })()

  const report = (error: unknown, fallback: string): void => {
    setFailure(error instanceof ApiError ? explain(t, error.code, error.message) : fallback)
  }

  /** 刚建的卡推进队列。位置交给服务端 —— 排在队尾就是它该在的地方。 */
  const toReady = (): void => {
    if (task === null || busy) return
    setBusy(true)
    setFailure(null)
    void api.move(task.id, task.revision, 'ready')
      .then(() => { onChanged() })
      .catch((error: unknown) => { report(error, t('chat.moveFailed')) })
      .finally(() => { setBusy(false) })
  }

  return (
    <section
      className={cn(
        // 与看板的列同一块材质：xl 圆角、发丝边、一层浅影 —— 它是并排的一块，
        // 不是浮在上面的另一层东西。
        'settle flex min-h-0 flex-col overflow-hidden rounded-xl border border-hairline',
        'bg-panel shadow-sm',
        className,
      )}
      style={{ animationDelay: `${String(index * 45)}ms` }}
    >
      {task === null ? (
        /* ── 建卡模式的头：与列头对齐（图标 + 名字 + 一句说明） ───── */
        <header className="flex flex-none items-start gap-2 px-3.5 pb-3 pt-3.5">
          <MessageSquare className="mt-px size-4 flex-none text-sodium" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold leading-none text-ink">{t('chat.title')}</h2>
            <p className="mt-1.5 truncate text-xs text-ink-faint">
              {chatting === undefined
                ? t('chat.hintNobody')
                : t('chat.hint', { name: chatting.name })}
            </p>
          </div>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={t('chat.collapse')}
            title={t('chat.collapse')}
            onClick={onCollapse}
          >
            <PanelRightClose />
          </Button>
        </header>
      ) : (
        /* ── 选中一张卡：卡头 + 两页 ─────────────────────────── */
        <header className="flex-none border-b border-hairline px-3.5 pb-2.5 pt-3">
          <div className="flex items-center gap-2">
            <span className="tag">{task.id}</span>
            <span className="lamp" data-state={task.archivedAt === undefined ? task.column : 'idle'} />
            <span className="chrome-label !text-[9px]">{COLUMN_META[task.column].label}</span>
            <span className="flex-1" />
            {/* 宽屏才装得下的东西在弹窗里 —— 这颗按钮是通往那儿的门。 */}
            <Button
              variant="outline"
              size="icon-xs"
              aria-label={t('chat.details')}
              title={t('chat.detailsHint')}
              onClick={() => { onOpenDetails() }}
            >
              <Maximize2 />
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              aria-label={t('chat.deselect')}
              title={t('chat.deselectHint')}
              onClick={onDeselect}
            >
              <X />
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              aria-label={t('chat.collapse')}
              title={t('chat.collapse')}
              onClick={onCollapse}
            >
              <PanelRightClose />
            </Button>
          </div>

          {/* 卡片没有标题字段，取第一行 —— 与卡面、分支名、通知取的是同一句。 */}
          <h2 className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-ink">
            {taskTitle(task)}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
            <span className="truncate">{project?.name ?? t('panel.unknownProject')}</span>
            <span className="inline-flex items-center gap-1">
              {t('panel.baseLabel')} <span className="mono">{task.baseBranch}</span>
            </span>
          </p>

          {/* 聊天 / 配置。与顶栏那对页签同一套样子 —— 都是"这块地方看什么"。 */}
          <div className="mt-2.5 flex w-fit items-center gap-0.5 rounded-md border border-hairline p-0.5">
            {TABS.map((key) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key}
                onClick={() => { setTab(key) }}
                className={cn(
                  'rounded-sm px-2 py-0.5 text-[11px] transition-colors',
                  tab === key ? 'bg-raised text-ink' : 'text-ink-faint hover:text-ink',
                )}
              >
                {t(key === 'talk' ? 'chat.tabTalk' : 'chat.tabSpec')}
              </button>
            ))}
          </div>
        </header>
      )}

      {/* 刚从这儿建出来的卡：说一声它去哪儿了，并把下一步就摆在旁边 ——
          建完卡最常干的事就是把它推进队列。 */}
      {task !== null && fresh === task.id && task.column === 'backlog' ? (
        <div className="flex flex-none items-center gap-2 border-b border-sodium-deep/40 bg-sodium/[0.06] px-3.5 py-2 text-[11px] text-sodium">
          <span className="min-w-0 flex-1">{t('chat.created', { id: task.id })}</span>
          <Button size="xs" disabled={busy} onClick={toReady} title={t('chat.toReadyHint')}>
            <ArrowRight />{t('chat.toReady')}
          </Button>
        </div>
      ) : null}

      {failure === null ? null : (
        <p className="flex-none border-b border-lamp-fail/40 bg-lamp-fail/[0.07] px-3.5 py-2 text-[11px] text-lamp-fail">
          {failure}
        </p>
      )}

      {task === null ? (
        /* ── 聊出一张卡 ─────────────────────────────────────── */
        targetProject === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center border-t border-hairline p-6">
            <p className="cjk-label max-w-64 text-center leading-relaxed">{t('chat.noProject')}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col border-t border-hairline">
            {/* 落点只在"不止一个项目"时问 —— 只有一个仓库时问它等于白问一句。
                它得摆在对话**上面**：换了项目就是换了一段对话。 */}
            {projects.length > 1 ? (
              <label className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2 text-[11px] text-ink-faint">
                {t('chat.project')}
                <select
                  value={targetProject.id}
                  onChange={(event) => { setTarget(event.target.value) }}
                  className={cn(
                    'border-input h-7 min-w-0 flex-1 rounded-md border bg-transparent px-1.5 text-[11px] shadow-xs',
                    'transition-[color,box-shadow] outline-none dark:bg-input/30',
                    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                  )}
                >
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            ) : null}
            <ChatThread
              // 换项目就整个重挂：上一个仓库聊到哪儿，跟这个仓库没关系。
              key={targetProject.id}
              project={targetProject}
              executors={executors}
              onCreated={(made) => {
                setFresh(made.id)
                onCreated(made)
              }}
              onChanged={onChanged}
            />
          </div>
        )
      ) : tab === 'talk' ? (
        <Discussion
          task={task}
          executors={executors}
          comments={comments}
          busy={busy}
          // Review 与 Done 里留言都会把卡送回队列，按钮上得先说清楚。
          requeues={task.column === 'review' || task.column === 'done'}
          // 这一轮的过程与等人拍板的事，都排在留言后面 —— 同一条时间线上的事，
          // 分到两个地方去，人就得自己对时间。
          before={(comment) => pinned.get(comment.id) ?? null}
          after={(
            <>
              {trailing}
              {latest === undefined || waiting.length === 0 ? null : (
                <DecisionBar
                  runId={latest.id}
                  decisions={waiting}
                  onReport={(error: unknown) => { report(error, t('decision.failed')) }}
                />
              )}
            </>
          )}
          // 事件是一条条来的，线程得跟着往下滚 —— 不然活的那部分总在屏幕外面。
          scrollKey={(events[latest?.id ?? ''] ?? []).length}
          // 执行中说不出话：这会儿该看它干活，它要是问你什么，问题就在上面。
          mute={live ? t('chat.runningLock') : undefined}
          // 文档要摊开来读，这块面板太窄 —— 交给详情弹窗，它会先摆出这一份。
          onOpenFile={(path) => { onOpenDetails(path) }}
          onSend={async (body, attachmentIds) => {
            setBusy(true)
            try {
              const { comments: after } = await api.comment(task.id, body, attachmentIds)
              setComments(after)
              // **不关面板**：说完这句话，人多半还要看着这张卡往下走 ——
              // 这正是把讨论从弹窗搬出来的理由。
              onChanged()
              return null
            } catch (error) {
              if (error instanceof ApiError) return explain(t, error.code, error.message)
              return t('talk.sendFailed')
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : (
        <TaskEditor
          task={task}
          siblings={siblings}
          agents={agents}
          executors={executors}
          defaultExecutorId={defaultExecutorId}
          busy={busy}
          onError={(code, detail) => { setFailure(explain(t, code, detail)) }}
          // 附件是即时生效的：传完 / 删完要让看板知道，卡片上那枚回形针的
          // 数字才跟得上。
          onChanged={onChanged}
          onSave={(edit: TaskEdit) => {
            setBusy(true)
            setFailure(null)
            // 存完留在这一页：卡还在旁边的看板上，没有"收工"这一说 ——
            // 表单自己会因为 revision 变了而不再是"改过"的样子。
            void api.edit(task.id, task.revision, edit)
              .then(() => { onChanged() })
              .catch((error: unknown) => { report(error, t('chat.saveFailed')) })
              .finally(() => { setBusy(false) })
          }}
        />
      )}
    </section>
  )
}
