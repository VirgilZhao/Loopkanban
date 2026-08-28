/**
 * 验收：看 diff、通过、打回、废弃。
 *
 * 一条贯穿的原则：**绝不擅自动用户的主工作区**。Agent 的改动始终留在自己的
 * worktree 分支上；验收通过默认只是把它提交成一个可合并的对象，合不合、
 * 什么时候合由人决定。自动 merge 进一个可能是脏的、可能停在别的分支上的
 * 主工作区，是这个工具最容易造成破坏性意外的地方。
 */

import { randomUUID } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import { moveTask, taskTitle, type Task, type TaskId } from '@loopkanban/core'
import { GitHub, type PullRequestView, type RepoSlug } from '../pr/index.ts'
import type { Run, Storage, TaskPullRequest } from '../storage/index.ts'
import {
  commitAll, defaultRemote, fetchBranch, mergeBranch, mergeIntoBranch, mergePreflight,
  pushBranch, removeWorktree, unresolvedConflicts, worktreeDiff, worktreeDir, type Worktree,
} from '../worktree/index.ts'

export interface ReviewOptions {
  readonly storage: Storage
  /**
   * 在真正动这张卡的 worktree 之前叫一声。
   *
   * 有一个东西必须先让开：跑在那个 worktree 里的测试环境（见 `testenv/`）——
   * 提交时它可能正往里写缓存，删除时那更是在拆它脚下的地板。
   *
   * **挂在这儿而不是挂在路由上**，是因为位置比动作重要：它必须在所有会被拒绝
   * 的校验都过完之后、第一个副作用之前。挂在路由上就只能"进门先杀"，于是主
   * 工作区脏这种把验收挡回去的情况，也会顺手把人正在用的测试环境收掉。
   *
   * 失败会被忽略（内部自己吞掉）：让不开也不该把验收变成一半成功。
   */
  readonly beforeMutate?: (taskId: TaskId) => Promise<unknown>
  readonly now?: () => number
  /** GitHub 侧。不给就自己造一个（会去找本机的 `gh`）。 */
  readonly github?: GitHub
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
  private readonly github: GitHub

  constructor(options: ReviewOptions) {
    this.options = options
    this.github = options.github ?? new GitHub()
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

    // 两道只读的前置判定，副作用一律排在它们后面 —— 被拒时这张卡一个字都
    // 没动过。
    //
    // 一是这次成果本身：解冲突那一轮跑失败的话，卡会带着满是冲突标记的工作区
    // 回到 Review，而 commitAll 在那种工作区上会抛 —— 抛出去就成了一个只说
    // "服务端出错"的 500，可这件事明明有话可说，也明明有下一步可做。
    const stuck = await this.conflictRefusal(worktree)
    if (stuck !== null) return stuck

    // 二是合并的两个前置条件（主工作区干净、停在基线分支上）。它们出在
    // **用户的主工作区**上，跟这次成果无关 —— 否则人拿到的是"验收被拒，
    // 但分支上已经多了一个提交、测试环境也没了"。
    if (merge) {
      const ready = await mergePreflight(task.repoPath, task.baseBranch)
      if (!ready.ok) return { ok: false, reason: ready.reason, detail: ready.detail }
    }

    // 从这里开始有副作用了。请测试环境让开 —— 它可能正往这个 worktree 里写东西，
    // 而下面第一件事就是把整个目录提交进去。
    await this.options.beforeMutate?.(taskId).catch(() => undefined)

    const commit = await commitAll(worktree, commitMessage(task, run))

    let merged = false
    if (merge) {
      const result = await mergeBranch(task.repoPath, run.branch, task.baseBranch)
      // 走到这儿还失败，是前置条件在这几百毫秒里变了（有人动了主工作区）。
      // 不等于验收失败：改动已经提交在分支上，不会丢 —— 但必须如实告诉用户
      // 没合上，否则他会以为已经进主干了。
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
      // 状态已经落定，接下来是不可逆的删除 —— 先请测试环境让开。
      await this.options.beforeMutate?.(taskId).catch(() => undefined)
      // 连分支一起删：用户明确表示这次成果不要了。
      await removeWorktree(task.repoPath, this.worktreeOf(run), false).catch(() => undefined)
      await rm(worktreeDir(task.repoPath, taskId), { recursive: true, force: true })
    }
    return { ok: true }
  }

  /**
   * 这张卡能不能走 PR 那条路，以及走不通的话卡在哪儿。
   *
   * 界面拿它决定"通过并合并"这颗按钮到底做什么：能开 PR 就开 PR，开不了
   * 就退回本地合并，并且**把原因写在按钮下面**。悄悄换一种行为是这里最
   * 不能做的事 —— 用户以为自己在开 PR，实际却动了主工作区。
   *
   * @param repoPath - 项目仓库路径。
   */
  async pullRequestCapability(repoPath: string): Promise<{
    gh: boolean
    remote: string | null
    repo: string | null
    ready: boolean
    reason?: string
    detail?: string
  }> {
    const gh = this.github.available()
    const remote = await defaultRemote(repoPath).catch(() => null)
    if (!gh) {
      return {
        gh, remote, repo: null, ready: false, reason: 'gh-missing',
        detail: '本机没找到 gh —— 开 PR 用的是你自己登录好的 GitHub CLI，先装上并 `gh auth login`',
      }
    }
    if (remote === null) {
      return {
        gh, remote, repo: null, ready: false, reason: 'no-remote',
        detail: '这个仓库没有配置远端，推不上去，也就开不了 PR',
      }
    }
    const found = await this.github.slug(repoPath, remote)
    if (!found.ok) return { gh, remote, repo: null, ready: false, reason: found.reason, detail: found.detail }
    return { gh, remote, repo: `${found.slug.owner}/${found.slug.name}`, ready: true }
  }

  /**
   * 「通过并合并」的实际动作：提交 → 跟上基线 → 推上去 → 开 PR。
   *
   * **不把卡搬进 Done**。PR 开出来只说明改动到了该被评审的地方，合不合是
   * GitHub 上那颗按钮说了算 —— 我们只负责在它真的合上之后（见
   * {@link syncPullRequests}）把卡收进 Done。自己先搬过去，等于替用户
   * 宣布一件还没发生的事。
   *
   * 冲突在**自己的工作区里**提前引爆：先把基线合进任务分支，冲突就落在
   * 这张卡自己的 worktree 上，交给下一轮 Agent 去解（卡自动回队列）。
   * 等推上去让 GitHub 报冲突就晚了 —— 那时既没人能在网页上解，也没有
   * 一个能接着干的工作区。
   *
   * @param taskId - 目标任务。
   */
  async openPullRequest(taskId: TaskId): Promise<
    ReviewSuccess<{ pr: TaskPullRequest; created: boolean; commit: string | null }>
    | (ReviewFailure & { readonly files?: readonly string[]; readonly requeued?: boolean })
  > {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null) return { ok: false, reason: 'task-not-found', detail: String(taskId) }
    if (task.archivedAt !== undefined) {
      return { ok: false, reason: 'task-archived', detail: '这张卡已归档。要动它先取消归档' }
    }
    if (task.column !== 'review') {
      return { ok: false, reason: 'illegal-transition', detail: `只有 review 列的任务可以开 PR，当前在 ${task.column}` }
    }
    const run = this.latestRun(taskId)
    if (run === null) return { ok: false, reason: 'no-run', detail: '这张卡没有执行记录' }

    const worktree = this.worktreeOf(run)
    if (!(await access(worktree.path).then(() => true, () => false))) {
      return {
        ok: false,
        reason: 'no-worktree',
        detail: '这次执行没留下工作区，没有东西可提交 —— 打回重跑或废弃',
      }
    }

    // 能力先探：gh 没装、没远端、远端不是 GitHub —— 这三种情况下面每一步
    // 都会白做，而 commitAll 是有副作用的。
    const capable = await this.pullRequestCapability(task.repoPath)
    if (!capable.ready || capable.remote === null) {
      return { ok: false, reason: capable.reason ?? 'no-remote', detail: capable.detail ?? '开不了 PR' }
    }
    const found = await this.github.slug(task.repoPath, capable.remote)
    if (!found.ok) return { ok: false, reason: found.reason, detail: found.detail }

    // ── 1. 先把这一轮的改动提交下来 ────────────────────────
    // 上一轮的冲突没解完就停在这儿：**卡不回队列**（它本来就还在 Review），
    // 所以 `requeued` 明确给 false —— 界面据此说"卡还在这儿"，而不是
    // 反过来告诉人"已经回队列了"。
    const stuck = await this.conflictRefusal(worktree)
    if (stuck !== null) return { ...stuck, requeued: false }

    const commit = await commitAll(worktree, commitMessage(task, run))

    // ── 2. 跟上基线，冲突提前在自己家里发生 ─────────────────
    const fetched = await fetchBranch(task.repoPath, capable.remote, task.baseBranch)
    // 远端还没有这条基线（第一次推的仓库）不算失败，退回本地那条。
    const baseRef = fetched.ok ? `${capable.remote}/${task.baseBranch}` : task.baseBranch
    const synced = await mergeIntoBranch(worktree, baseRef)
    if (!synced.ok) {
      if (synced.reason !== 'merge-conflict') {
        return { ok: false, reason: synced.reason, detail: synced.detail }
      }
      // 冲突原样留在工作区里 —— 那正是下一轮要解的东西。卡回队列，
      // 讨论里留一条说清楚要干什么；解冲突同样是"改文件"，提交仍归我们。
      const requeued = this.requeueForConflict(task, baseRef, synced.files ?? [])
      return {
        ok: false,
        reason: 'merge-conflict',
        detail: synced.detail,
        ...(synced.files === undefined ? {} : { files: synced.files }),
        requeued,
      }
    }

    // ── 3. 推上去、开 PR ───────────────────────────────────
    const pushed = await pushBranch(worktree, capable.remote)
    if (!pushed.ok) return { ok: false, reason: pushed.reason, detail: pushed.detail }

    const opened = await this.github.create(task.repoPath, found.slug, {
      head: worktree.branch,
      base: task.baseBranch,
      title: taskTitle(task),
      body: pullRequestBody(task, run),
    })
    if (!opened.ok) return { ok: false, reason: opened.reason, detail: opened.detail }

    const record = this.recordPullRequest(task, worktree.branch, opened.pr)
    return { ok: true, pr: record, created: opened.created, commit }
  }

  /**
   * 工作区里还有没解开的冲突时，给出一条能读的拒绝。
   *
   * `commitAll` 自己也会挡（它是最后一道），但那是抛异常 —— 到了 HTTP 那层
   * 只剩一句"服务端出错"。这里提前判一次，让调用方拿到 `merge-conflict`
   * 与具体是哪几个文件。
   *
   * @param worktree - 目标工作区。
   * @returns 该拒绝时的失败值；没有冲突则 null。
   */
  private async conflictRefusal(
    worktree: Worktree,
  ): Promise<(ReviewFailure & { readonly files?: readonly string[] }) | null> {
    const files = await unresolvedConflicts(worktree.path).catch(() => [])
    if (files.length === 0) return null
    return {
      ok: false,
      reason: 'merge-conflict',
      detail: `工作区里还有没解开的冲突：${files.join('、')}`,
      files,
    }
  }

  /**
   * 问一遍 GitHub：那些还开着的 PR 现在怎么样了；合上的把卡收进 Done。
   *
   * 这是"合并成功后自动归集到 Done"的唯一实现处。**只认 GitHub 的说法** ——
   * 本地没法知道网页上那颗按钮什么时候被按，猜一个只会把没合上的卡收走。
   *
   * 全程尽力而为：某一条查不动（网断了、没权限）就跳过它，下一轮再说；
   * 一条的失败不该让其余的都停在那儿。
   *
   * @param taskId - 只查这张卡；不给则查全部还开着的。
   */
  async syncPullRequests(taskId?: TaskId): Promise<{
    updated: TaskPullRequest[]
    /** 这一轮因为 PR 合上而进 Done 的卡。 */
    collected: TaskId[]
  }> {
    const { storage } = this.options
    if (!this.github.available()) return { updated: [], collected: [] }

    const open = taskId === undefined
      ? storage.listOpenPullRequests()
      : storage.listPullRequests(taskId).filter((pr) => pr.state === 'open')

    const updated: TaskPullRequest[] = []
    const collected: TaskId[] = []
    // 同一个仓库只认一次远端：一次 sync 里可能有十几条 PR 都来自同一个项目。
    const slugs = new Map<string, RepoSlug | null>()

    for (const pr of open) {
      // 逐条兜住：`gh` 是在 `task.repoPath` 里跑的，那个目录被搬走或删掉时
      // spawn 直接抛 —— 不接住的话，一个已经不在的项目会把这一轮里其余
      // 项目的 PR 全带走，而它们的卡就再也等不到"合上了，收进 Done"。
      try {
        await this.syncOne(pr, slugs, updated, collected)
      } catch {
        // 下一轮再说。这里连日志都不打：一个不在的仓库每分钟刷一屏没有意义。
      }
    }
    return { updated, collected }
  }

  /**
   * 刷新一条 PR 的状态，必要时把卡收进 Done。
   *
   * @param pr - 库里那条记录。
   * @param slugs - 仓库路径 → GitHub 仓库的缓存；一次 sync 里同一个项目只认一次。
   * @param updated - 刷新成功的记录都塞进这里。
   * @param collected - 因此进 Done 的卡都塞进这里。
   */
  private async syncOne(
    pr: TaskPullRequest,
    slugs: Map<string, RepoSlug | null>,
    updated: TaskPullRequest[],
    collected: TaskId[],
  ): Promise<void> {
    const { storage } = this.options
    const task = storage.getTask(pr.taskId)
    if (task === null) return

    let slug = slugs.get(task.repoPath)
    if (slug === undefined) {
      const remote = await defaultRemote(task.repoPath).catch(() => null)
      const found = remote === null ? null : await this.github.slug(task.repoPath, remote)
      slug = found !== null && found.ok ? found.slug : null
      slugs.set(task.repoPath, slug)
    }
    if (slug === null) return

    const view = await this.github.view(task.repoPath, slug, String(pr.number))
    if (!view.ok || view.pr === null) return

    const next: TaskPullRequest = {
      ...pr,
      url: view.pr.url,
      state: view.pr.state,
      mergeable: view.pr.mergeable,
      ...(view.pr.mergedAt === undefined ? {} : { mergedAt: view.pr.mergedAt }),
      updatedAt: this.now,
    }
    storage.upsertPullRequest(next)
    updated.push(next)

    if (next.state === 'merged' && await this.collect(pr.taskId)) collected.push(pr.taskId)
  }

  /**
   * PR 合上了，把卡收进 Done。
   *
   * 只搬 review 里的卡：合并期间人可能已经在讨论里说了下一轮（卡回了
   * ready），或者它已经在跑第二轮了 —— 那时把它拽进 Done 会把正在进行的
   * 一轮活生生截断。这不是失败，只是这条 PR 的合并不再对应一次收尾。
   *
   * @param taskId - 目标任务。
   * @returns 是否真的搬了。
   */
  private async collect(taskId: TaskId): Promise<boolean> {
    const { storage } = this.options
    const task = storage.getTask(taskId)
    if (task === null || task.column !== 'review') return false

    const moved = moveTask(task, { expectedRevision: task.revision, to: 'done', now: this.now })
    if (!moved.ok || !storage.commitTask(moved.value)) return false

    // 收拾场地：**保留分支**（PR 记录指着它，日后要查得到），只把工作目录
    // 收掉。下一轮真要接着干，ensureWorktree 会拿这条分支重新挂一个出来。
    const run = this.latestRun(taskId)
    if (run !== null) {
      await removeWorktree(task.repoPath, this.worktreeOf(run), true).catch(() => undefined)
    }
    return true
  }

  /** 把 gh 查到的那条 PR 记进库里（幂等，同一条 PR 只有一行）。 */
  private recordPullRequest(task: Task, branch: string, view: PullRequestView): TaskPullRequest {
    const { storage } = this.options
    const existing = storage.listPullRequests(task.id).find((pr) => pr.number === view.number)
    const record: TaskPullRequest = {
      id: existing?.id ?? `pr-${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      number: view.number,
      url: view.url,
      branch,
      baseBranch: task.baseBranch,
      state: view.state,
      mergeable: view.mergeable,
      ...(view.mergedAt === undefined ? {} : { mergedAt: view.mergedAt }),
      createdAt: existing?.createdAt ?? this.now,
      updatedAt: this.now,
    }
    storage.upsertPullRequest(record)
    return record
  }

  /**
   * 冲突了：在讨论里说清楚，然后把卡送回队列去解。
   *
   * 走讨论而不是别的通道，是因为下一次执行本来就带着整条讨论 —— 这条话
   * 会原样出现在 Agent 的 TASK.md 与 prompt 里，它照着做就是了。
   *
   * @returns 卡有没有真的回到队列。没回去（被人同时改过）时，冲突仍在
   *   工作区里等着，用户看得到那条留言。
   */
  private requeueForConflict(task: Task, baseRef: string, files: readonly string[]): boolean {
    const { storage } = this.options
    storage.addComment({
      id: `c-${randomUUID().slice(0, 8)}`,
      taskId: task.id,
      author: 'human',
      body: [
        `把 \`${baseRef}\` 合进这条分支时有冲突，工作区现在停在这次合并中间。`,
        '',
        '冲突文件：',
        ...files.map((file) => `- \`${file}\``),
        '',
        '请逐个解开：去掉 `<<<<<<<` / `=======` / `>>>>>>>` 这些标记，'
        + '保留两边都该留下的东西 —— 基线那边的改动是别人已经合进主干的，不能丢。',
        '解完把结果留在工作区就行，**不要提交、不要 `git merge --abort`**：提交由看板来做。',
      ].join('\n'),
      at: this.now,
    })
    const moved = moveTask(task, { expectedRevision: task.revision, to: 'ready', now: this.now })
    return moved.ok && storage.commitTask(moved.value)
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
    await rm(worktreeDir(task.repoPath, task.id), { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * PR 正文：需求原文 + 验收标准 + 是谁干的。
 *
 * 抄的是卡片本身而不是 diff 的摘要 —— 评审的人要判的是"这次改动是不是把
 * 那件事做成了"，而那件事只写在卡上。
 */
function pullRequestBody(task: Task, run: Run): string {
  const lines = [task.description.trim(), '']
  if (task.acceptance.length > 0) {
    lines.push('## 验收标准', '')
    for (const item of task.acceptance) lines.push(`- [ ] ${item}`)
    lines.push('')
  }
  lines.push('---', '', `LoopKanban 卡片 \`${String(task.id)}\` · ${run.provider} ${run.cliVersion}`)
  return lines.join('\n')
}

/** 提交信息带上执行者，日后 blame 时看得出这段是谁写的。 */
function commitMessage(task: Task, run: Run): string {
  return [taskTitle(task), '', `Task: ${task.id}`, `Agent: ${run.provider} ${run.cliVersion}`].join('\n')
}
