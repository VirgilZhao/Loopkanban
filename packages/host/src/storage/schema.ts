/**
 * 数据库结构与迁移。
 *
 * 用 Node 内置的 `node:sqlite`，不引外部依赖 —— 少一个原生模块就少一份
 * 跨平台预编译的麻烦，而 `npx loopkanban` 的分发正吃这个亏。
 *
 * 迁移只增不改：每条 SQL 跑一次，版本号记在 `meta` 表里。
 */

import type { DatabaseSync } from 'node:sqlite'

/**
 * 按顺序执行的迁移。**只许在末尾追加，不许修改已发布的条目。**
 *
 * 导出是为了让迁移测试能"造一个旧库"：跑前 N 条建出历史上真实存在过的
 * 结构，再打开 Storage 走完剩下的。测试因此不必抄一份旧 schema，也不会
 * 在新增迁移后悄悄失效。
 */
export const MIGRATIONS: readonly string[] = [
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
  // 打回时留下的评审意见，跟着卡片走。
  `ALTER TABLE tasks ADD COLUMN feedback TEXT;`,
  // 取消 Failed 列，并入 Review：失败的执行同样要过人眼，判读完的动作
  // （打回重跑 / 废弃回想法池）和验收一模一样。旧库里的卡就地搬过去，
  // 否则它们会停在一个界面上已经不存在的列里，再也拖不动。
  `UPDATE tasks SET column_name = 'review' WHERE column_name = 'failed';`,
  // 归档标记。正交于 column：归档不改变卡在哪一列，取消归档就回到原位。
  `ALTER TABLE tasks ADD COLUMN archived_at INTEGER;`,
  // board → project。名字换了，东西是同一个：一个仓库目录 + 一条基线分支，
  // 任务挂在它下面。界面上不再有"多个看板"这个概念，只有项目与总览。
  `
  ALTER TABLE boards RENAME TO projects;
  ALTER TABLE tasks RENAME COLUMN board_id TO project_id;
  `,
  // 写入范围（建议性的并发冲突预警）退场：每个任务现在都在项目派生的
  // 独立 worktree 里干活，冲突推迟到合并时由 git 处理，比前缀猜测准确得多。
  `ALTER TABLE tasks DROP COLUMN write_scopes_json;`,
  // 标题退场，描述成为卡片的全部内容。旧数据一个字都不能丢：描述为空就
  // 直接搬过去，两边都有就把标题拼在描述前面 —— 它本来就是那段话的第一句。
  `
  UPDATE tasks SET description = CASE
    WHEN TRIM(description) = '' THEN subject
    ELSE subject || char(10) || char(10) || description
  END;
  ALTER TABLE tasks DROP COLUMN subject;
  `,
  // 指定执行器之后还能指定模型。留空就用那个 CLI 自己的默认。
  `ALTER TABLE tasks ADD COLUMN model TEXT;`,
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
      + '请升级 LoopKanban 而不是降级运行 —— 降级会静默损坏数据。',
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
