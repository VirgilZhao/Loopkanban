/**
 * 验收：看 diff、通过、打回、废弃。
 *
 * 一条贯穿的原则：**绝不擅自动用户的主工作区**。Agent 的改动始终留在自己的
 * worktree 分支上；验收通过默认只是把它提交成一个可合并的对象，合不合、
 * 什么时候合由人决定。自动 merge 进一个可能是脏的、可能停在别的分支上的
 * 主工作区，是这个工具最容易造成破坏性意外的地方。
 */

import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { moveTask, requestChanges, type Task, type TaskId } from '@openkanban/core'
import type { Run, Storage } from '../storage/index.ts'
import { commitAll, mergeBranch, removeWorktree, worktreeDiff, type Worktree } from '../worktree/index.ts'

export interface ReviewOptions {
  readonly storage: Storage
  readonly worktreeRoot: string
  readonly now?: () => number
}

export type ReviewFailure = { readonly ok: false; readonly reason: string; readonly detail: string }
export type ReviewSuccess<T = unknown> = { readonly ok: true } & T
export type ReviewResult<T = unknown> = ReviewSuccess<T> | ReviewFailure

export interface DiffView {
  readonly runId: string
  readonly branch: string
  readonly baseBranch: string
  readonly stat: string
  readonly patch: string
  /** patch 是否因为过大而被截断。 */
  readonly truncated: boolean
}

/** diff 展示上限。再大就不该在浏览器里看了，产物目录有完整的。 */
const PATCH_MAX = 400_000

export class Review {
  // 不用参数属性：`node --experimental-strip-types` 的 strip-only 模式不支持它
  // （也不支持 enum / namespace / 装饰器）。全项目靠这个模式免掉构建步骤。
  private readonly options: ReviewOptions

  constructor(options: ReviewOptions) {
    this.options = options
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 任务最近一次 Run；没有则 null。 */
  private latestRun(taskId: TaskId): Run | null {
    return this.options.storage.listRuns(taskId)[0] ?? null
  }

  private worktreeOf(run: Run): Worktree {
    return { path: run.worktreePath, branch: run.branch }
  }

  /**
   * 取出待验收的改动。
   * @param taskId - 目标任务。
   */
  async diff(taskId: TaskId): Promise<DiffView | null> {
    const task = this.options.storage.getTask(taskId)
    const run = this.latestRun(taskId)
    if (task === null || run === null) return null

    const full = await worktreeDiff(this.worktreeOf(run), task.baseBranch).catch(() => '')
    const [stat = '', ...rest] = full.split('\ndiff --git ')
    const patch = rest.length === 0 ? '' : `diff --git ${rest.join('\ndiff --git ')}`
    return {
      runId: run.id,
      branch: run.branch,
      baseBranch: task.baseBranch,
      stat: stat.trim(),
      patch: patch.slice(0, PATCH_MAX),
      truncated: patch.length > PATCH_MAX,
    }
  }

  /**
   * 验收通过。
   *
   * 默认行为：把改动提交到任务分支、移除 worktree、**保留分支**，卡片进 Done。
   * 用户拿到分支名，自己决定合并还是开 PR。
   *
   * 失败的执行也停在 Review，所以这里必须容得下"根本没建出工作区"的卡
   * （起进程就失败的那种）：明确拒绝，而不是让 git 在不存在的目录上炸成 500。
   *
   * @param taskId - 目标任务。
   * @param merge - 显式要求合并回基线。前置条件不满足会明确拒绝而不是勉强执行。
   */
  async accept(taskId: TaskId, merge = false): Promise<ReviewResult<{ commit: string | null; merged: boolean }>> {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null) return { ok: false, reason: 'task-not-found', detail: String(taskId) }
    if (task.column !== 'review') {
      return { ok: false, reason: 'illegal-transition', detail: `只有 review 列的任务可以验收，当前在 ${task.column}` }
    }
    const run = this.latestRun(taskId)
    if (run === null) return { ok: false, reason: 'no-run', detail: '这张卡没有执行记录' }

    const worktree = this.worktreeOf(run)
    if (!(await access(worktree.path).then(() => true, () => false))) {
      return {
        ok: false,
        reason: 'no-worktree',
        detail: '这次执行没留下工作区，没有东西可验收 —— 打回重跑或废弃',
      }
    }

    // **领域层的判定必须在任何副作用之前跑完**。moveTask 是纯函数，提前算一次
    // 就是一次完整的前置校验；留到 commitAll / mergeBranch 之后才算，等于让
    // 每一条新加的守卫都变成"主干已经被合过了，然后告诉你操作被拒绝"。
    // 归档就踩过这个坑：archive 不改 column，上面的列检查放行，改动却在
    // moveTask 拒绝之前已经进了用户的基线分支。
    const verdict = moveTask(task, { expectedRevision: task.revision, to: 'done', now: this.now })
    if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail }

    const commit = await commitAll(worktree, commitMessage(task, run))

    let merged = false
    if (merge) {
      const result = await mergeBranch(task.repoPath, run.branch, task.baseBranch)
      // 合并失败不等于验收失败：改动已经提交在分支上，不会丢。
      // 但必须如实告诉用户没合上，否则他会以为已经进主干了。
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }
      merged = true
    }

    // **CAS 必须在删 worktree 之前**。反过来的话，一旦这里冲突失败，
    // worktree 已经没了、卡还停在 Review，而用户按提示重试会在不存在的目录上
    // 跑 git、直接 500 —— 这张卡就再也走不出 Review 了。
    // 落库用的仍是上面算好的那个值：期间没人改过这张卡的话它就是对的，
    // 改过了则这条 CAS 会失败，正是它该做的事。
    if (!storage.commitTask(verdict.value)) {
      return { ok: false, reason: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' }
    }

    // 状态已经落定，删 worktree 只是收拾场地。这一步失败不该让验收作废，
    // 残留目录由下次启动的对账清理。
    await removeWorktree(task.repoPath, worktree, true).catch(() => undefined)
    return { ok: true, commit, merged }
  }

  /**
   * 打回重做：带上评审意见把卡片放回队列。
   *
   * worktree 与分支**保留** —— 下一次执行接着在同一个工作区继续，
   * 这样 Agent 能看到自己上次的成果，而不是从空目录重来。
   *
   * @param taskId - 目标任务。
   * @param feedback - 要改什么。空的会被拒绝。
   */
  requestChanges(taskId: TaskId, feedback: string): ReviewResult {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null) return { ok: false, reason: 'task-not-found', detail: String(taskId) }

    const changed = requestChanges(task, { expectedRevision: task.revision, feedback, now: this.now })
    if (!changed.ok) return { ok: false, reason: changed.reason, detail: changed.detail }
    if (!storage.commitTask(changed.value)) {
      return { ok: false, reason: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' }
    }
    return { ok: true }
  }

  /**
   * 废弃这次成果：删掉分支与 worktree，卡片回想法池。
   *
   * **去向只有 backlog**。没有"记为失败"这个终点了 —— 一张卡要么做完进 Done，
   * 要么回到想法池等着重新想清楚需求。攒一列没人再看的死卡没有价值。
   *
   * @param taskId - 目标任务。
   */
  async discard(taskId: TaskId): Promise<ReviewResult> {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null) return { ok: false, reason: 'task-not-found', detail: String(taskId) }

    // 同 accept：先把状态落定，再做不可逆的删除。CAS 冲突时至少东西还在，
    // 用户重试一次就能继续；顺序反过来则是"删完了却没记上"。
    const moved = moveTask(task, { expectedRevision: task.revision, to: 'backlog', now: this.now })
    if (!moved.ok) return { ok: false, reason: moved.reason, detail: moved.detail }
    if (!storage.commitTask(moved.value)) {
      return { ok: false, reason: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' }
    }

    const run = this.latestRun(taskId)
    if (run !== null) {
      // 连分支一起删：用户明确表示这次成果不要了。
      await removeWorktree(task.repoPath, this.worktreeOf(run), false).catch(() => undefined)
      await rm(join(this.options.worktreeRoot, taskId), { recursive: true, force: true })
    }
    return { ok: true }
  }

  /**
   * 删卡前的场地清理：把这张卡留下的 worktree 与分支全部删掉。
   *
   * 想法池和队列里的卡也可能留着工作区 —— 打回重做的卡就停在 ready，
   * 而它上一次执行的 worktree 是**故意保留**的（下一次接着改）。删卡时
   * 不收拾，那个目录和分支就再也没有任何东西指向它们了。
   *
   * 逐个 Run 地删而不是只删最后一次：卡片标题改过之后分支名会跟着变，
   * 同一张卡可能留下不止一个分支。
   *
   * 取的是任务与 Run 的**值**而不是 id：调用方必须先把库里的行删掉
   * （状态落定在前，不可逆的删除在后，同 accept 与 discard），到这一步
   * 已经查不到它们了。
   *
   * 全程吞掉异常：卡已经删了，收拾场地失败不该把这次删除变成一半成功。
   * 残留目录由下次启动的对账清理。
   *
   * @param task - 被删掉的任务。
   * @param runs - 它的全部执行记录。
   */
  async purge(task: Task, runs: readonly Run[]): Promise<void> {
    for (const run of runs) {
      await removeWorktree(task.repoPath, this.worktreeOf(run), false).catch(() => undefined)
    }
    await rm(join(this.options.worktreeRoot, task.id), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 提交信息带上执行者，日后 blame 时看得出这段是谁写的。 */
function commitMessage(task: Task, run: Run): string {
  return [task.subject, '', `Task: ${task.id}`, `Agent: ${run.provider} ${run.cliVersion}`].join('\n')
}
