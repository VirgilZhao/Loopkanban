/**
 * 数据库结构与迁移。
 *
 * 用 Node 内置的 `node:sqlite`，不引外部依赖 —— 少一个原生模块就少一份
 * 跨平台预编译的麻烦，而 `npx openkanban` 的分发正吃这个亏。
 *
 * 迁移只增不改：每条 SQL 跑一次，版本号记在 `meta` 表里。
 */

import type { DatabaseSync } from 'node:sqlite'

/** 按顺序执行的迁移。**只许在末尾追加，不许修改已发布的条目。** */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE boards (
    id           TEXT PRIMARY KEY,
    name         TEXT    NOT NULL,
    repo_path    TEXT    NOT NULL,
    base_branch  TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE tasks (
    id                 TEXT PRIMARY KEY,
    board_id           TEXT    NOT NULL REFERENCES boards(id),
    -- 单调递增，compare-and-set 的凭据。
    revision           INTEGER NOT NULL,
    column_name        TEXT    NOT NULL,
    position           REAL    NOT NULL,
    subject            TEXT    NOT NULL,
    description        TEXT    NOT NULL,
    acceptance_json    TEXT    NOT NULL,
    repo_path          TEXT    NOT NULL,
    base_branch        TEXT    NOT NULL,
    preferred_provider TEXT,
    blocked_by_json    TEXT    NOT NULL,
    write_scopes_json  TEXT    NOT NULL,
    lease_json         TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX idx_tasks_board_column ON tasks(board_id, column_name, position);

  CREATE TABLE runs (
    id               TEXT PRIMARY KEY,
    task_id          TEXT    NOT NULL REFERENCES tasks(id),
    provider         TEXT    NOT NULL,
    cli_version      TEXT    NOT NULL,
    -- CLI 侧的会话 id，用于续跑。codex 只能事后从输出里捞，所以可空。
    agent_session_id TEXT,
    worktree_path    TEXT    NOT NULL,
    branch           TEXT    NOT NULL,
    status           TEXT    NOT NULL,
    exit_code        INTEGER,
    diagnostic       TEXT,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER
  );
  CREATE INDEX idx_runs_task ON runs(task_id, started_at DESC);

  -- append-only：只插不改不删。UI 从它投影，SSE 断线用 seq 续传，
  -- 重启后回放即可完整重建界面。
  CREATE TABLE run_events (
    run_id       TEXT    NOT NULL REFERENCES runs(id),
    seq          INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    payload_json TEXT    NOT NULL,
    at           INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  `,
]

/** 当前代码期望的结构版本。 */
export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * 建表并补齐迁移。
 * @param db - 已打开的数据库。
 * @throws 数据库版本高于本代码时抛出 —— 降级运行会静默损坏数据。
 */
export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined
  const current = row === undefined ? 0 : Number.parseInt(row.value, 10)

  if (current > MIGRATIONS.length) {
    throw new Error(
      `数据库结构版本 ${String(current)} 高于本程序支持的 ${String(MIGRATIONS.length)}，`
      + '请升级 OpenKanban 而不是降级运行 —— 降级会静默损坏数据。',
    )
  }

  for (let index = current; index < MIGRATIONS.length; index += 1) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[index] as string)
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(index + 1))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
