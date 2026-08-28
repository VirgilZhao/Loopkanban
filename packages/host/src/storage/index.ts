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
  readonly createdAt: number
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
  subject: string
  description: string
  acceptance_json: string
  repo_path: string
  base_branch: string
  preferred_provider: string | null
  blocked_by_json: string
  lease_json: string | null
  feedback: string | null
  archived_at: number | null
  created_at: number
  updated_at: number
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
    subject: row.subject,
    description: row.description,
    acceptance: JSON.parse(row.acceptance_json) as string[],
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    ...(preferred === null ? {} : { preferredProvider: preferred }),
    blockedBy: (JSON.parse(row.blocked_by_json) as string[]).map(asTaskId),
    ...(lease === undefined ? {} : { lease }),
    ...(row.feedback === null ? {} : { feedback: row.feedback }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
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
      'INSERT INTO projects (id, name, repo_path, base_branch, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, project.name, project.repoPath, project.baseBranch, project.createdAt)
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as {
      id: string; name: string; repo_path: string; base_branch: string; created_at: number
    }[]
    return rows.map((row) => ({
      id: asProjectId(row.id),
      name: row.name,
      repoPath: row.repo_path,
      baseBranch: row.base_branch,
      createdAt: row.created_at,
    }))
  }

  getProject(id: ProjectId): Project | null {
    return this.listProjects().find((project) => project.id === id) ?? null
  }

  // ── Task ───────────────────────────────────────────────────────

  createTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (
        id, project_id, revision, column_name, position, subject, description,
        acceptance_json, repo_path, base_branch, preferred_provider,
        blocked_by_json, lease_json, feedback, archived_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.projectId, task.revision, task.column, task.position,
      task.subject, task.description, JSON.stringify(task.acceptance),
      task.repoPath, task.baseBranch, task.preferredProvider ?? null,
      JSON.stringify(task.blockedBy),
      task.lease === undefined ? null : JSON.stringify(task.lease),
      task.feedback ?? null,
      task.archivedAt ?? null,
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
        revision = ?, column_name = ?, position = ?, subject = ?, description = ?,
        acceptance_json = ?, repo_path = ?, base_branch = ?, preferred_provider = ?,
        blocked_by_json = ?, lease_json = ?, feedback = ?,
        archived_at = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      next.revision, next.column, next.position, next.subject, next.description,
      JSON.stringify(next.acceptance), next.repoPath, next.baseBranch,
      next.preferredProvider ?? null,
      JSON.stringify(next.blockedBy),
      next.lease === undefined ? null : JSON.stringify(next.lease),
      next.feedback ?? null,
      next.archivedAt ?? null,
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
   * @param cascade - 摘掉这条依赖之后的下游任务新值（见 `dropDependency`）。
   * @returns 是否删成功；false 表示期间已被他人改动，调用方应重读后重试。
   */
  deleteTask(id: TaskId, expectedRevision: number, cascade: readonly Task[] = []): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 顺序是外键定的：事件 → Run → 卡片。反过来第一步就会被 runs 的引用挡住。
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
    ).all(runId, afterSeq) as unknown as {
      run_id: string; seq: number; kind: string; payload_json: string; at: number
    }[]
    return rows.map((row) => ({
      runId: asRunId(row.run_id),
      seq: row.seq,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      at: row.at,
    }))
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
