/**
 * 存储层：任务与 Run 的持久化，以及 append-only 的事件日志。
 *
 * 两条不可动摇的规则：
 *
 * 1. **任务的每次写入都是 compare-and-set**。`commitTask` 只在数据库里的
 *    revision 等于「新值 revision - 1」时才落库，否则返回 false。领域层算出
 *    的新值 + 这一层的 CAS，合起来才真正挡住「两个调度器同时认领同一张卡」。
 * 2. **`run_events` 只插不改不删**。UI 从它投影，SSE 断线用 seq 续传，
 *    进程重启后回放即可完整重建界面。
 */

import { DatabaseSync } from 'node:sqlite'
import type { Column, Lease, ProjectId, RunId, Task, TaskId } from '@loopkanban/core'
import { asProjectId, asRunId, asTaskId } from '@loopkanban/core'
import { migrate } from './schema.ts'

/** 一个项目：一个 git 仓库目录 + 一条基线分支。任务挂在它下面。 */
export interface Project {
  readonly id: ProjectId
  readonly name: string
  readonly repoPath: string
  readonly baseBranch: string
  /**
   * 一键测试环境的启动命令，例如 `pnpm install && pnpm dev`。
   *
   * 缺席表示没配 —— 那个按钮会引导人填一条，而不是猜一条替他跑。猜错的代价
   * 是在他的仓库里跑了一条他没写过的命令，这个工具不做这种事。
   *
   * 命令里可以写 `{{port}}`；host 分配的端口会替换进去，也会以 `PORT`
   * 环境变量给到进程。
   */
  readonly testCommand?: string | undefined
  readonly createdAt: number
}

/**
 * 讨论里的一条留言。
 *
 * 人和 Agent 的往来都记在这儿，按时间顺序就是这张卡的完整上下文 ——
 * 下一次执行会把整条线程交给 Agent，所以它不只是给人看的记录。
 */
export interface TaskComment {
  readonly id: string
  readonly taskId: TaskId
  readonly author: 'human' | 'agent'
  readonly body: string
  /** Agent 的回答出自哪次执行；人写的留言没有。 */
  readonly runId?: RunId | undefined
  readonly at: number
}

/**
 * 卡片带着的一个附件：图片、PDF、Word 文档之类。
 *
 * 库里只有元数据，字节在 `path` 指的文件里（见 `AttachmentStore`）。
 * 派活时它们会被拷进 worktree，并列进 TASK.md 交给 Agent。
 */
export interface Attachment {
  readonly id: string
  readonly taskId: TaskId
  /** 用户原来的文件名，界面上显示、写进 TASK.md 的都是它。 */
  readonly filename: string
  readonly mime: string
  readonly size: number
  /** 字节在磁盘上的绝对路径。 */
  readonly path: string
  /**
   * 挂在讨论的哪条留言上。三态，缺一不可：
   *
   * - `undefined` —— 规格附件，需求的一部分；
   * - `DRAFT_COMMENT`（空串）—— 讨论里传上来了、那条留言还没发出去；
   * - 其它 —— 那条留言带的文件。
   */
  readonly commentId?: string | undefined
  readonly at: number
}

/**
 * 草稿附件的 `commentId`：已经落盘、但还没跟着任何一条留言发出去。
 *
 * 之所以有这个中间态：文件是**选完就传**的（传上去了却因为没点发送而丢掉，
 * 是最让人恼火的那种意外），而留言的 id 要等它真发出去才存在。
 */
export const DRAFT_COMMENT = ''

/**
 * 一条从卡片开出去的 Pull Request（的**投影**）。
 *
 * 真相在 GitHub 上，这里存的是最后一次问到的状态：界面照着它渲染，
 * "合上了没有、要不要把卡收进 Done"也照着它判。一张卡可以有多条 ——
 * Done 里再说一句就是下一轮，那一轮会开出另一条。
 */
export interface TaskPullRequest {
  readonly id: string
  readonly taskId: TaskId
  readonly number: number
  readonly url: string
  /** 开这条 PR 时的任务分支。卡片标题改过之后分支名会变，所以要记当时那个。 */
  readonly branch: string
  readonly baseBranch: string
  readonly state: 'open' | 'merged' | 'closed'
  readonly mergeable: 'mergeable' | 'conflicting' | 'unknown'
  readonly mergedAt?: number | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface Run {
  readonly id: RunId
  readonly taskId: TaskId
  readonly provider: string
  readonly cliVersion: string
  readonly agentSessionId?: string | undefined
  readonly worktreePath: string
  readonly branch: string
  readonly status: RunStatus
  readonly exitCode?: number | undefined
  readonly diagnostic?: string | undefined
  readonly startedAt: number
  readonly endedAt?: number | undefined
}

export interface ProviderStats {
  readonly provider: string
  readonly total: number
  readonly completed: number
  readonly failed: number
  /** 中位耗时（毫秒）；没有已结束的 Run 时为 null。 */
  readonly medianMs: number | null
}

export interface RunStats {
  readonly totalRuns: number
  readonly completed: number
  readonly failed: number
  readonly running: number
  readonly costUsd: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly providers: readonly ProviderStats[]
}

export interface RunEvent {
  readonly runId: RunId
  readonly seq: number
  readonly kind: string
  readonly payload: unknown
  readonly at: number
}

interface TaskRow {
  id: string
  project_id: string
  revision: number
  column_name: string
  position: number
  description: string
  acceptance_json: string
  repo_path: string
  base_branch: string
  preferred_provider: string | null
  model: string | null
  blocked_by_json: string
  related_json: string
  lease_json: string | null
  archived_at: number | null
  done_at: number | null
  created_at: number
  updated_at: number
}

interface AttachmentRow {
  id: string
  task_id: string
  filename: string
  mime: string
  size: number
  path: string
  comment_id: string | null
  at: number
}

interface RunRow {
  id: string
  task_id: string
  provider: string
  cli_version: string
  agent_session_id: string | null
  worktree_path: string
  branch: string
  status: string
  exit_code: number | null
  diagnostic: string | null
  started_at: number
  ended_at: number | null
}

function toTask(row: TaskRow): Task {
  const preferred = row.preferred_provider
  const lease = row.lease_json === null ? undefined : (JSON.parse(row.lease_json) as Lease)
  return {
    id: asTaskId(row.id),
    projectId: asProjectId(row.project_id),
    revision: row.revision,
    column: row.column_name as Column,
    position: row.position,
    description: row.description,
    acceptance: JSON.parse(row.acceptance_json) as string[],
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    ...(preferred === null ? {} : { preferredProvider: preferred }),
    ...(row.model === null ? {} : { model: row.model }),
    blockedBy: (JSON.parse(row.blocked_by_json) as string[]).map(asTaskId),
    relatedTo: (JSON.parse(row.related_json) as string[]).map(asTaskId),
    ...(lease === undefined ? {} : { lease }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.done_at === null ? {} : { doneAt: row.done_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    taskId: asTaskId(row.task_id),
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    path: row.path,
    // NULL 与空串是两回事：前者是规格附件，后者是还没发出去的草稿。
    ...(row.comment_id === null ? {} : { commentId: row.comment_id }),
    at: row.at,
  }
}

interface PullRequestRow {
  id: string
  task_id: string
  number: number
  url: string
  branch: string
  base_branch: string
  state: string
  mergeable: string
  merged_at: number | null
  created_at: number
  updated_at: number
}

function toPullRequest(row: PullRequestRow): TaskPullRequest {
  const state = row.state === 'merged' ? 'merged' : row.state === 'closed' ? 'closed' : 'open'
  const mergeable = row.mergeable === 'mergeable' ? 'mergeable'
    : row.mergeable === 'conflicting' ? 'conflicting'
    : 'unknown'
  return {
    id: row.id,
    taskId: asTaskId(row.task_id),
    number: row.number,
    url: row.url,
    branch: row.branch,
    baseBranch: row.base_branch,
    state,
    mergeable,
    ...(row.merged_at === null ? {} : { mergedAt: row.merged_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRun(row: RunRow): Run {
  return {
    id: asRunId(row.id),
    taskId: asTaskId(row.task_id),
    provider: row.provider,
    cliVersion: row.cli_version,
    agentSessionId: row.agent_session_id ?? undefined,
    worktreePath: row.worktree_path,
    branch: row.branch,
    status: row.status as RunStatus,
    exitCode: row.exit_code ?? undefined,
    diagnostic: row.diagnostic ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  }
}

export class Storage {
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * 打开（必要时创建）数据库并补齐迁移。
   * @param path - 数据库文件路径；`':memory:'` 用于测试。
   */
  static open(path: string): Storage {
    const db = new DatabaseSync(path)
    migrate(db)
    return new Storage(db)
  }

  close(): void {
    this.db.close()
  }

  // ── Project ────────────────────────────────────────────────────

  createProject(project: Project): void {
    this.db.prepare(
      'INSERT INTO projects (id, name, repo_path, base_branch, test_command, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      project.id, project.name, project.repoPath, project.baseBranch,
      project.testCommand ?? null, project.createdAt,
    )
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as {
      id: string; name: string; repo_path: string; base_branch: string
      test_command: string | null; created_at: number
    }[]
    return rows.map((row) => ({
      id: asProjectId(row.id),
      name: row.name,
      repoPath: row.repo_path,
      baseBranch: row.base_branch,
      // 空串与 NULL 都当没配：清空是把输入框留白，那一路存下来的是空串。
      ...(row.test_command === null || row.test_command.trim() === ''
        ? {}
        : { testCommand: row.test_command }),
      createdAt: row.created_at,
    }))
  }

  getProject(id: ProjectId): Project | null {
    return this.listProjects().find((project) => project.id === id) ?? null
  }

  /**
   * 改项目的名字或基线分支。
   *
   * **仓库路径不在其列** —— 那是项目的身份，换了仓库就是另一个项目。基线
   * 分支可以改：它是一个当初猜出来的默认值，猜错了不该只能靠删掉重建来纠正。
   * 改动只影响此后新建的卡；已经建出来的卡各自记着自己的基线，不动它们，
   * 否则它们的 diff 与合并目标会在脚下悄悄换掉。
   *
   * 启动命令也在其列，且**允许清空**：配错了要能退回"没配"的状态，而不是
   * 只能塞一条 `true` 进去凑数。传 `null` 或空串就是清空。
   *
   * @param id - 目标项目。
   * @param patch - 要改的字段；给空对象等于什么都不改。
   * @returns 是否改到了；false 表示这个项目不在。
   */
  updateProject(
    id: ProjectId,
    patch: { name?: string; baseBranch?: string; testCommand?: string | null },
  ): boolean {
    const sets: string[] = []
    const values: (string | null)[] = []
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name) }
    if (patch.baseBranch !== undefined) { sets.push('base_branch = ?'); values.push(patch.baseBranch) }
    if (patch.testCommand !== undefined) {
      sets.push('test_command = ?')
      const command = patch.testCommand?.trim() ?? ''
      values.push(command.length === 0 ? null : command)
    }
    if (sets.length === 0) return this.getProject(id) !== null
    return this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id).changes === 1
  }

  /**
   * 删除项目，连同它名下所有卡片与执行历史。
   *
   * 同 `deleteTask`，这是 `run_events` 只插不改不删的另一处例外：整个项目都
   * 没了，留着一串指向空 taskId 的事件只是垃圾，外键也不允许它们留着。
   *
   * **不碰仓库本身**。删的只是 LoopKanban 记的账；仓库里那些 worktree 与
   * 分支由调用方（Review.purge）收拾，也只收拾我们自己建的那些。
   *
   * 整件事在一个事务里：要么全成、要么全不动。
   *
   * @param id - 要删的项目。
   * @returns 是否删掉了；false 表示这个项目本来就不在。
   */
  deleteProject(id: ProjectId): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 顺序是外键定的：事件 → Run → 卡片 → 项目。
      this.db.prepare(`
        DELETE FROM run_events WHERE run_id IN (
          SELECT id FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
        )
      `).run(id)
      this.db.prepare('DELETE FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id)
      this.db.prepare('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id)
      this.db.prepare('DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id)
      this.db.prepare('DELETE FROM task_prs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id)
      this.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id)
      const removed = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      if (removed.changes !== 1) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── 讨论 ───────────────────────────────────────────────────────

  addComment(comment: TaskComment): void {
    this.db.prepare(
      'INSERT INTO task_comments (id, task_id, author, body, run_id, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(comment.id, comment.taskId, comment.author, comment.body, comment.runId ?? null, comment.at)
  }

  /** 一张卡的讨论，按时间正序 —— 它同时也是交给 Agent 的上下文顺序。 */
  listComments(taskId: TaskId): TaskComment[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_comments WHERE task_id = ? ORDER BY at, id',
    ).all(taskId) as unknown as {
      id: string; task_id: string; author: string; body: string; run_id: string | null; at: number
    }[]
    return rows.map((row) => ({
      id: row.id,
      taskId: asTaskId(row.task_id),
      author: row.author === 'agent' ? 'agent' : 'human',
      body: row.body,
      ...(row.run_id === null ? {} : { runId: asRunId(row.run_id) }),
      at: row.at,
    }))
  }

  // ── 附件 ───────────────────────────────────────────────────────

  addAttachment(attachment: Attachment): void {
    this.db.prepare(
      'INSERT INTO task_attachments (id, task_id, filename, mime, size, path, comment_id, at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      attachment.id, attachment.taskId, attachment.filename,
      attachment.mime, attachment.size, attachment.path,
      attachment.commentId ?? null, attachment.at,
    )
  }

  /**
   * 一张卡的**规格附件**，按上传顺序 —— TASK.md 里的清单也照这个顺序排。
   *
   * 讨论里带的文件不在其中：它们属于某一条留言，跟着那句话一起读才有意义，
   * 混进规格清单只会让「需求是什么」越读越糊。要它们走 `listCommentAttachments`。
   */
  listAttachments(taskId: TaskId): Attachment[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_attachments WHERE task_id = ? AND comment_id IS NULL ORDER BY at, id',
    ).all(taskId) as unknown as AttachmentRow[]
    return rows.map(toAttachment)
  }

  /** 一张卡的讨论里**已经发出去**的附件，按上传顺序。 */
  listCommentAttachments(taskId: TaskId): Attachment[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_attachments WHERE task_id = ? AND comment_id IS NOT NULL AND comment_id <> \'\''
      + ' ORDER BY at, id',
    ).all(taskId) as unknown as AttachmentRow[]
    return rows.map(toAttachment)
  }

  /**
   * 讨论里传上来、还没跟着留言发出去的那些。
   *
   * 界面重新打开时要拿它把草稿摆回去 —— 文件已经在服务器上了，不摆出来
   * 人只会以为传丢了，然后再传一遍。
   */
  listDraftAttachments(taskId: TaskId): Attachment[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_attachments WHERE task_id = ? AND comment_id = \'\' ORDER BY at, id',
    ).all(taskId) as unknown as AttachmentRow[]
    return rows.map(toAttachment)
  }

  /**
   * 把几个草稿附件认领给一条刚发出去的留言。
   *
   * **只认这张卡自己的草稿**：条件里的 `comment_id = ''` 同时挡住了"把别人
   * 留言上的附件搬过来"和"重复认领"，所以这一句本身就是幂等的。
   *
   * @param taskId - 附件必须属于这张卡。
   * @param ids - 要认领的附件 id。
   * @param commentId - 认领到哪条留言。
   * @returns 真正认领到的条数；期间被删掉的那些自然不在其中。
   */
  attachToComment(taskId: TaskId, ids: readonly string[], commentId: string): number {
    if (ids.length === 0) return 0
    const holes = ids.map(() => '?').join(', ')
    return Number(this.db.prepare(
      `UPDATE task_attachments SET comment_id = ? WHERE task_id = ? AND comment_id = '' AND id IN (${holes})`,
    ).run(commentId, taskId, ...ids).changes)
  }

  /**
   * 一个项目下所有卡片的附件。删项目时要拿它去收拾磁盘上的文件 ——
   * 库里的记录被外键连带删掉了，字节可不会自己消失。
   */
  listProjectAttachments(projectId: ProjectId): Attachment[] {
    const rows = this.db.prepare(`
      SELECT a.* FROM task_attachments a
      JOIN tasks t ON t.id = a.task_id
      WHERE t.project_id = ?
    `).all(projectId) as unknown as AttachmentRow[]
    return rows.map(toAttachment)
  }

  getAttachment(id: string): Attachment | null {
    const row = this.db.prepare('SELECT * FROM task_attachments WHERE id = ?').get(id) as unknown as
      AttachmentRow | undefined
    return row === undefined ? null : toAttachment(row)
  }

  /**
   * 删掉一条附件记录。**字节由调用方另行删除** —— 这一层只管库，
   * 磁盘归 `AttachmentStore`，两者的失败方式不一样，混在一起只会让
   * "库里没了、文件还在"更难查。
   *
   * @returns 是否删到了；false 表示这条记录本来就不在。
   */
  deleteAttachment(id: string): boolean {
    return this.db.prepare('DELETE FROM task_attachments WHERE id = ?').run(id).changes === 1
  }

  // ── Pull Request ───────────────────────────────────────────────

  /**
   * 记下（或刷新）一条 PR 的状态。
   *
   * 按 `(task_id, number)` 幂等：同一条 PR 被查到多少次都只有一行，每次
   * 覆盖成最新的状态。**`created_at` 不覆盖** —— 那是"这条 PR 什么时候
   * 进入看板视野"的时间，刷新一次就把它推到现在，历史顺序就乱了。
   *
   * @param pr - 最新的投影值。
   */
  upsertPullRequest(pr: TaskPullRequest): void {
    this.db.prepare(`
      INSERT INTO task_prs (
        id, task_id, number, url, branch, base_branch, state, mergeable, merged_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, number) DO UPDATE SET
        url = excluded.url,
        branch = excluded.branch,
        base_branch = excluded.base_branch,
        state = excluded.state,
        mergeable = excluded.mergeable,
        merged_at = excluded.merged_at,
        updated_at = excluded.updated_at
    `).run(
      pr.id, pr.taskId, pr.number, pr.url, pr.branch, pr.baseBranch,
      pr.state, pr.mergeable, pr.mergedAt ?? null, pr.createdAt, pr.updatedAt,
    )
  }

  /** 一张卡的 PR，新的排在前面 —— 最近那一轮才是人此刻要看的。 */
  listPullRequests(taskId: TaskId): TaskPullRequest[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_prs WHERE task_id = ? ORDER BY number DESC',
    ).all(taskId) as unknown as PullRequestRow[]
    return rows.map(toPullRequest)
  }

  /** 全部 PR。看板要在卡面上标出"这张卡合过几条"，一次读完比一张卡问一次划算。 */
  listAllPullRequests(): TaskPullRequest[] {
    const rows = this.db.prepare('SELECT * FROM task_prs ORDER BY task_id, number DESC')
      .all() as unknown as PullRequestRow[]
    return rows.map(toPullRequest)
  }

  /** 还没有终态的 PR。后台那轮"合上了没有"的巡检只需要问这些。 */
  listOpenPullRequests(): TaskPullRequest[] {
    const rows = this.db.prepare("SELECT * FROM task_prs WHERE state = 'open' ORDER BY task_id, number")
      .all() as unknown as PullRequestRow[]
    return rows.map(toPullRequest)
  }

  // ── Task ───────────────────────────────────────────────────────

  createTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (
        id, project_id, revision, column_name, position, description,
        acceptance_json, repo_path, base_branch, preferred_provider, model,
        blocked_by_json, related_json, lease_json, archived_at, done_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.projectId, task.revision, task.column, task.position,
      task.description, JSON.stringify(task.acceptance),
      task.repoPath, task.baseBranch, task.preferredProvider ?? null, task.model ?? null,
      JSON.stringify(task.blockedBy), JSON.stringify(task.relatedTo),
      task.lease === undefined ? null : JSON.stringify(task.lease),
      task.archivedAt ?? null, task.doneAt ?? null,
      task.createdAt, task.updatedAt,
    )
  }

  getTask(id: TaskId): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined
    return row === undefined ? null : toTask(row)
  }

  listTasks(projectId?: ProjectId): Task[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM tasks ORDER BY position').all()
      : this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position').all(projectId)
    return (rows as unknown as TaskRow[]).map(toTask)
  }

  /**
   * compare-and-set 写入任务。
   *
   * 领域函数产出的 `next` 已经把 revision 加过一，所以这里比对的是
   * `next.revision - 1`。**并发下的正确性最终落在这一条 SQL 上**：
   * 两个调度器同时提交，只有一个能命中。
   *
   * @param next - 领域函数算出的新任务值。
   * @returns 是否写入成功；false 表示期间已被他人改动，调用方应重读后重试。
   */
  commitTask(next: Task): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET
        revision = ?, column_name = ?, position = ?, description = ?,
        acceptance_json = ?, repo_path = ?, base_branch = ?, preferred_provider = ?, model = ?,
        blocked_by_json = ?, related_json = ?, lease_json = ?,
        archived_at = ?, done_at = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      next.revision, next.column, next.position, next.description,
      JSON.stringify(next.acceptance), next.repoPath, next.baseBranch,
      next.preferredProvider ?? null, next.model ?? null,
      JSON.stringify(next.blockedBy), JSON.stringify(next.relatedTo),
      next.lease === undefined ? null : JSON.stringify(next.lease),
      next.archivedAt ?? null, next.doneAt ?? null,
      next.updatedAt,
      next.id, next.revision - 1,
    )
    return result.changes === 1
  }

  /**
   * 删除任务，连同它的执行历史。
   *
   * **这是 `run_events` 只插不改不删的唯一例外**，而且不违反那条规则的用意：
   * append-only 保的是"一次执行的过程不会被事后改写"，这里删掉的是整张卡 ——
   * 连 Run 本身都不存在了，留着一串指向空 taskId 的事件只是垃圾。外键也不
   * 允许它们留着。
   *
   * 整件事在一个事务里：卡片、Run、事件、以及下游摘掉依赖后的新值，要么
   * 全成、要么全不动。中途失败留下"卡没了但依赖还悬着"是最糟的结果。
   *
   * @param id - 要删的任务。
   * @param expectedRevision - 调用方读到的 revision，CAS 凭据。
   * @param cascade - 摘掉指向它的引用之后，那些卡的新值（见 `dropReferences`）。
   * @returns 是否删成功；false 表示期间已被他人改动，调用方应重读后重试。
   */
  deleteTask(id: TaskId, expectedRevision: number, cascade: readonly Task[] = []): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 顺序是外键定的：事件 → Run → 卡片。反过来第一步就会被 runs 的引用挡住。
      this.db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(id)
      this.db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(id)
      this.db.prepare('DELETE FROM task_prs WHERE task_id = ?').run(id)
      this.db.prepare('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)').run(id)
      this.db.prepare('DELETE FROM runs WHERE task_id = ?').run(id)
      const removed = this.db.prepare('DELETE FROM tasks WHERE id = ? AND revision = ?').run(id, expectedRevision)
      if (removed.changes !== 1) {
        this.db.exec('ROLLBACK')
        return false
      }
      for (const next of cascade) {
        // 下游也走 CAS：它们同样可能刚被别人改过。
        if (!this.commitTask(next)) {
          this.db.exec('ROLLBACK')
          return false
        }
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ── Run ────────────────────────────────────────────────────────

  createRun(run: Run): void {
    this.db.prepare(`
      INSERT INTO runs (
        id, task_id, provider, cli_version, agent_session_id,
        worktree_path, branch, status, exit_code, diagnostic, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.taskId, run.provider, run.cliVersion, run.agentSessionId ?? null,
      run.worktreePath, run.branch, run.status, run.exitCode ?? null,
      run.diagnostic ?? null, run.startedAt, run.endedAt ?? null,
    )
  }

  updateRun(run: Run): void {
    this.db.prepare(`
      UPDATE runs SET agent_session_id = ?, status = ?, exit_code = ?, diagnostic = ?, ended_at = ?
      WHERE id = ?
    `).run(
      run.agentSessionId ?? null, run.status, run.exitCode ?? null,
      run.diagnostic ?? null, run.endedAt ?? null, run.id,
    )
  }

  getRun(id: RunId): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined
    return row === undefined ? null : toRun(row)
  }

  listRuns(taskId: TaskId): Run[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId)
    return (rows as unknown as RunRow[]).map(toRun)
  }

  /**
   * 每张卡最近一次执行，没跑过的卡不在里面。
   *
   * 看板要一眼看出哪张卡「这一轮跑挂了」，而它每几秒就刷一遍 —— 逐张卡
   * 查一次是几十次往返，所以一条 SQL 把最新的那批一起端回来。
   *
   * started_at 撞车时两条都会回来，后写进 Map 的那条胜出 —— 同一毫秒起的
   * 两次执行本来就分不出先后，随便哪条都是"最近一次"。
   */
  latestRuns(): Map<TaskId, Run> {
    const rows = this.db.prepare(`
      SELECT r.* FROM runs r
      JOIN (SELECT task_id, MAX(started_at) AS at FROM runs GROUP BY task_id) latest
        ON latest.task_id = r.task_id AND latest.at = r.started_at
    `).all() as unknown as RunRow[]
    const byTask = new Map<TaskId, Run>()
    for (const row of rows) byTask.set(asTaskId(row.task_id), toRun(row))
    return byTask
  }

  /** 启动时对账用：上次进程崩溃时留下的、状态仍是 running 的 Run。 */
  listOrphanRuns(): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all()
    return (rows as unknown as RunRow[]).map(toRun)
  }

  // ── 统计 ───────────────────────────────────────────────────────

  /**
   * 汇总执行数据。
   *
   * 用量与成本从 `run_events` 里的 `usage` 事件现算，而不是在 runs 表上加列：
   * 事件日志本来就是真相，多一份冗余就多一处会不一致的地方。本地工具的数据量
   * 也撑得住。
   */
  stats(): RunStats {
    const runs = this.db.prepare(
      "SELECT provider, status, started_at, ended_at FROM runs",
    ).all() as unknown as { provider: string; status: string; started_at: number; ended_at: number | null }[]

    const usage = this.db.prepare(
      "SELECT run_id, payload_json FROM run_events WHERE kind = 'usage'",
    ).all() as unknown as { run_id: string; payload_json: string }[]

    let costUsd = 0
    let inputTokens = 0
    let outputTokens = 0
    for (const row of usage) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        if (typeof payload['costUsd'] === 'number') costUsd += payload['costUsd']
        if (typeof payload['inputTokens'] === 'number') inputTokens += payload['inputTokens']
        if (typeof payload['outputTokens'] === 'number') outputTokens += payload['outputTokens']
      } catch {
        // 单条坏事件不该让整个统计报错。
      }
    }

    const byProvider = new Map<string, { total: number; completed: number; failed: number; durations: number[] }>()
    for (const run of runs) {
      const bucket = byProvider.get(run.provider)
        ?? { total: 0, completed: 0, failed: 0, durations: [] }
      bucket.total += 1
      if (run.status === 'completed') bucket.completed += 1
      if (run.status === 'failed') bucket.failed += 1
      if (run.ended_at !== null) bucket.durations.push(run.ended_at - run.started_at)
      byProvider.set(run.provider, bucket)
    }

    return {
      totalRuns: runs.length,
      completed: runs.filter((r) => r.status === 'completed').length,
      failed: runs.filter((r) => r.status === 'failed').length,
      running: runs.filter((r) => r.status === 'running').length,
      costUsd,
      inputTokens,
      outputTokens,
      providers: [...byProvider].map(([provider, b]) => ({
        provider,
        total: b.total,
        completed: b.completed,
        failed: b.failed,
        // 中位数比平均值抗离群值：一次超时会把平均耗时拉得没法看。
        medianMs: median(b.durations),
      })).sort((a, b) => b.total - a.total),
    }
  }

  // ── 设置 ───────────────────────────────────────────────────────

  /**
   * 读一个设置项。放在 `meta` 表里而不是单独建表：设置总共就几个键，
   * 为它加一张表和一次迁移不划算。
   * @param key - 键名。
   * @param fallback - 没存过时的默认值。
   */
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`setting:${key}`) as
      | { value: string } | undefined
    if (row === undefined) return fallback
    try {
      const parsed = JSON.parse(row.value) as T | null
      // 存坏了、或者存进去的是 null/undefined，都当没存过。
      // 一个坏值不该卡住整个启动。
      return parsed === null ? fallback : parsed
    } catch {
      return fallback
    }
  }

  /**
   * 写一个设置项。
   * @param key - 键名。
   * @param value - 任意可序列化的值；`undefined` 存成 null，等同于清除。
   */
  setSetting(key: string, value: unknown): void {
    // `JSON.stringify(undefined)` 返回的是 undefined 而不是字符串，
    // 直接绑给 SQLite 会抛。补一个 null 兜底。
    this.db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(`setting:${key}`, JSON.stringify(value ?? null))
  }

  // ── 事件日志（append-only）──────────────────────────────────────

  /**
   * 追加一条事件。seq 由存储分配，同一事务内取当前最大值加一。
   * @param runId - 所属 Run。
   * @param kind - 事件类型。
   * @param payload - 任意可序列化负载。
   * @param at - 发生时间（毫秒）。
   * @returns 分配到的 seq，可直接用作 SSE 的 `id:`。
   */
  /**
   * 一次执行的最后一条事件。
   *
   * 看板上的"运行中"卡片要一行日志预览，而它们的 SSE 只在详情弹窗开着时才
   * 订阅 —— 关着弹窗就什么都看不见。看板本来就在轮询，顺手把最后一条捎上，
   * 比给每张卡各开一条 SSE 便宜得多。
   */
  lastEvent(runId: RunId): RunEvent | null {
    const row = this.db.prepare(
      'SELECT * FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
    ).get(runId) as unknown as EventRow | undefined
    return row === undefined ? null : toEvent(row)
  }

  appendEvent(runId: RunId, kind: string, payload: unknown, at: number): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT MAX(seq) AS max_seq FROM run_events WHERE run_id = ?')
        .get(runId) as unknown as { max_seq: number | null }
      const seq = (row.max_seq ?? 0) + 1
      this.db.prepare('INSERT INTO run_events (run_id, seq, kind, payload_json, at) VALUES (?, ?, ?, ?, ?)')
        .run(runId, seq, kind, JSON.stringify(payload ?? null), at)
      this.db.exec('COMMIT')
      return seq
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 读取事件，用于首次渲染与 SSE 断线续传。
   * @param runId - 所属 Run。
   * @param afterSeq - 只返回 seq 大于它的事件；对应 SSE 的 `Last-Event-ID`。
   */
  readEvents(runId: RunId, afterSeq = 0): RunEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq',
    ).all(runId, afterSeq) as unknown as EventRow[]
    return rows.map(toEvent)
  }

  /**
   * 读游标之后**最近的**若干条事件，外加游标之后一共有多少条。
   *
   * 与 `readEvents` 的分工在于谁在等：SSE 那边要的是"从断点起全部补上"，
   * 而一次问一句的调用方（MCP 的 run_status）要的是"现在到哪儿了"。
   *
   * **截断在 SQL 里做，不在 JS 里做。** 一次执行几万条事件是常事，先全查
   * 出来、逐条 JSON.parse、再切最后 200 条，等于每次轮询都把整张表读一遍 ——
   * 而 host 是单线程的，它同时还在给别的 Run 推 SSE。
   *
   * @param runId - 所属 Run。
   * @param afterSeq - 只看 seq 大于它的事件。
   * @param limit - 最多回多少条，取的是最新的那一段。
   * @returns 事件（按 seq **正序**，与 readEvents 一致）与游标之后的总条数。
   */
  readRecentEvents(runId: RunId, afterSeq: number, limit: number): {
    events: RunEvent[]
    total: number
  } {
    const counted = this.db.prepare(
      'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND seq > ?',
    ).get(runId, afterSeq) as unknown as { n: number }
    const rows = this.db.prepare(
      'SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?',
    ).all(runId, afterSeq, limit) as unknown as EventRow[]
    // DESC 取的是最新的一段，回给调用方之前翻回正序。
    return { events: rows.map(toEvent).reverse(), total: counted.n }
  }
}

interface EventRow {
  run_id: string
  seq: number
  kind: string
  payload_json: string
  at: number
}

function toEvent(row: EventRow): RunEvent {
  return {
    runId: asRunId(row.run_id),
    seq: row.seq,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    at: row.at,
  }
}

/** 中位数。空数组返回 null 而不是 0 —— 「没有数据」和「耗时为 0」不是一回事。 */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid] ?? null
}
