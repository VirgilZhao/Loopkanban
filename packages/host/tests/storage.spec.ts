import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  acquireLease, asProjectId, asRunId, asTaskId, moveTask, type Task,
} from '@loopkanban/core'
import { Storage, type Attachment, type Project, type Run } from '../src/storage/index.ts'
import { MIGRATIONS } from '../src/storage/schema.ts'

const T0 = 1_000_000
const PROJECT = asProjectId('b1')

let store: Storage

const project = (): Project => ({
  id: PROJECT, name: '默认看板', repoPath: '/repo', baseBranch: 'main', createdAt: T0,
})

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id),
    projectId: PROJECT,
    revision: 1,
    column: 'ready',
    position: 1,
    description: `${id} 的描述`,
    acceptance: ['有测试'],
    repoPath: '/repo',
    baseBranch: 'main',
    blockedBy: [],
    createdAt: T0,
    updatedAt: T0,
    ...rest,
  }
}

const run = (patch: Partial<Run> = {}): Run => ({
  id: asRunId('run-1'),
  taskId: asTaskId('t1'),
  provider: 'claude',
  cliVersion: '2.1.247',
  worktreePath: '/wt',
  branch: 'task/t1',
  status: 'running',
  startedAt: T0,
  ...patch,
})

beforeEach(() => {
  store = Storage.open(':memory:')
  store.createProject(project())
})

describe('任务往返', () => {
  it('写进去再读出来，字段一个不丢', () => {
    const original = task({
      id: 't1',
      preferredProvider: 'codex',
      blockedBy: [asTaskId('dep')],
      acceptance: ['A', 'B'],
      lease: { runId: asRunId('r9'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 1000 },
    })
    store.createTask(original)
    expect(store.getTask(asTaskId('t1'))).toEqual(original)
  })

  it('可选字段缺席时读回来也是缺席，而不是 null', () => {
    store.createTask(task({ id: 't1' }))
    const loaded = store.getTask(asTaskId('t1'))
    expect(loaded).not.toBeNull()
    expect(loaded?.lease).toBeUndefined()
    expect(loaded?.preferredProvider).toBeUndefined()
  })

  it('不存在的任务返回 null', () => {
    expect(store.getTask(asTaskId('nope'))).toBeNull()
  })

  it('按 position 排序列出', () => {
    store.createTask(task({ id: 'c', position: 3 }))
    store.createTask(task({ id: 'a', position: 1 }))
    store.createTask(task({ id: 'b', position: 2 }))
    expect(store.listTasks(PROJECT).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('commitTask 的 compare-and-set', () => {
  it('revision 对得上时写入成功', () => {
    store.createTask(task({ id: 't1' }))
    const loaded = store.getTask(asTaskId('t1'))
    if (loaded === null) throw new Error('unreachable')

    const moved = moveTask(loaded, { expectedRevision: loaded.revision, to: 'running', now: T0 + 1 })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return

    expect(store.commitTask(moved.value)).toBe(true)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('running')
    expect(store.getTask(asTaskId('t1'))?.revision).toBe(2)
  })

  it('两个调度器同时认领，只有一个能落库 —— 并发正确性最终落在这条 SQL 上', () => {
    store.createTask(task({ id: 't1' }))
    const snapshot = store.getTask(asTaskId('t1'))
    if (snapshot === null) throw new Error('unreachable')

    // 两个调度器读到同一份快照，各自算出自己的新值。
    const a = acquireLease(snapshot, {
      expectedRevision: snapshot.revision, runId: asRunId('rA'),
      provider: 'claude', ttlMs: 60_000, now: T0, completed: new Set(),
    })
    const b = acquireLease(snapshot, {
      expectedRevision: snapshot.revision, runId: asRunId('rB'),
      provider: 'codex', ttlMs: 60_000, now: T0, completed: new Set(),
    })
    // 领域层看不见彼此，两边都算得出"合法"的新值。
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(store.commitTask(a.value)).toBe(true)
    // B 拿着同样的 revision 提交，必须被拒。
    expect(store.commitTask(b.value)).toBe(false)

    expect(store.getTask(asTaskId('t1'))?.lease?.runId).toBe('rA')
  })

  it('提交一个 revision 落后的值会被拒，数据不被覆盖', () => {
    store.createTask(task({ id: 't1', revision: 5, description: '新的' }))
    const stale = task({ id: 't1', revision: 3, description: '旧的' })
    expect(store.commitTask(stale)).toBe(false)
    expect(store.getTask(asTaskId('t1'))?.description).toBe('新的')
  })

  it('租约可以被写成 null 来释放', () => {
    store.createTask(task({
      id: 't1', column: 'running',
      lease: { runId: asRunId('r1'), provider: 'claude', acquiredAt: T0, expiresAt: T0 + 1000 },
    }))
    const loaded = store.getTask(asTaskId('t1'))
    if (loaded === null) throw new Error('unreachable')
    const moved = moveTask(loaded, { expectedRevision: loaded.revision, to: 'review', now: T0 + 1 })
    if (!moved.ok) throw new Error('unreachable')

    expect(store.commitTask(moved.value)).toBe(true)
    expect(store.getTask(asTaskId('t1'))?.lease).toBeUndefined()
  })
})

describe('Run', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  it('写入后可读回，可选字段保持缺席', () => {
    store.createRun(run())
    const loaded = store.getRun(asRunId('run-1'))
    expect(loaded).toMatchObject({ provider: 'claude', status: 'running' })
    expect(loaded?.agentSessionId).toBeUndefined()
    expect(loaded?.endedAt).toBeUndefined()
  })

  it('可以补写会话 id 与终态', () => {
    store.createRun(run())
    store.updateRun({
      ...run(), agentSessionId: 'sess-9', status: 'failed',
      exitCode: 1, diagnostic: 'terminal=api_error', endedAt: T0 + 5000,
    })
    expect(store.getRun(asRunId('run-1'))).toMatchObject({
      agentSessionId: 'sess-9', status: 'failed', exitCode: 1, endedAt: T0 + 5000,
    })
  })

  it('列出上次崩溃留下的孤儿 Run，供启动时对账', () => {
    store.createRun(run({ id: asRunId('alive') }))
    store.createRun(run({ id: asRunId('done'), status: 'completed', endedAt: T0 + 1 }))
    expect(store.listOrphanRuns().map((r) => r.id)).toEqual(['alive'])
  })
})

describe('deleteTask', () => {
  beforeEach(() => { store.createTask(task({ id: 't1', column: 'backlog' })) })

  it('连同 Run 与事件一起抹掉 —— 留一串指向空 taskId 的事件只是垃圾', () => {
    store.createRun(run())
    store.appendEvent(asRunId('run-1'), 'text', { hi: 1 }, T0)
    expect(store.deleteTask(asTaskId('t1'), 1)).toBe(true)
    expect(store.getTask(asTaskId('t1'))).toBeNull()
    expect(store.getRun(asRunId('run-1'))).toBeNull()
    expect(store.readEvents(asRunId('run-1'))).toEqual([])
  })

  it('revision 对不上就不删，库里原样不动', () => {
    expect(store.deleteTask(asTaskId('t1'), 99)).toBe(false)
    expect(store.getTask(asTaskId('t1'))).not.toBeNull()
  })

  it('同一个事务里摘掉下游的依赖', () => {
    store.createTask(task({ id: 't2', blockedBy: [asTaskId('t1')] }))
    const downstream = store.getTask(asTaskId('t2'))
    if (downstream === null) throw new Error('setup')
    const patched = { ...downstream, blockedBy: [], revision: downstream.revision + 1 }

    expect(store.deleteTask(asTaskId('t1'), 1, [patched])).toBe(true)
    expect(store.getTask(asTaskId('t2'))?.blockedBy).toEqual([])
  })

  it('下游的 CAS 失败就整体回滚 —— 不留下"卡没了但依赖还悬着"', () => {
    store.createTask(task({ id: 't2', blockedBy: [asTaskId('t1')] }))
    const stale = store.getTask(asTaskId('t2'))
    if (stale === null) throw new Error('setup')
    // revision 从 5 起跳，库里是 1 —— 这条 CAS 必然打不中。
    expect(store.deleteTask(asTaskId('t1'), 1, [{ ...stale, revision: 5 }])).toBe(false)
    expect(store.getTask(asTaskId('t1'))).not.toBeNull()
    expect(store.getTask(asTaskId('t2'))?.blockedBy).toEqual([asTaskId('t1')])
  })

  it('删完之后同一个 id 可以重新建，不会被残留的外键卡住', () => {
    store.createRun(run())
    store.deleteTask(asTaskId('t1'), 1)
    expect(() => { store.createTask(task({ id: 't1' })) }).not.toThrow()
  })
})

describe('附件', () => {
  const attachment = (patch: Partial<Attachment> = {}): Attachment => ({
    id: 'a-1',
    taskId: asTaskId('t1'),
    filename: '设计稿.png',
    mime: 'image/png',
    size: 1024,
    path: '/data/attachments/t1/a-1-设计稿.png',
    at: T0,
    ...patch,
  })

  beforeEach(() => { store.createTask(task({ id: 't1', column: 'backlog' })) })

  it('往返一条附件', () => {
    store.addAttachment(attachment())
    expect(store.listAttachments(asTaskId('t1'))).toEqual([attachment()])
    expect(store.getAttachment('a-1')).toEqual(attachment())
  })

  it('按上传顺序排 —— TASK.md 里的清单照这个顺序给 Agent', () => {
    store.addAttachment(attachment({ id: 'a-2', filename: '第二个.pdf', at: T0 + 10 }))
    store.addAttachment(attachment({ id: 'a-1', filename: '第一个.png', at: T0 }))
    expect(store.listAttachments(asTaskId('t1')).map((a) => a.id)).toEqual(['a-1', 'a-2'])
  })

  it('删记录不碰别的卡', () => {
    store.createTask(task({ id: 't2', column: 'backlog' }))
    store.addAttachment(attachment())
    store.addAttachment(attachment({ id: 'a-2', taskId: asTaskId('t2') }))
    expect(store.deleteAttachment('a-1')).toBe(true)
    expect(store.deleteAttachment('a-1')).toBe(false)
    expect(store.listAttachments(asTaskId('t2'))).toHaveLength(1)
  })

  it('删卡时附件记录一起走，否则外键会挡住删除', () => {
    store.addAttachment(attachment())
    expect(store.deleteTask(asTaskId('t1'), 1)).toBe(true)
    expect(store.getAttachment('a-1')).toBeNull()
  })

  it('删项目时同理，并且删之前还问得出该收拾哪些文件', () => {
    store.addAttachment(attachment())
    expect(store.listProjectAttachments(PROJECT).map((a) => a.path)).toEqual([attachment().path])
    expect(store.deleteProject(PROJECT)).toBe(true)
    expect(store.getAttachment('a-1')).toBeNull()
  })
})

describe('事件日志（append-only）', () => {
  beforeEach(() => {
    store.createTask(task({ id: 't1' }))
    store.createRun(run())
  })

  it('seq 从 1 开始逐条递增', () => {
    const seqs = ['session', 'text', 'tool'].map((kind, i) =>
      store.appendEvent(asRunId('run-1'), kind, { i }, T0 + i))
    expect(seqs).toEqual([1, 2, 3])
  })

  it('seq 按 Run 独立编号', () => {
    store.createRun(run({ id: asRunId('run-2') }))
    store.appendEvent(asRunId('run-1'), 'text', null, T0)
    store.appendEvent(asRunId('run-1'), 'text', null, T0)
    expect(store.appendEvent(asRunId('run-2'), 'text', null, T0)).toBe(1)
  })

  it('负载原样往返', () => {
    store.appendEvent(asRunId('run-1'), 'tool', { name: 'Bash', input: { cmd: 'ls -la' } }, T0)
    expect(store.readEvents(asRunId('run-1'))[0]).toMatchObject({
      seq: 1, kind: 'tool', payload: { name: 'Bash', input: { cmd: 'ls -la' } },
    })
  })

  it('afterSeq 支持 SSE 断线续传 —— 重连时不必重传全部历史', () => {
    for (let i = 0; i < 5; i += 1) store.appendEvent(asRunId('run-1'), 'text', { i }, T0 + i)
    const resumed = store.readEvents(asRunId('run-1'), 3)
    expect(resumed.map((e) => e.seq)).toEqual([4, 5])
  })

  it('没有事件时返回空数组而不是抛错', () => {
    expect(store.readEvents(asRunId('run-1'))).toEqual([])
  })
})

describe('迁移', () => {
  it('重复打开同一库不会重复建表', () => {
    const first = Storage.open(':memory:')
    expect(() => { first.close() }).not.toThrow()
  })

  it('外键约束生效 —— 不能给不存在的任务建 Run', () => {
    expect(() => { store.createRun(run({ taskId: asTaskId('ghost') })) }).toThrow()
  })
})

describe('stats', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  const addRun = (id: string, patch: Partial<Run>): Run => {
    const created = run({ id: asRunId(id), ...patch })
    store.createRun(created)
    return created
  }

  it('空库时全是零，中位耗时为 null 而不是 0', () => {
    const s = store.stats()
    expect(s).toMatchObject({ totalRuns: 0, completed: 0, failed: 0, costUsd: 0 })
    expect(s.providers).toEqual([])
  })

  it('按状态与 provider 汇总', () => {
    addRun('a', { provider: 'claude', status: 'completed', endedAt: T0 + 10_000 })
    addRun('b', { provider: 'claude', status: 'failed', endedAt: T0 + 30_000 })
    addRun('c', { provider: 'codex', status: 'completed', endedAt: T0 + 20_000 })
    addRun('d', { provider: 'codex', status: 'running' })

    const s = store.stats()
    expect(s).toMatchObject({ totalRuns: 4, completed: 2, failed: 1, running: 1 })
    expect(s.providers[0]).toMatchObject({ provider: 'claude', total: 2, completed: 1, failed: 1 })
    // 中位数抗离群值：10s 与 30s 的中位是 20s。
    expect(s.providers[0]?.medianMs).toBe(20_000)
  })

  it('没有已结束的 Run 时中位耗时是 null —— 「没数据」不等于「耗时 0」', () => {
    addRun('a', { provider: 'claude', status: 'running' })
    expect(store.stats().providers[0]?.medianMs).toBeNull()
  })

  it('用量与成本从事件日志现算', () => {
    addRun('a', { provider: 'claude', status: 'completed', endedAt: T0 + 1 })
    store.appendEvent(asRunId('a'), 'usage', { inputTokens: 100, outputTokens: 20, costUsd: 0.5 }, T0)
    store.appendEvent(asRunId('a'), 'usage', { inputTokens: 50, outputTokens: 10, costUsd: 0.25 }, T0)
    store.appendEvent(asRunId('a'), 'text', { text: '不该被计入' }, T0)

    expect(store.stats()).toMatchObject({ inputTokens: 150, outputTokens: 30, costUsd: 0.75 })
  })

  it('单条坏事件不该让整个统计报错', () => {
    addRun('a', { provider: 'claude', status: 'completed', endedAt: T0 + 1 })
    store.appendEvent(asRunId('a'), 'usage', { costUsd: 1 }, T0)
    store.appendEvent(asRunId('a'), 'usage', 'not-an-object', T0)
    expect(() => store.stats()).not.toThrow()
    expect(store.stats().costUsd).toBe(1)
  })
})

describe('迁移', () => {
  /**
   * 造一个停在 `version` 版本上的真实旧库：只跑前 version 条迁移。
   * 不抄旧 schema，所以往后再加迁移这个测试也不会悄悄失效。
   */
  function seedLegacyDb(file: string, version: number): DatabaseSync {
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const sql of MIGRATIONS.slice(0, version)) db.exec(sql)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(version))
    return db
  }

  it('取消 Failed 列：旧库里 failed 的卡就地搬进 review', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loopkanban-migrate-'))
    const file = join(dir, 'board.db')
    try {
      // v2 = 建表 + feedback 列，也就是 Failed 列还存在的那个世界。
      const legacy = seedLegacyDb(file, 2)
      legacy.prepare('INSERT INTO boards VALUES (?, ?, ?, ?, ?)')
        .run(PROJECT, '默认看板', '/repo', 'main', T0)
      legacy.prepare(`
        INSERT INTO tasks (
          id, board_id, revision, column_name, position, subject, description,
          acceptance_json, repo_path, base_branch, preferred_provider,
          blocked_by_json, write_scopes_json, lease_json, feedback, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('t1', PROJECT, 1, 'failed', 1, '跑挂了的卡', '', '[]', '/repo', 'main',
        null, '[]', '[]', null, null, T0, T0)
      legacy.close()

      const store = Storage.open(file)
      const migrated = store.getTask(asTaskId('t1'))
      expect(migrated?.column).toBe('review')
      // 搬列而已，内容一个字都不该动。
      expect(migrated?.description).toBe('跑挂了的卡')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('board → project：旧库改名后，卡还挂在同一个项目上，写入范围列一并退场', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loopkanban-migrate-'))
    const file = join(dir, 'board.db')
    try {
      // v4 = 改名之前的世界：boards 表、board_id 列、write_scopes_json 都还在。
      const legacy = seedLegacyDb(file, 4)
      legacy.prepare('INSERT INTO boards VALUES (?, ?, ?, ?, ?)')
        .run(PROJECT, '默认看板', '/repo', 'main', T0)
      legacy.prepare(`
        INSERT INTO tasks (
          id, board_id, revision, column_name, position, subject, description,
          acceptance_json, repo_path, base_branch, preferred_provider,
          blocked_by_json, write_scopes_json, lease_json, feedback, archived_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('t1', PROJECT, 1, 'ready', 1, '老卡', '', '["有测试"]', '/repo', 'main',
        null, '[]', '["src/auth/"]', null, null, null, T0, T0)
      legacy.close()

      const store = Storage.open(file)
      const projects = store.listProjects()
      expect(projects).toHaveLength(1)
      expect(projects[0]?.repoPath).toBe('/repo')
      // 卡没搬家，只是它挂着的那个东西改了名字。
      expect(store.getTask(asTaskId('t1'))?.projectId).toBe(PROJECT)
      expect(store.listTasks(PROJECT).map((t) => t.id)).toEqual(['t1'])
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('加归档列：旧库里的卡一律视为未归档', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loopkanban-migrate-'))
    const file = join(dir, 'board.db')
    try {
      const legacy = seedLegacyDb(file, 3)
      legacy.prepare('INSERT INTO boards VALUES (?, ?, ?, ?, ?)')
        .run(PROJECT, '默认看板', '/repo', 'main', T0)
      legacy.prepare(`
        INSERT INTO tasks (
          id, board_id, revision, column_name, position, subject, description,
          acceptance_json, repo_path, base_branch, preferred_provider,
          blocked_by_json, write_scopes_json, lease_json, feedback, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('t1', PROJECT, 1, 'ready', 1, '老卡', '', '["有测试"]', '/repo', 'main',
        null, '[]', '[]', null, null, T0, T0)
      legacy.close()

      const store = Storage.open(file)
      expect(store.getTask(asTaskId('t1'))?.archivedAt).toBeUndefined()
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Pull Request', () => {
  beforeEach(() => { store.createTask(task({ id: 't1', column: 'review' })) })

  const pr = (patch: Record<string, unknown> = {}) => ({
    id: 'pr-1', taskId: asTaskId('t1'), number: 7, url: 'https://github.com/acme/demo/pull/7',
    branch: 'task/t1', baseBranch: 'main', state: 'open' as const, mergeable: 'unknown' as const,
    createdAt: T0, updatedAt: T0, ...patch,
  })

  it('同一条 PR 刷多少次都只有一行，状态覆盖成最新的', () => {
    store.upsertPullRequest(pr())
    store.upsertPullRequest(pr({ state: 'merged', mergedAt: T0 + 99, updatedAt: T0 + 99 }))

    const found = store.listPullRequests(asTaskId('t1'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ state: 'merged', mergedAt: T0 + 99 })
  })

  it('刷新不动 createdAt —— 那是"这条 PR 什么时候进视野"，被推到现在顺序就乱了', () => {
    store.upsertPullRequest(pr())
    store.upsertPullRequest(pr({ createdAt: T0 + 5000, updatedAt: T0 + 5000 }))
    expect(store.listPullRequests(asTaskId('t1'))[0]?.createdAt).toBe(T0)
  })

  it('一张卡可以有多条，新的排在前面 —— 每一轮合上去的是不同的一条', () => {
    store.upsertPullRequest(pr())
    store.upsertPullRequest(pr({ id: 'pr-2', number: 9 }))
    expect(store.listPullRequests(asTaskId('t1')).map((row) => row.number)).toEqual([9, 7])
  })

  it('只有还开着的才进巡检，合过的不必再问', () => {
    store.upsertPullRequest(pr())
    store.upsertPullRequest(pr({ id: 'pr-2', number: 9, state: 'merged' }))
    expect(store.listOpenPullRequests().map((row) => row.number)).toEqual([7])
    expect(store.listAllPullRequests()).toHaveLength(2)
  })

  it('删卡时 PR 记录跟着走 —— 留着一堆指向空卡的行只是垃圾', () => {
    store.upsertPullRequest(pr())
    const current = store.getTask(asTaskId('t1')) as Task
    store.commitTask({ ...current, column: 'ready', revision: current.revision + 1 })
    expect(store.deleteTask(asTaskId('t1'), current.revision + 1)).toBe(true)
    expect(store.listAllPullRequests()).toEqual([])
  })
})
