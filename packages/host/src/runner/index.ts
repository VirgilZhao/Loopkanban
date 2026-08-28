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
  acquireLease, asRunId, consumeFeedback, isLeaseExpired, moveTask, reclaimIfExpired, renewLease,
  type RunId, type Task, type TaskId,
} from '@loopkanban/core'
import type { AgentEvent, RunContext } from '../agents/types.ts'
import type { DetectedAgent } from '../agents/index.ts'
import type { RunBus } from '../server/bus.ts'
import type { Run, Storage } from '../storage/index.ts'
import { spawnProcess, type ProcessHandle, type SpawnSpec } from '../subprocess/index.ts'
import { branchSlug, ensureWorktree, worktreeDiff, type Worktree } from '../worktree/index.ts'

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

export interface RunnerOptions {
  readonly storage: Storage
  readonly bus: RunBus
  readonly agents: readonly DetectedAgent[]
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
    const { storage, agents } = this.options
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
      // launch 可能已经写了 Run 记录才失败（例如 spawn 时 CLI 二进制刚被替换）。
      // 不打到终态的话，它会永远算作 running，把统计和孤儿对账都带偏。
      const created = storage.getRun(runId)
      if (created !== null && created.status === 'running') {
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
      task.repoPath, task.id, branchSlug(task.id, task.subject), task.baseBranch,
    )

    const artifactsDir = join(artifactsRoot, runId)
    await mkdir(artifactsDir, { recursive: true })
    await writeFile(join(worktree.path, 'TASK.md'), renderTaskSpec(task), 'utf8')

    const context: RunContext = {
      runId,
      worktreePath: worktree.path,
      artifactsDir,
      prompt: renderPrompt(task, prior !== undefined),
      permission: 'standard',
      // claude 支持预先指定会话 id；codex 只能事后从 thread.started 捞。
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
    if (task.feedback !== undefined) {
      this.emit(runId, 'notice', { level: 'info', text: `带着评审意见重做：${task.feedback.slice(0, 200)}` })
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
        const event = agent.provider.parseLine(line, agent.caps)
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
        if (event.kind === 'finished') {
          finishedOk = event.ok
          diagnostic = event.diagnostic
        }
        this.emit(run.id, event.kind, event as unknown as Record<string, unknown>)
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

    // 完成判定：显式的 finished 事件优先；没有就退回退出码。
    // 只信退出码是脆弱的，只信事件又不是所有 CLI 都给，所以两者都要。
    const ok = finishedOk ?? (outcome.code === 0)
    const diff = await worktreeDiff(worktree, task.baseBranch).catch(() => '')
    const changed = diff.trim().length > 0

    this.emit(run.id, 'notice', {
      level: ok ? 'info' : 'warn',
      text: `退出 code=${String(outcome.code)} 树已静默=${String(outcome.treeQuiesced)} 改动=${changed ? '有' : '无'}`,
    })

    const failureDetail = diagnostic
      ?? (stderrText.length > 0 ? stderrText.slice(0, 512) : undefined)
      ?? `exit=${String(outcome.code)}`

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

    // 评审意见只在真正跑出可验收结果之后才清。
    // 在交给 Agent 的瞬间就清是错的：那一轮如果失败了，人写的意见就凭空丢了,
    // 重新派活时 Agent 又会从头做一遍同样的活。
    if (ok) {
      const current = storage.getTask(task.id)
      if (current !== null && current.feedback !== undefined) {
        storage.commitTask(consumeFeedback(current, this.now))
      }
    }
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

/** 投喂给 Agent 的任务规格，写进 worktree 根目录。 */
export function renderTaskSpec(task: Task): string {
  const lines = [`# ${task.subject}`, '']
  if (task.description.trim().length > 0) lines.push(task.description.trim(), '')
  lines.push('## 验收标准', '')
  for (const item of task.acceptance) lines.push(`- [ ] ${item}`)
  lines.push('', '## 约束', '', '- 不要提交或推送，改动留在工作区即可', '- 不要改动本文件')
  return `${lines.join('\n')}\n`
}

/**
 * 交给 CLI 的 prompt。刻意指向 TASK.md，避免把长文本堆进命令行。
 * @param task - 目标任务。
 * @param resuming - 是否接续上一次会话；是的话措辞要说明这是返工而非重做。
 */
export function renderPrompt(task: Task, resuming = false): string {
  const lines: string[] = []
  if (task.feedback === undefined) {
    lines.push(`阅读仓库根目录的 TASK.md 并完成其中的任务：${task.subject}`)
  } else {
    lines.push(
      resuming
        ? '你上一轮的成果被评审打回了。工作区里就是你上次的改动，请在此基础上修改：'
        : `任务「${task.subject}」上一轮被评审打回。工作区里是上次的改动，请在此基础上修改：`,
      '',
      task.feedback,
      '',
      '完整需求见仓库根目录的 TASK.md。',
    )
  }
  lines.push('完成后简要说明你做了什么，以及验收标准是否逐条满足。')
  lines.push('不要提交、不要推送、不要改动 TASK.md。')
  return lines.join('\n')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
