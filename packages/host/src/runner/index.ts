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
 * - **失败也要有结构化的原因**。Failed 卡片上要显示人看得懂的东西，
 *   而不是一坨 stack trace。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  acquireLease, asRunId, isLeaseExpired, moveTask, reclaimIfExpired, renewLease,
  type RunId, type Task, type TaskId,
} from '@openkanban/core'
import type { AgentEvent, RunContext } from '../agents/types.ts'
import type { DetectedAgent } from '../agents/index.ts'
import type { RunBus } from '../server/bus.ts'
import type { Run, Storage } from '../storage/index.ts'
import { spawnProcess, type ProcessHandle, type SpawnSpec } from '../subprocess/index.ts'
import { branchSlug, createWorktree, worktreeDiff, type Worktree } from '../worktree/index.ts'

/** 租期。跑着的 Run 会在到期前续，崩溃的 Run 到期后被回收。 */
export const DEFAULT_LEASE_TTL_MS = 90_000
/** 续租间隔，取租期的三分之一，容得下两次失败。 */
const RENEW_DIVISOR = 3
/** 单次执行的默认超时。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

export interface RunnerOptions {
  readonly storage: Storage
  readonly bus: RunBus
  readonly agents: readonly DetectedAgent[]
  /** worktree 的存放根目录，放在仓库外以免污染主工作区。 */
  readonly worktreeRoot: string
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
      completed: new Set(storage.listTasks(task.boardId).filter((t) => t.column === 'done').map((t) => t.id)),
    })
    if (!claimed.ok) return { ok: false, reason: claimed.reason, detail: claimed.detail }
    if (!storage.commitTask(claimed.value)) {
      return { ok: false, reason: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' }
    }

    // ── 到这里这张卡确定归我们了，可以建 worktree、起进程。 ────
    try {
      return { ok: true, run: await this.launch(claimed.value, runId, agent) }
    } catch (error) {
      // 副作用建到一半失败，必须把卡放回去，否则它会一直卡在 running。
      this.release(taskId, 'failed')
      return { ok: false, reason: 'launch-failed', detail: describeError(error) }
    }
  }

  /** 真正建 worktree、写 TASK.md、起进程并接管输出。 */
  private async launch(task: Task, runId: RunId, agent: DetectedAgent): Promise<Run> {
    const { storage, artifactsRoot, worktreeRoot } = this.options
    const { provider, caps } = agent

    const branch = branchSlug(task.id, task.subject)
    const worktree = await createWorktree(task.repoPath, worktreeRoot, task.id, branch, task.baseBranch)

    const artifactsDir = join(artifactsRoot, runId)
    await mkdir(artifactsDir, { recursive: true })
    await writeFile(join(worktree.path, 'TASK.md'), renderTaskSpec(task), 'utf8')

    const context: RunContext = {
      runId,
      worktreePath: worktree.path,
      artifactsDir,
      prompt: renderPrompt(task),
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

    const spec = provider.buildStart(context, caps)
    const spawner = this.options.spawn ?? spawnProcess
    const handle = await spawner(spec)

    this.emit(runId, 'notice', { level: 'info', text: `${provider.id} ${caps.version} · pid ${String(handle.pid)}` })

    const renew = setInterval(() => { this.renewLease(task.id, runId) }, this.leaseTtl / RENEW_DIVISOR)
    const timeout = setTimeout(() => {
      this.emit(runId, 'notice', { level: 'warn', text: '超时，正在终止整棵进程树' })
      void handle.terminate()
    }, this.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    renew.unref()
    timeout.unref()
    this.active.set(runId, { handle, renew, timeout, taskId: task.id })

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
    let finishedOk: boolean | undefined
    let diagnostic: string | undefined

    const stderrChunks: Buffer[] = []
    handle.stderr?.on('data', (chunk: Buffer) => {
      // stderr 必须有人读：CLI 的参数错误、鉴权提示都在这里，
      // 只 pipe 不读会让硬失败在界面上完全看不见。
      if (stderrChunks.length < 2_000) stderrChunks.push(chunk)
    })

    for await (const line of createInterface({ input: handle.stdout })) {
      rawLines.push(line)
      const event = agent.provider.parseLine(line, agent.caps)
      if (event.kind === 'session') sessionId = event.sessionId
      if (event.kind === 'finished') {
        finishedOk = event.ok
        diagnostic = event.diagnostic
      }
      this.emit(run.id, event.kind, event as unknown as Record<string, unknown>)
    }

    const outcome = await handle.exited
    this.clearActive(run.id)

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

    storage.updateRun({
      ...run,
      ...(sessionId === undefined ? {} : { agentSessionId: sessionId }),
      status: ok ? 'completed' : 'failed',
      exitCode: outcome.code ?? undefined,
      ...(ok ? {} : { diagnostic: failureDetail }),
      endedAt: this.now,
    })

    this.release(task.id, ok ? 'review' : 'failed')
  }

  /** 终止一次执行。幂等。 */
  async cancel(runId: RunId): Promise<boolean> {
    const entry = this.active.get(runId)
    if (entry === undefined) return false
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
   * 把卡片移出 running 并释放租约。
   * @returns 是否成功落库；卡片已不在 running 时返回 false。
   */
  private release(taskId: TaskId, to: 'review' | 'failed'): boolean {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null || task.column !== 'running') return false
    const moved = moveTask(task, { expectedRevision: task.revision, to, now: this.now })
    return moved.ok && storage.commitTask(moved.value)
  }

  private clearActive(runId: RunId): void {
    const entry = this.active.get(runId)
    if (entry === undefined) return
    clearInterval(entry.renew)
    clearTimeout(entry.timeout)
    this.active.delete(runId)
  }

  /** 先落库再广播 —— 反过来会推出还没落盘的 seq，断线重连就漏了。 */
  private emit(runId: RunId, kind: string, payload: unknown): void {
    const at = this.now
    const seq = this.options.storage.appendEvent(runId, kind, payload, at)
    this.options.bus.publish({ runId, seq, kind, payload, at })
  }
}

/** 投喂给 Agent 的任务规格，写进 worktree 根目录。 */
export function renderTaskSpec(task: Task): string {
  const lines = [`# ${task.subject}`, '']
  if (task.description.trim().length > 0) lines.push(task.description.trim(), '')
  lines.push('## 验收标准', '')
  for (const item of task.acceptance) lines.push(`- [ ] ${item}`)
  if (task.writeScopes.length > 0) {
    lines.push('', '## 写入范围', '', '只应改动以下路径下的文件：', '')
    for (const scope of task.writeScopes) lines.push(`- \`${scope}\``)
  }
  lines.push('', '## 约束', '', '- 不要提交或推送，改动留在工作区即可', '- 不要改动本文件')
  return `${lines.join('\n')}\n`
}

/** 交给 CLI 的 prompt。刻意指向 TASK.md，避免把长文本堆进命令行。 */
export function renderPrompt(task: Task): string {
  return [
    `阅读仓库根目录的 TASK.md 并完成其中的任务：${task.subject}`,
    '完成后简要说明你做了什么，以及验收标准是否逐条满足。',
    '不要提交、不要推送、不要改动 TASK.md。',
  ].join('\n')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
