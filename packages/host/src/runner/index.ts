/**
 * Runner：把一张卡片变成一次真实的 Agent 执行。
 *
 * 串起来的东西：领域层的租约 CAS、git worktree 隔离、进程组托管、
 * 事件日志与 SSE 推送。
 *
 * 几条不肯让步的规则：
 *
 * - **先拿租约再干活**。worktree 和进程都是有代价的副作用，必须等 CAS
 *   成功、确认这张卡归我们之后才产生，否则两个调度器会各建一个 worktree。
 * - **租约要续**。长任务超过租期会被回收器当成崩溃的 Run 收走，所以
 *   跑着的 Run 必须定期续租。
 * - **事件先落库再广播**。存储是真相，总线只是通知；顺序反过来的话，
 *   SSE 收到的 seq 可能还没落盘，断线重连就会漏。
 * - **失败也要有结构化的原因**。卡片进 Review 后要显示人看得懂的东西，
 *   而不是一坨 stack trace。
 */

import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  acquireLease, asRunId, isLeaseExpired, moveTask, reclaimIfExpired, renewLease,
  taskTitle, type RunId, type Task, type TaskId,
} from '@loopkanban/core'
import { humanSize, stageAttachments, type StagedAttachment } from '../attachments/index.ts'
import type { AgentEvent, RunContext } from '../agents/types.ts'
import type { AgentPool, DetectedAgent } from '../agents/index.ts'
import type { RunBus } from '../server/bus.ts'
import type { Run, Storage, TaskComment } from '../storage/index.ts'
import { spawnProcess, type ProcessHandle, type SpawnSpec } from '../subprocess/index.ts'
import { branchSlug, ensureWorktree, worktreeDir, worktreeDiff, type Worktree } from '../worktree/index.ts'

/** 租期。跑着的 Run 会在到期前续，崩溃的 Run 到期后被回收。 */
export const DEFAULT_LEASE_TTL_MS = 90_000
/** 续租间隔，取租期的三分之一，容得下两次失败。 */
const RENEW_DIVISOR = 3
/** 单次执行的默认超时。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

/**
 * stderr 保留上限，按**字节**而不是块数。
 *
 * 单个 chunk 可达 64KB，按块数设限等于给了上百 MB 的额度；而最终只有前 512
 * 字节会被用作 diagnostic。一个疯狂往 stderr 打日志的构建不该把 host 撑爆。
 */
const STDERR_KEEP_BYTES = 64 * 1024

/** 多快算"一起步就死"。这个量级的失败不可能是活干砸了，只可能是没跑起来。 */
const IMMEDIATE_FAILURE_MS = 10_000

export interface RunnerOptions {
  readonly storage: Storage
  readonly bus: RunBus
  /** 本机可用的执行器。是活视图不是快照 —— 刷新之后这里立刻跟着变。 */
  readonly agents: AgentPool
  /** Run 产物（原始日志、last-message）目录。 */
  readonly artifactsRoot: string
  readonly leaseTtlMs?: number
  readonly timeoutMs?: number
  /** 供测试注入假的进程启动器。 */
  readonly spawn?: (spec: SpawnSpec) => Promise<ProcessHandle>
  readonly now?: () => number
}

export type StartFailure =
  | { readonly ok: false; readonly reason: string; readonly detail: string }

export type StartResult =
  | { readonly ok: true; readonly run: Run }
  | StartFailure

interface Active {
  readonly handle: ProcessHandle
  readonly renew: NodeJS.Timeout
  readonly timeout: NodeJS.Timeout
  readonly taskId: TaskId
  /** 是否是被人主动取消的。用来把它和"真的跑失败了"区分开。 */
  cancelled: boolean
}

export class Runner {
  private readonly options: RunnerOptions
  private readonly active = new Map<string, Active>()

  constructor(options: RunnerOptions) {
    this.options = options
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get leaseTtl(): number {
    return this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  }

  /** 当前正在跑的 Run。 */
  activeRunIds(): RunId[] {
    return [...this.active.keys()].map(asRunId)
  }

  /**
   * 认领并执行一张卡。
   * @param taskId - 目标任务。
   * @param providerId - 指定执行器；不给则用第一个可用的。
   * @returns 已发布的 Run，或明确的失败原因。
   */
  async start(taskId: TaskId, providerId?: string): Promise<StartResult> {
    const { storage } = this.options
    // 每次派活都重新读：中途刷新过的话，装上的要能用，卸掉的不能再派。
    const agents = this.options.agents.list()
    const task = storage.getTask(taskId)
    if (task === null) return { ok: false, reason: 'task-not-found', detail: String(taskId) }

    const wanted = providerId ?? task.preferredProvider
    const agent = wanted === undefined
      ? agents[0]
      : agents.find((a) => a.provider.id === wanted)
    if (agent === undefined) {
      return {
        ok: false,
        reason: 'provider-unavailable',
        detail: wanted === undefined ? '本机没有可用的 Agent CLI' : `未探测到 ${wanted}`,
      }
    }

    const runId = asRunId(`run-${randomUUID().slice(0, 8)}`)
    const now = this.now

    // ── 先拿租约。副作用一律等 CAS 成功之后再做。 ──────────────
    const claimed = acquireLease(task, {
      expectedRevision: task.revision,
      runId,
      provider: agent.provider.id,
      ttlMs: this.leaseTtl,
      now,
      completed: new Set(storage.listTasks(task.projectId).filter((t) => t.column === 'done').map((t) => t.id)),
    })
    if (!claimed.ok) return { ok: false, reason: claimed.reason, detail: claimed.detail }
    if (!storage.commitTask(claimed.value)) {
      return { ok: false, reason: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' }
    }

    // ── 到这里这张卡确定归我们了，可以建 worktree、起进程。 ────
    try {
      const prior = await this.resumableRun(claimed.value, agent)
      return { ok: true, run: await this.launch(claimed.value, runId, agent, prior) }
    } catch (error) {
      const detail = describeError(error)
      /*
       * 这次派活**一定**要留下一条终态的 Run。两种失败都要兜住：
       *
       * 一是 launch 已经写了 Run 记录才失败（例如 spawn 时 CLI 二进制刚被
       * 替换）。不打到终态的话，它会永远算作 running，把统计和孤儿对账都带偏。
       *
       * 二是更早就失败了，连 Run 都还没写 —— worktree 建不出来（基线分支被
       * 删、仓库被移走、index.lock 没清、磁盘满）就是这一种。这一条更要补：
       * 卡照样被 release 进 Review，而"这一轮跑挂了"全靠 runs 表判断，一条
       * 记录都没有就等于这次失败从没发生过 —— 自动驾驶下没有任何人看得见它，
       * 上一轮跑成过的卡还会顶着那条 completed 冒充"干完了等你验"。
       */
      const created = storage.getRun(runId)
      if (created === null) {
        // 工作区没建成，但它该在哪儿、分支该叫什么是确定的（同一张卡永远是
        // 同一个目录），照实记下来 —— 验收那头本来就容得下"根本没建出工作区"
        // 的卡，会明确拒绝而不是在不存在的目录上炸开。
        storage.createRun({
          id: runId,
          taskId,
          provider: agent.provider.id,
          cliVersion: agent.caps.version,
          worktreePath: worktreeDir(task.repoPath, task.id),
          branch: branchSlug(task.id, taskTitle(task)),
          status: 'failed',
          diagnostic: detail,
          startedAt: now,
          endedAt: this.now,
        })
      } else if (created.status === 'running') {
        storage.updateRun({ ...created, status: 'failed', diagnostic: detail, endedAt: this.now })
      }
      // 副作用建到一半失败，必须把卡放回去，否则它会一直卡在 running。
      this.release(taskId)
      return { ok: false, reason: 'launch-failed', detail }
    }
  }

  /**
   * 判断这次执行能否接着上一次继续。
   *
   * 四个条件缺一不可：上次留下了会话 id、这个 CLI 版本支持续跑、
   * 还是同一个 provider（换了就没法续别人的会话）、上次的 worktree 还在。
   * 任何一条不满足就老老实实重开一次 —— 半吊子的"续跑"比重来更难排查。
   *
   * @returns 可续跑的上一次 Run；不可续则 undefined。
   */
  private async resumableRun(task: Task, agent: DetectedAgent): Promise<Run | undefined> {
    if (!agent.caps.canResume) return undefined
    const prior = this.options.storage.listRuns(task.id).find((run) => run.agentSessionId !== undefined)
    if (prior === undefined || prior.provider !== agent.provider.id) return undefined
    const alive = await access(prior.worktreePath).then(() => true, () => false)
    return alive ? prior : undefined
  }

  /** 真正建（或复用）worktree、写 TASK.md、起进程并接管输出。 */
  private async launch(task: Task, runId: RunId, agent: DetectedAgent, prior?: Run): Promise<Run> {
    const { storage, artifactsRoot } = this.options
    const { provider, caps } = agent

    // worktree 属于任务：打回重做、换个 CLI 接着干，看到的都是同一个工作区
    // 里上一次的成果，而不是在空目录里对着评审意见发懵。`prior` 只决定要不要
    // 续会话，不决定在哪儿干活。
    const worktree = await ensureWorktree(
      task.repoPath, task.id, branchSlug(task.id, taskTitle(task)), task.baseBranch,
    )

    const artifactsDir = join(artifactsRoot, runId)
    await mkdir(artifactsDir, { recursive: true })
    // 附件先落进 worktree，再写 TASK.md —— 清单里的每一条都得真的在那儿，
    // 拷不过去的不列出来，免得 Agent 去找一个不存在的文件。
    //
    // 规格附件在前、讨论里带的在后：**两种都要拷**。人在讨论里贴的那张
    // 截图和他那句"这儿为什么长这样"是一件事，只把需求里的文件放进去，
    // 等于让 Agent 读着一句指着图说的话却看不见图。
    const staged = await stageAttachments(worktree.path, [
      ...storage.listAttachments(task.id),
      ...storage.listCommentAttachments(task.id),
    ])
    // 讨论线程一起写进 TASK.md：人和 Agent 的每一轮往来都是这次执行的上下文。
    const comments = storage.listComments(task.id)
    // 关联的卡也要展开写进去。**读的是此刻的库**，不是建卡时的快照 ——
    // 参考的那张卡改过需求、跑完进了 Done，这次执行看到的就该是新的样子。
    // 中间被删掉的会返回 null（`dropReferences` 通常已经把 id 摘掉了，这里
    // 只是不指望它）：跳过，而不是在规格里留一行查无此卡。
    const related = task.relatedTo
      .map((id) => storage.getTask(id))
      .filter((other): other is Task => other !== null)
    await writeFile(
      join(worktree.path, 'TASK.md'), renderTaskSpec(task, comments, staged, related), 'utf8',
    )

    const context: RunContext = {
      runId,
      worktreePath: worktree.path,
      artifactsDir,
      prompt: renderPrompt(task, comments, prior !== undefined, staged, related),
      permission: 'standard',
      // 指定了模型就带上；留空由 CLI 自己做主 —— 我们不替它选。
      ...(task.model === undefined ? {} : { model: task.model }),
      // 能不能钉住会话 id 是探测出来的事实，不按 CLI 的名字分支：
      // 有的支持我们预先指定，有的只能事后从它自己的输出里捞。
      ...(caps.canPinSessionId ? { sessionId: randomUUID() } : {}),
    }

    const run: Run = {
      id: runId,
      taskId: task.id,
      provider: provider.id,
      cliVersion: caps.version,
      ...(context.sessionId === undefined ? {} : { agentSessionId: context.sessionId }),
      worktreePath: worktree.path,
      branch: worktree.branch,
      status: 'running',
      startedAt: this.now,
    }
    storage.createRun(run)

    const resumeSpec = prior?.agentSessionId === undefined
      ? null
      : provider.buildResume(context, caps, prior.agentSessionId)
    const spec = resumeSpec ?? provider.buildStart(context, caps)

    const spawner = this.options.spawn ?? spawnProcess
    const handle = await spawner(spec)

    this.emit(runId, 'notice', {
      level: 'info',
      text: `${provider.id} ${caps.version} · pid ${String(handle.pid)}`
        + (resumeSpec === null ? '' : ` · 接续会话 ${String(prior?.agentSessionId)}`),
    })
    if (staged.length > 0) {
      this.emit(runId, 'notice', {
        level: 'info',
        text: `带 ${String(staged.length)} 个附件：${staged.map((file) => file.filename).join('、')}`,
      })
    }
    const lastHuman = [...comments].reverse().find((comment) => comment.author === 'human')
    if (lastHuman !== undefined) {
      this.emit(runId, 'notice', {
        level: 'info',
        text: `带着 ${String(comments.length)} 条讨论重做，最新一条：${lastHuman.body.slice(0, 200)}`,
      })
    }

    const renew = setInterval(() => { this.renewLease(task.id, runId) }, this.leaseTtl / RENEW_DIVISOR)
    const timeout = setTimeout(() => {
      this.emit(runId, 'notice', { level: 'warn', text: '超时，正在终止整棵进程树' })
      void handle.terminate()
    }, this.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    renew.unref()
    timeout.unref()
    this.active.set(runId, { handle, renew, timeout, taskId: task.id, cancelled: false })

    void this.consume(run, agent, handle, worktree, task).catch((error: unknown) => {
      this.emit(runId, 'notice', { level: 'warn', text: `事件流中断: ${describeError(error)}` })
    })

    return run
  }

  /** 逐行读 stdout、归一化、落库、广播；进程退出后收尾。 */
  private async consume(
    run: Run, agent: DetectedAgent, handle: ProcessHandle, worktree: Worktree, task: Task,
  ): Promise<void> {
    const { storage } = this.options
    const rawLines: string[] = []
    let sessionId = run.agentSessionId
    /** 上一条已广播的 session 事件负载，用来压掉重复上报。 */
    let lastSessionKey: string | undefined
    let finishedOk: boolean | undefined
    let diagnostic: string | undefined
    /** Agent 这一轮的回复。finished 事件的 summary 优先，没有就退回最后一段正文。 */
    let answer: string | undefined
    let lastText: string | undefined
    /** 这一轮有没有真的干出点什么（说过话或用过工具）。 */
    let produced = false

    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    handle.stderr?.on('data', (chunk: Buffer) => {
      // stderr 必须有人读：CLI 的参数错误、鉴权提示都在这里，
      // 只 pipe 不读会让硬失败在界面上完全看不见。
      // 但**必须持续读**（哪怕丢弃），否则管道写满后子进程会阻塞。
      if (stderrBytes >= STDERR_KEEP_BYTES) return
      stderrBytes += chunk.length
      stderrChunks.push(chunk)
    })

    // 在 finally 里读取并保存，保证正常与异常两条路径都拿得到，
    // 也保证 active 条目一定被彻底移除。
    let cancelled = false
    try {
      for await (const line of createInterface({ input: handle.stdout })) {
        rawLines.push(line)
        // 一行可以是好几件事：claude 的 result 同时是"结束"和"这一轮花了多少"。
        for (const event of agent.provider.parseLine(line, agent.caps)) {
          if (event.kind === 'session') {
            // 有的 CLI 每条事件都带会话 id（opencode 就是），逐条广播会把面板刷满。
            // 只有当这条 session 事件确实带来了新东西（第一次出现，或多了 model /
            // apiKeySource 这类字段）才放行 —— 按整条负载比对，而不是只比 id，
            // 免得把 claude 那条含 apiKeySource 的 init 事件误当重复吞掉。
            const key = JSON.stringify(event)
            if (key === lastSessionKey) continue
            lastSessionKey = key
            sessionId = event.sessionId
          }
          if (event.kind === 'text' || event.kind === 'tool') produced = true
          if (event.kind === 'text' && event.text.trim().length > 0) lastText = event.text
          if (event.kind === 'finished') {
            finishedOk = event.ok
            diagnostic = event.diagnostic
            answer = event.summary
          }
          this.emit(run.id, event.kind, event as unknown as Record<string, unknown>)
        }
      }
    } catch (error) {
      // 事件流中断（stdout EPIPE、落库失败…）时进程很可能还活着。
      // 不收拾的话：定时器不停、active 条目不删，而 reclaimExpired 恰好会
      // 跳过 active 里的任务 —— 这张卡就永远停在 Running 了。
      await handle.terminate().catch(() => undefined)
      this.finish(run, task, {
        status: 'failed',
        exitCode: handle.outcome()?.code ?? undefined,
        diagnostic: `事件流中断: ${describeError(error)}`,
      })
      throw error
    } finally {
      cancelled = this.active.get(run.id)?.cancelled === true
      this.clearActive(run.id)
    }

    const outcome = await handle.exited

    const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim()
    await writeFile(join(this.options.artifactsRoot, run.id, 'raw.log'), rawLines.join('\n'), 'utf8')
    if (stderrText.length > 0) {
      await writeFile(join(this.options.artifactsRoot, run.id, 'stderr.txt'), stderrText, 'utf8')
    }

    /*
     * 完成判定：显式的 finished 事件优先，没有就退回退出码 —— 只信退出码是
     * 脆弱的，只信事件又不是所有 CLI 都给，所以两者都要。
     *
     * 但退出码握有**一票否决**：CLI 说完"这一轮成了"之后进程仍然以非零码
     * 结束，说明收尾阶段出了事（`-o` 落盘失败、清理时崩溃），那不是一次
     * 干净的成功，不该悄悄记成 completed。反过来不成立 —— 说失败就是失败，
     * 退出码是 0 也不翻案。
     *
     * 被信号杀掉（code 为 null）不算它自己报的错：主动取消与超时走的就是
     * 这条路，而那时 CLI 若已经说过成功，这一轮的活确实干完了。
     */
    const exitReportedFailure = outcome.code !== null && outcome.code !== 0
    const ok = (finishedOk ?? outcome.code === 0) && !exitReportedFailure
    const diff = await worktreeDiff(worktree, task.baseBranch).catch(() => '')
    const changed = diff.trim().length > 0

    this.emit(run.id, 'notice', {
      level: ok ? 'info' : 'warn',
      text: `退出 code=${String(outcome.code)} 树已静默=${String(outcome.treeQuiesced)} 改动=${changed ? '有' : '无'}`,
    })

    const failureDetail = [
      diagnostic
        ?? (stderrText.length > 0 ? stderrText.slice(0, 512) : undefined)
        ?? `exit=${String(outcome.code)}`,
      // CLI 报了成功却非零退出 —— 不解释一句的话，Review 里只会看到一个
      // 光秃秃的 exit=N，而上面的事件流明明写着「finished ok=true」。
      finishedOk === true && exitReportedFailure
        ? '（CLI 报告这一轮成功，但进程随后以非零码退出：收尾阶段出了事，'
          + '本次不按干净的成功处理。改动仍在工作区里，可自行判读）'
        : null,
      // 会话刚建立就死、一句话一个工具都没有 —— 这种形状的失败几乎都出在
      // CLI 自己那边（默认模型解析不出、配置有问题、没登录），而各家给的
      // 错误信息又往往含糊到没法照做。给一条能试的线索，不下结论。
      !produced && this.now - run.startedAt < IMMEDIATE_FAILURE_MS
        ? '（会话刚建立就失败，没有任何输出：多半是这个 CLI 自己的默认模型或配置有问题，'
          + '试试在卡上明确指定一个模型，或者手动跑一次同样的命令看它怎么说）'
        : null,
    ].filter((part) => part !== null).join(' ')

    // 主动取消不是失败：`aborted` 与 `failed` 在执行历史和成功率里必须分开，
    // 否则"我自己按的停止"会被算进失败率。
    storage.updateRun({
      ...run,
      ...(sessionId === undefined ? {} : { agentSessionId: sessionId }),
      status: ok ? 'completed' : cancelled ? 'aborted' : 'failed',
      exitCode: outcome.code ?? undefined,
      ...(ok ? {} : { diagnostic: cancelled ? '已被用户取消' : failureDetail }),
      endedAt: this.now,
    })

    // Agent 这一轮的回复进讨论。**失败的那一轮也记**：它说到哪儿、卡在哪儿，
    // 正是人接下来要回应的东西 —— 只记成功的等于把最需要讨论的部分丢掉。
    const said = (answer ?? lastText ?? '').trim()
    if (said.length > 0) {
      storage.addComment({
        id: `c-${randomUUID().slice(0, 8)}`,
        taskId: task.id,
        author: 'agent',
        body: said,
        runId: run.id,
        at: this.now,
      })
    }

    // 讨论**不消费**：这一轮的答复和人先前的留言都留着，下一轮连着一起带走。
    // 反馈因此是累积的，而不是每次只剩最后一句。
    // 成功与失败都进 Review：这一轮的分支、日志和诊断都要人判读，判完
    // 要么打回重跑、要么废弃。没有 Failed 列可以让失败的卡自己待着。
    this.release(task.id)
  }

  /** 终止一次执行。幂等。 */
  async cancel(runId: RunId): Promise<boolean> {
    const entry = this.active.get(runId)
    if (entry === undefined) return false
    entry.cancelled = true
    this.emit(runId, 'notice', { level: 'warn', text: '收到取消请求，正在终止整棵进程树' })
    await entry.handle.terminate()
    return true
  }

  /**
   * 启动时对账：上次进程崩溃留下的 Run 标记为 aborted，
   * 卡片交给租约回收机制放回 ready。
   * @returns 被清理的 Run 数量。
   */
  reconcile(): number {
    const { storage } = this.options
    const orphans = storage.listOrphanRuns().filter((run) => !this.active.has(run.id))
    for (const run of orphans) {
      storage.updateRun({
        ...run,
        status: 'aborted',
        diagnostic: '上次进程退出时该 Run 仍在运行，已标记为中止',
        endedAt: this.now,
      })
    }
    return orphans.length
  }

  /** 把租约过期却卡在 running 的任务放回 ready。 */
  reclaimExpired(): TaskId[] {
    const { storage } = this.options
    const now = this.now
    const reclaimed: TaskId[] = []
    for (const task of storage.listTasks()) {
      if (task.column !== 'running' || !isLeaseExpired(task, now)) continue
      // 还在本进程里跑着的不算过期，只是续租还没到点。
      if (task.lease !== undefined && this.active.has(task.lease.runId)) continue
      // 必须用 reclaimIfExpired 而不是 moveTask：领域层**故意禁止**
      // running → ready，人不能把正在跑的卡拖回队列。回收是系统操作，
      // 走的是专门为它开的这道门。
      const recovered = reclaimIfExpired(task, now)
      if (recovered !== null && storage.commitTask(recovered)) reclaimed.push(task.id)
    }
    return reclaimed
  }

  private renewLease(taskId: TaskId, runId: RunId): void {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null) return
    const renewed = renewLease(task, runId, this.leaseTtl, this.now)
    if (renewed.ok) storage.commitTask(renewed.value)
  }

  /**
   * 把卡片移出 running 并释放租约。**唯一去向是 Review** —— 领域层也只开了
   * 这一个出口，成败都得过人眼。
   * @returns 是否成功落库；卡片已不在 running 时返回 false。
   */
  private release(taskId: TaskId): boolean {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null || task.column !== 'running') return false
    const moved = moveTask(task, { expectedRevision: task.revision, to: 'review', now: this.now })
    return moved.ok && storage.commitTask(moved.value)
  }

  /**
   * 停掉定时器并彻底移除条目。
   *
   * **两条路径都必须走到这里**：`active` 里的残留会让 reclaimExpired 永远跳过
   * 这张卡（它刻意不回收本进程仍在跑的任务），于是卡片永远停在 Running。
   */
  private clearActive(runId: RunId): void {
    const entry = this.active.get(runId)
    if (entry === undefined) return
    clearInterval(entry.renew)
    clearTimeout(entry.timeout)
    this.active.delete(runId)
  }

  /**
   * 异常路径下的统一收尾：把 Run 打到终态、把卡片放回去。
   * 每一步都各自兜住异常 —— 收尾流程本身再抛就真的没人管了。
   */
  private finish(
    run: Run, task: Task,
    outcome: { status: 'failed' | 'aborted'; exitCode?: number | undefined; diagnostic: string },
  ): void {
    try {
      this.options.storage.updateRun({
        ...run,
        status: outcome.status,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        diagnostic: outcome.diagnostic,
        endedAt: this.now,
      })
    } catch {
      // 落库都失败了就只能靠下次启动的 reconcile 兜底。
    }
    try {
      this.release(task.id)
    } catch {
      // 同上。
    }
  }

  /**
   * 先落库再广播 —— 反过来会推出还没落盘的 seq，断线重连就漏了。
   *
   * **尽力而为，绝不抛出。** 一条事件写不进去（磁盘满、库被锁）是要记下来的
   * 麻烦，但不该因此杀掉正在进行的执行 —— Agent 真正干的活比一行日志值钱。
   * 而且异常处理路径本身也要 emit，让它可抛会引发二次故障。
   */
  private emit(runId: RunId, kind: string, payload: unknown): void {
    const at = this.now
    try {
      const seq = this.options.storage.appendEvent(runId, kind, payload, at)
      this.options.bus.publish({ runId, seq, kind, payload, at })
    } catch (error) {
      console.error(`[loopkanban] 事件落库失败 run=${runId} kind=${kind}:`, error)
    }
  }
}

/**
 * 关联卡片在规格里展开多少字。
 *
 * 它们是参考资料，不是这次要做的活 —— 五张各写两千字的卡会把真正的需求
 * 挤到 Agent 的注意力之外。截断处明说截断了，比悄悄少给一半强。
 */
const RELATED_EXCERPT = 1200

/** 一张关联卡在规格里的样子：编号、状态、标题、需求正文与验收标准。 */
function renderRelated(task: Task): string[] {
  const body = task.description.trim()
  const excerpt = body.length > RELATED_EXCERPT
    ? `${body.slice(0, RELATED_EXCERPT)}\n\n（这张卡的描述过长，此处只截取前一段）`
    : body
  const lines = [`### ${String(task.id)} · ${COLUMN_LABEL[task.column]} · ${taskTitle(task)}`, '']
  if (excerpt.length > 0) lines.push(excerpt, '')
  if (task.acceptance.length > 0) {
    lines.push('验收标准：')
    for (const item of task.acceptance) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines
}

/** 列名在规格里的说法。给的是"这张关联卡走到哪儿了"，Agent 据此判断它有多可信。 */
const COLUMN_LABEL: Readonly<Record<Task['column'], string>> = {
  backlog: '想法池（还没定下来）',
  ready: '队列中（还没开工）',
  running: '正在执行',
  review: '待验收（做完了但还没过人眼）',
  done: '已完成',
}

/**
 * 投喂给 Agent 的任务规格，写进 worktree 根目录。
 *
 * 讨论线程整段附在后面：人和 Agent 的往来是这张卡真正的上下文，只给最后
 * 一句会让 Agent 反复推翻自己已经确认过的结论。
 *
 * 附件列成一节**带上相对路径**：文件已经躺在 worktree 里了，但 Agent 只有
 * 知道它们在哪儿、分别是什么，才会真的去读 —— 光把文件放进目录，多数时候
 * 它连看都不会看一眼。
 *
 * 关联的卡同样整段展开，并且**明写它们是参考、不是这次的活**：只给一串 id
 * 等于没给（Agent 没有任何办法查到那张卡长什么样），而不声明身份则会让它
 * 顺手把参考资料里的验收标准也一并做掉。
 */
export function renderTaskSpec(
  task: Task, comments: readonly TaskComment[] = [], attachments: readonly StagedAttachment[] = [],
  related: readonly Task[] = [],
): string {
  const lines = [`# ${taskTitle(task)}`, '', task.description.trim(), '']
  // 验收标准是可选的：没写就不摆一个空标题在那儿装样子。
  if (task.acceptance.length > 0) {
    lines.push('## 验收标准', '')
    for (const item of task.acceptance) lines.push(`- [ ] ${item}`)
  }
  // 规格附件进「附件」一节，讨论里带的跟着它那条留言走 —— 一张截图脱离了
  // 「这儿为什么长这样」那句话就只是一张来历不明的图，摆进需求清单反而
  // 会被当成一条新要求。
  const spec = attachments.filter((file) => file.commentId === undefined)
  if (spec.length > 0) {
    lines.push('', '## 附件', '', '这些文件是需求的一部分，已经放在工作区里，请读过再动手：', '')
    for (const file of spec) lines.push(describeStaged(file))
    lines.push('', '读不了某个格式（比如 Word、PDF）就想办法转成文本再读，不要跳过它。')
  }
  if (related.length > 0) {
    lines.push(
      '', '## 关联任务', '',
      '这几张卡是这张卡的**参考资料**，不是这次要做的活 —— 读它们是为了让你的改动',
      '跟它们对得上（接口、命名、已经定下来的做法）。不要去实现它们的验收标准。',
      '',
    )
    for (const other of related) lines.push(...renderRelated(other))
  }
  if (comments.length > 0) {
    lines.push('', '## 讨论', '')
    for (const comment of comments) {
      lines.push(`### ${comment.author === 'agent' ? 'Agent' : '人'} · ${new Date(comment.at).toISOString()}`, '')
      lines.push(comment.body.trim(), '')
      const carried = attachments.filter((file) => file.commentId === comment.id)
      if (carried.length > 0) {
        lines.push('这条留言带了这些文件，已经放在工作区里：', '')
        for (const file of carried) lines.push(describeStaged(file))
        lines.push('')
      }
    }
  }
  lines.push('', '## 约束', '', '- 不要提交或推送，改动留在工作区即可', '- 不要改动本文件')
  return `${lines.join('\n')}\n`
}

/**
 * 交给 CLI 的 prompt。刻意指向 TASK.md，避免把长文本堆进命令行。
 *
 * 附件在这里**再点一次名**：TASK.md 里已经有完整清单，但 prompt 是 CLI
 * 唯一保证会读的东西，附件是需求的一部分，不该指望它自己翻到那一节。
 *
 * 关联的卡同样在这里点名：TASK.md 里有它们的正文，但 prompt 是 CLI 唯一
 * 保证会读的东西，而"有几张卡要一起读"这件事本身就会改变它的做法。
 *
 * @param task - 目标任务。
 * @param resuming - 是否接续上一次会话；是的话措辞要说明这是返工而非重做。
 * @param attachments - 已经拷进 worktree 的附件。
 * @param related - 关联的同项目卡片，已经展开在 TASK.md 里。
 */
export function renderPrompt(
  task: Task,
  comments: readonly TaskComment[] = [],
  resuming = false,
  attachments: readonly StagedAttachment[] = [],
  related: readonly Task[] = [],
): string {
  const lines: string[] = []
  const lastHuman = [...comments].reverse().find((comment) => comment.author === 'human')
  if (lastHuman === undefined) {
    lines.push(`阅读仓库根目录的 TASK.md 并完成其中的任务：${taskTitle(task)}`)
  } else {
    lines.push(
      resuming
        ? '这张卡有了新的反馈。工作区里就是你上次的改动，请在此基础上继续：'
        : `任务「${taskTitle(task)}」有新的反馈。工作区里是上一轮的改动，请在此基础上继续：`,
      '',
      lastHuman.body,
      '',
      '完整需求与此前的往来见仓库根目录的 TASK.md 的「讨论」一节。',
    )
  }
  const spec = attachments.filter((file) => file.commentId === undefined)
  if (spec.length > 0) {
    lines.push(
      '',
      `这张卡带了 ${String(spec.length)} 个附件，是需求的一部分，动手前先读：`,
      ...spec.map((file) => `- ${file.relPath}（${file.filename}）`),
    )
  }
  // 最新这条反馈自己带的文件**单独点一次名**：它多半就是这一轮要看的东西
  // （"照着这张图改"），混在整卡的清单里说一句"共 N 个附件"，等于指望
  // Agent 自己去分辨哪个是新的。
  const carried = lastHuman === undefined
    ? []
    : attachments.filter((file) => file.commentId === lastHuman.id)
  if (carried.length > 0) {
    lines.push(
      '',
      `这条反馈带了 ${String(carried.length)} 个文件，就是它说的那些东西：`,
      ...carried.map((file) => `- ${file.relPath}（${file.filename}）`),
    )
  }
  if (related.length > 0) {
    lines.push(
      '',
      `这张卡关联了 ${String(related.length)} 张同项目的卡片，正文在 TASK.md 的「关联任务」一节，`
      + '是**参考资料**而不是这次要做的活 —— 动手前先读，做完对一遍别和它们打架：',
      ...related.map((other) => `- ${String(other.id)} ${taskTitle(other)}`),
    )
  }
  lines.push('完成后简要说明你做了什么，以及验收标准是否逐条满足 —— 这段说明会作为你的回复出现在讨论里。')
  lines.push('不要提交、不要推送、不要改动 TASK.md。')
  return lines.join('\n')
}

/** TASK.md 里的一条附件：路径在前，因为 Agent 要拿它去读文件。 */
function describeStaged(file: StagedAttachment): string {
  return `- \`${file.relPath}\` —— ${file.filename}（${file.mime}，${humanSize(file.size)}）`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
