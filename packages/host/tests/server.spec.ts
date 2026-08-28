import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { connect, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { Storage } from '../src/storage/index.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'

const T0 = 1_000_000
const TOKEN = 'test-token-' + 'x'.repeat(32)
const PROJECT = asProjectId('b1')

let store: Storage
let server: RunningServer

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), projectId: PROJECT, revision: 1, column: 'ready', position: 1,
    description: id, acceptance: ['ok'], repoPath: '/repo', baseBranch: 'main',
    blockedBy: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 带 cookie 的 fetch，模拟浏览器拿到 token 之后的后续请求。 */
const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
    ...init,
    headers: { cookie: `loopkanban_token=${TOKEN}`, ...init.headers },
  })

/** 用原始 http 客户端发请求，以便伪造 Host 头（fetch 不允许覆盖）。 */
function rawRequest(headers: Record<string, string>, path = '/api/state'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, path, method: 'GET', headers },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  store = Storage.open(':memory:')
  store.createProject({ id: PROJECT, name: '默认', repoPath: '/repo', baseBranch: 'main', createdAt: T0 })
  // 心跳调快，让「发现死连接」的延迟在测试里可控。
  server = await startServer({ storage: store, token: TOKEN, sseHeartbeatMs: 50 })
})

afterEach(async () => {
  await server.close()
  store.close()
})

describe('POST /api/projects', () => {
  let sandbox: string
  let repo: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-projects-'))
    repo = join(sandbox, 'repo')
    await mkdir(repo, { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
      child.on('exit', resolve)
      child.on('error', reject)
    })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  const create = (body: unknown) =>
    api('/api/projects', { method: 'POST', body: JSON.stringify(body) })

  it('新增项目：记下名字与目录，基线分支由仓库自己说了算', async () => {
    const res = await create({ name: '我的项目', path: repo })
    expect(res.status).toBe(201)
    const { project } = await res.json() as { project: { name: string; repoPath: string; baseBranch: string } }
    expect(project.name).toBe('我的项目')
    expect(project.baseBranch).toBe('main')
    expect(store.listProjects()).toHaveLength(2)
  })

  it('不是 git 仓库就拒绝 —— 任务要在它派生的 worktree 上干活，派不出来就没有意义', async () => {
    const res = await create({ name: '空目录', path: sandbox })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('not-a-repo')
  })

  it('相对路径拒绝：服务端不该去猜它相对于谁', async () => {
    const res = await create({ name: '相对', path: './repo' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('path-not-absolute')
  })

  it('同一个目录不能加两次', async () => {
    await create({ name: '第一次', path: repo })
    const res = await create({ name: '第二次', path: repo })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('project-exists')
  })

  it('缺名字或缺目录一律 400', async () => {
    expect((await create({ path: repo })).status).toBe(400)
    expect((await create({ name: '没目录' })).status).toBe(400)
  })

  it('新建的卡跟着项目走：仓库与基线从项目取，不听建卡方的', async () => {
    const { project } = await (await create({ name: '我的项目', path: repo })).json() as
      { project: { id: string } }
    const res = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, description: '在新项目里干活' }),
    })
    expect(res.status).toBe(201)
    const { task: created } = await res.json() as { task: Task }
    expect(created.projectId).toBe(project.id)
    expect(created.repoPath).toBe(repo)
    expect(created.baseBranch).toBe('main')
  })
})

describe('PATCH /api/projects/:id', () => {
  const rename = (id: string, body: unknown) =>
    api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

  it('改名字，仓库路径与基线分支不动 —— 那是它的身份', async () => {
    const res = await rename(PROJECT, { name: '改过的名字' })
    expect(res.status).toBe(200)
    const project = store.getProject(PROJECT)
    expect(project?.name).toBe('改过的名字')
    expect(project?.repoPath).toBe('/repo')
    expect(project?.baseBranch).toBe('main')
  })

  it('空名字 400 —— 边栏上一行空白没人认得出那是什么', async () => {
    expect((await rename(PROJECT, { name: '   ' })).status).toBe(400)
    expect(store.getProject(PROJECT)?.name).toBe('默认')
  })

  it('项目不存在返回 404', async () => {
    expect((await rename('nope', { name: '新名字' })).status).toBe(404)
  })
})

describe('DELETE /api/projects/:id', () => {
  it('删掉项目，连同它名下的卡与执行历史', async () => {
    store.createTask(task({ id: 't1' }))
    store.createTask(task({ id: 't2', column: 'backlog' }))

    const res = await api(`/api/projects/${PROJECT}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, tasks: 2 })
    expect(store.listProjects()).toHaveLength(0)
    expect(store.listTasks()).toHaveLength(0)
  })

  it('还有卡在执行时拒绝 —— 账本抽走了，那个进程会继续跑到没人认识它', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    const res = await api(`/api/projects/${PROJECT}`, { method: 'DELETE' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('project-busy')
    // 拒绝就是什么都没动。
    expect(store.listProjects()).toHaveLength(1)
    expect(store.listTasks()).toHaveLength(1)
  })

  it('项目不存在返回 404', async () => {
    expect((await api('/api/projects/nope', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('GET /api/fs', () => {
  let sandbox: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-fs-'))
    await mkdir(join(sandbox, 'a-repo'), { recursive: true })
    await mkdir(join(sandbox, 'b-plain'), { recursive: true })
    await mkdir(join(sandbox, '.hidden'), { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['init', '-q', join(sandbox, 'a-repo')], { stdio: 'ignore' })
      child.on('exit', resolve)
      child.on('error', reject)
    })
  })

  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

  it('列子目录并标出哪些是 git 仓库；点开头的不列', async () => {
    const res = await api(`/api/fs?path=${encodeURIComponent(sandbox)}`)
    expect(res.status).toBe(200)
    const listing = await res.json() as
      { path: string; parent: string | null; entries: { name: string; isRepo: boolean }[] }
    expect(listing.entries.map((e) => e.name)).toEqual(['a-repo', 'b-plain'])
    expect(listing.entries.find((e) => e.name === 'a-repo')?.isRepo).toBe(true)
    expect(listing.entries.find((e) => e.name === 'b-plain')?.isRepo).toBe(false)
    expect(listing.parent).not.toBeNull()
  })

  it('不传 path 就落在家目录', async () => {
    const listing = await (await api('/api/fs')).json() as { path: string }
    expect(listing.path).toBe(homedir())
  })

  it('打不开的目录 404，相对路径 422', async () => {
    expect((await api(`/api/fs?path=${encodeURIComponent(join(sandbox, '不存在'))}`)).status).toBe(404)
    expect((await api('/api/fs?path=./relative')).status).toBe(422)
  })
})

describe('GET /api/agents', () => {
  /** 造一个探测结果，只填这条测试关心的字段。 */
  const detected = (id: string, caveat?: { label: string; detail: string }) => ({
    provider: { id } as never,
    caps: {
      id, bin: `/fake/${id}`, version: '1.0.0',
      streaming: true, canPinSessionId: false, canResume: true,
      permissionTiers: ['standard'],
      ...(caveat === undefined ? {} : { permissionCaveat: caveat }),
      help: { flags: new Set<string>(), choices: new Map<string, readonly string[]>() },
    } as never,
  })

  const CAVEAT = { label: '无沙箱', detail: 'Agent 可以改 worktree 之外的文件。' }

  it('把权限警示如实传给界面 —— 只报档位名字会让人按别家的经验理解它', async () => {
    const withCaveat = await startServer({
      storage: store, token: TOKEN, agents: [detected('opencode', CAVEAT)],
    })
    try {
      const body = await fetch(`http://127.0.0.1:${String(withCaveat.port)}/api/agents`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      }).then((r) => r.json() as Promise<{ agents: { id: string; permissionCaveat?: typeof CAVEAT }[] }>)
      expect(body.agents[0]?.permissionCaveat).toEqual(CAVEAT)
    } finally {
      await withCaveat.close()
    }
  })

  it('没有警示的 CLI 不会凭空多出这个字段', async () => {
    const plain = await startServer({
      storage: store, token: TOKEN, agents: [detected('codex')],
    })
    try {
      const body = await fetch(`http://127.0.0.1:${String(plain.port)}/api/agents`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      }).then((r) => r.json() as Promise<{ agents: Record<string, unknown>[] }>)
      expect(body.agents[0]).not.toHaveProperty('permissionCaveat')
      // help 原文这类噪音也不该漏出去。
      expect(body.agents[0]).not.toHaveProperty('help')
    } finally {
      await plain.close()
    }
  })
})

describe('监听与访问入口', () => {
  it('只监听回环地址，随机端口', () => {
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
  })

  it('首次带 query token 访问会下发 httpOnly cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/state?token=${TOKEN}`)
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })
})

describe('安全守卫', () => {
  it('没有 token 一律 401', async () => {
    expect(await rawRequest({ host: `127.0.0.1:${String(server.port)}` })).toBe(401)
  })

  it('token 错误 401', async () => {
    expect(await rawRequest({
      host: `127.0.0.1:${String(server.port)}`,
      cookie: 'loopkanban_token=wrong',
    })).toBe(401)
  })

  it('伪造的 Host 被拒 —— 即使 token 正确（DNS rebinding 防线）', async () => {
    expect(await rawRequest({
      host: 'evil.com',
      cookie: `loopkanban_token=${TOKEN}`,
    })).toBe(403)
  })

  it('跨源 Origin 被拒', async () => {
    expect(await rawRequest({
      host: `127.0.0.1:${String(server.port)}`,
      cookie: `loopkanban_token=${TOKEN}`,
      origin: 'https://evil.com',
    })).toBe(403)
  })
})

describe('GET /api/state', () => {
  it('返回项目与任务', async () => {
    store.createTask(task({ id: 't1' }))
    const body = await (await api('/api/state')).json() as { projects: unknown[]; tasks: Task[] }
    expect(body.projects).toHaveLength(1)
    expect(body.tasks.map((t) => t.id)).toEqual(['t1'])
  })

  it('未知路径 404', async () => {
    expect((await api('/api/nope')).status).toBe(404)
  })
})

describe('POST /api/tasks/:id/move', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  const move = (body: unknown) => api('/api/tasks/t1/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('合法流转成功并自增 revision', async () => {
    const res = await move({ expectedRevision: 1, to: 'running' })
    expect(res.status).toBe(200)
    const body = await res.json() as { task: Task }
    expect(body.task).toMatchObject({ column: 'running', revision: 2 })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('running')
  })

  it('revision 过期返回 409，客户端据此重读重试', async () => {
    await move({ expectedRevision: 1, to: 'running' })
    const res = await move({ expectedRevision: 1, to: 'review' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'revision-conflict' })
  })

  it('非法流转返回 422 而不是 409 —— 重试也没用，得改请求', async () => {
    const res = await move({ expectedRevision: 1, to: 'done' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'illegal-transition' })
  })

  it('缺参数返回 400', async () => {
    expect((await move({ to: 'running' })).status).toBe(400)
  })

  it('任务不存在返回 404', async () => {
    const res = await api('/api/tasks/ghost/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, to: 'running' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/tasks/:id/archive · unarchive', () => {
  beforeEach(() => { store.createTask(task({ id: 't1' })) })

  const shelf = (action: 'archive' | 'unarchive', body: unknown, id = 't1') =>
    api(`/api/tasks/${id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('归档后卡还在原来那一列，只是多了 archivedAt', async () => {
    const res = await shelf('archive', { expectedRevision: 1 })
    expect(res.status).toBe(200)
    const stored = store.getTask(asTaskId('t1'))
    expect(stored?.column).toBe('ready')
    expect(stored?.archivedAt).toBeGreaterThan(0)
  })

  it('取消归档后 archivedAt 落盘为空', async () => {
    await shelf('archive', { expectedRevision: 1 })
    const res = await shelf('unarchive', { expectedRevision: 2 })
    expect(res.status).toBe(200)
    expect(store.getTask(asTaskId('t1'))?.archivedAt).toBeUndefined()
  })

  it('归档的卡移不动，返回 422 而不是悄悄放行', async () => {
    await shelf('archive', { expectedRevision: 1 })
    const res = await api('/api/tasks/t1/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, to: 'backlog' }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'task-archived' })
  })

  it('revision 过期返回 409，缺参数 400，卡不存在 404', async () => {
    expect((await shelf('archive', { expectedRevision: 99 })).status).toBe(409)
    expect((await shelf('archive', {})).status).toBe(400)
    expect((await shelf('archive', { expectedRevision: 1 }, 'ghost')).status).toBe(404)
  })

  it('重复归档返回 422 —— 幂等地假装成功会让并发下的两次点击都以为自己赢了', async () => {
    await shelf('archive', { expectedRevision: 1 })
    const res = await shelf('archive', { expectedRevision: 2 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'already-archived' })
  })
})

describe('PATCH /api/tasks/:id', () => {
  const edit = (id: string, body: unknown) =>
    api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

  it('改描述与验收标准', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    const res = await edit('t1', { expectedRevision: 1, description: '新内容', acceptance: [] })
    expect(res.status).toBe(200)
    const after = store.getTask(asTaskId('t1'))
    expect(after?.description).toBe('新内容')
    // 验收标准是可选的，清空不再被拒。
    expect(after?.acceptance).toEqual([])
  })

  it('指定执行器与模型，null 才是"清空"', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    await edit('t1', { expectedRevision: 1, preferredProvider: 'claude', model: 'opus' })
    expect(store.getTask(asTaskId('t1'))?.model).toBe('opus')

    // 字段缺席只意味着"这次没提到"，不该把它抹掉。
    await edit('t1', { expectedRevision: 2, description: '只改内容' })
    expect(store.getTask(asTaskId('t1'))?.model).toBe('opus')

    // 显式送 null 才清空 —— JSON 里没有 undefined。
    await edit('t1', { expectedRevision: 3, preferredProvider: null, model: null })
    const cleared = store.getTask(asTaskId('t1'))
    expect(cleared?.model).toBeUndefined()
    expect(cleared?.preferredProvider).toBeUndefined()
  })
})

describe('DELETE /api/tasks/:id', () => {
  const del = (id: string, body?: unknown, query = '') =>
    api(`/api/tasks/${id}${query}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('删掉想法池里的卡，连它的执行历史一起', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createRun({
      id: asRunId('run-1'), taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: '/wt', branch: 'task/t1', status: 'failed', exitCode: 1, startedAt: T0,
    })
    store.appendEvent(asRunId('run-1'), 'text', { text: 'hi' }, T0)

    const res = await del('t1', { expectedRevision: 1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: true, unblocked: [] })
    expect(store.getTask(asTaskId('t1'))).toBeNull()
    expect(store.getRun(asRunId('run-1'))).toBeNull()
  })

  it('队列里的卡也能删', async () => {
    store.createTask(task({ id: 't1', column: 'ready' }))
    expect((await del('t1', { expectedRevision: 1 })).status).toBe(200)
  })

  it('Agent 动过仓库的卡返回 422，库里原样不动', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const res = await del('t1', { expectedRevision: 1 })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'not-deletable' })
    expect(store.getTask(asTaskId('t1'))).not.toBeNull()
  })

  it('下游对它的依赖被一并摘掉 —— 否则那张卡会永远停在"依赖未完成"', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 't2', blockedBy: [asTaskId('t1')] }))

    const res = await del('t1', { expectedRevision: 1 })
    expect(await res.json()).toMatchObject({ unblocked: ['t2'] })
    const downstream = store.getTask(asTaskId('t2'))
    expect(downstream?.blockedBy).toEqual([])
    // 摘依赖也是一次变更，revision 必须跟着走，否则别人的 CAS 会打在陈旧的值上。
    expect(downstream?.revision).toBe(2)
  })

  it('查询串里的 expectedRevision 与请求体等价', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    expect((await del('t1', undefined, '?expectedRevision=1')).status).toBe(200)
  })

  it('revision 过期返回 409，缺参数 400，卡不存在 404', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    expect((await del('t1', { expectedRevision: 99 })).status).toBe(409)
    expect((await del('t1', {})).status).toBe(400)
    expect((await del('ghost', { expectedRevision: 1 })).status).toBe(404)
  })
})

describe('SSE 事件流', () => {
  const RUN = asRunId('run-1')

  beforeEach(() => {
    store.createTask(task({ id: 't1' }))
    store.createRun({
      id: RUN, taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: '/wt', branch: 'task/t1', status: 'running', startedAt: T0,
    })
  })

  /** 读到累计出现 count 条 `id:` 为止。 */
  async function readEvents(res: Response, count: number): Promise<string> {
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()
    let text = ''
    while ((text.match(/^id: /gm) ?? []).length < count) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    return text
  }

  it('连上先补历史事件', async () => {
    store.appendEvent(RUN, 'session', { sessionId: 's1' }, T0)
    store.appendEvent(RUN, 'text', { text: '干活中' }, T0 + 1)

    const text = await readEvents(await api('/api/runs/run-1/events'), 2)
    expect(text).toContain('id: 1')
    expect(text).toContain('event: session')
    expect(text).toContain('干活中')
  })

  it('补完历史后接实时推送', async () => {
    store.appendEvent(RUN, 'text', { text: '历史' }, T0)
    const res = await api('/api/runs/run-1/events')

    // 先确保历史那条已经收到，再发实时的，避免竞态。
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error('no body')
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('历史')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }

    const seq = store.appendEvent(RUN, 'tool', { name: 'Bash' }, T0 + 5)
    server.bus.publish({ runId: RUN, seq, kind: 'tool', payload: { name: 'Bash' }, at: T0 + 5 })

    while (!text.includes('Bash')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    await reader.cancel()
    expect(text).toContain('event: tool')
  })

  it('Last-Event-ID 只补缺口，不重传全部历史', async () => {
    for (let i = 1; i <= 5; i += 1) store.appendEvent(RUN, 'text', { i }, T0 + i)

    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/runs/run-1/events`, {
      headers: { cookie: `loopkanban_token=${TOKEN}`, 'last-event-id': '3' },
    })
    const text = await readEvents(res, 2)
    expect(text).toContain('id: 4')
    expect(text).toContain('id: 5')
    expect(text).not.toContain('id: 1')
  })

  it('断开后订阅被清理，不泄漏监听器', async () => {
    const res = await api('/api/runs/run-1/events')
    const reader = res.body?.getReader()
    await reader?.read()
    expect(server.bus.size).toBeGreaterThan(0)
    await reader?.cancel()
    // 等几个心跳周期，服务端靠写入失败察觉对端已走。
    const deadline = Date.now() + 3_000
    while (server.bus.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(server.bus.size).toBe(0)
  })
})

describe('静态资源托管', () => {
  let staticServer: RunningServer
  let root: string
  let outside: string

  beforeEach(async () => {
    // 自建固件：测试不能依赖机器上恰好存在的文件。
    const sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-static-'))
    root = join(sandbox, 'dist')
    outside = join(sandbox, 'secret.txt')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>', 'utf8')
    await writeFile(join(root, 'assets', 'app.css'), 'body{}', 'utf8')
    // 放在 root 的兄弟目录，正是穿越攻击想读到的位置。
    await writeFile(outside, 'SECRET', 'utf8')

    staticServer = await startServer({
      storage: store, token: TOKEN, sseHeartbeatMs: 50, staticDir: root,
    })
  })

  afterEach(async () => {
    await staticServer.close()
    await rm(join(root, '..'), { recursive: true, force: true })
  })

  const get = (path: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(staticServer.port)}${path}`, {
      headers: { cookie: `loopkanban_token=${TOKEN}` },
    })

  it('根路径返回 index.html', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<title>app</title>')
  })

  it('带内容哈希的资源长缓存，index.html 绝不缓存', async () => {
    expect((await get('/assets/app.css')).headers.get('cache-control')).toContain('immutable')
    expect((await get('/')).headers.get('cache-control')).toBe('no-store')
  })

  it('目录穿越被挡住 —— 不能借静态路由读到 root 之外的文件', async () => {
    // 必须走原始 socket：fetch 会在发送前把 `..` 规范化掉，
    // 用它测出来的"通过"只证明了客户端做了事，服务端可能毫无防护。
    const raw = (path: string): Promise<string> => new Promise((resolve) => {
      const socket = connect(staticServer.port, '127.0.0.1', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(staticServer.port)}\r\n`
          + `Cookie: loopkanban_token=${TOKEN}\r\nConnection: close\r\n\r\n`,
        )
      })
      let buffer = ''
      socket.on('data', (chunk) => { buffer += String(chunk) })
      socket.on('end', () => { resolve(buffer) })
    })

    for (const attack of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/./../secret.txt',
      '/..%2fsecret.txt',
      `/..${outside}`,
    ]) {
      expect(await raw(attack), `${attack} 泄漏了 root 之外的文件`).not.toContain('SECRET')
    }
  })

  it('找不到的路径回落到 index.html，交给前端路由', async () => {
    const res = await get('/board/some-id')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>app</title>')
  })

  it('静态托管不会吃掉 /api 路径', async () => {
    expect((await get('/api/nope')).status).toBe(404)
    expect((await get('/api/state')).status).toBe(200)
  })
})

describe('错误处理（回归）', () => {
  it('请求体不是合法 JSON 时返回 400 而不是 500', async () => {
    const res = await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"description": ',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad-request' })
  })

  it('内部异常不把原始信息回给调用方', async () => {
    // 让 listProjects 抛一个带敏感路径的异常。
    const real = store.listProjects.bind(store)
    store.listProjects = (() => { throw new Error('ENOENT /Users/someone/.ssh/id_rsa') }) as typeof store.listProjects
    const res = await api('/api/state')
    store.listProjects = real

    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain('id_rsa')
    expect(body).toContain('internal-error')
  })
})

describe('开发模式：把前端转发给 vite', () => {
  let upstream: ReturnType<typeof createHttpServer>
  let upstreamPort: number
  let dev: RunningServer
  /** upstream 收到的请求，用来断言转发的忠实程度。 */
  let seen: { url: string; host: string | undefined }[]

  beforeEach(async () => {
    seen = []
    upstream = createHttpServer((req, res) => {
      seen.push({ url: req.url ?? '', host: req.headers.host })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html>vite:${req.url ?? ''}`)
    })
    // 假装自己是 vite 的 HMR ws server：认下升级，回一句能被断言的内容。
    upstream.on('upgrade', (req, socket) => {
      seen.push({ url: req.url ?? '', host: req.headers.host })
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nx-echo-url: ${req.url ?? ''}\r\n\r\n`,
      )
      socket.end()
    })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    upstreamPort = (upstream.address() as AddressInfo).port

    dev = await startServer({
      storage: store, token: TOKEN, sseHeartbeatMs: 50,
      devServer: `http://127.0.0.1:${String(upstreamPort)}`,
    })
  })

  afterEach(async () => {
    await dev.close()
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
  })

  const get = (path: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(dev.port)}${path}`, {
      headers: { cookie: `loopkanban_token=${TOKEN}` },
    })

  it('非 /api 的请求原样转给 vite', async () => {
    const res = await get('/src/main.tsx')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('vite:/src/main.tsx')
    expect(seen[0]?.host).toBe(`127.0.0.1:${String(upstreamPort)}`)
  })

  it('/api 仍由 host 自己处理，不会被转走', async () => {
    const res = await get('/api/state')
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('projects')
    expect(seen).toHaveLength(0)
  })

  it('vite 挂了时说清楚是哪一环，而不是给一个白页', async () => {
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
    const res = await get('/')
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'dev-server-unreachable' })
  })

  /**
   * 发一个 WebSocket 升级请求，返回 upstream 回声出来的路径。
   * @param cookie - 是否带上 token cookie。
   */
  function upgrade(cookie: boolean): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port: dev.port,
        // vite 的 HMR 会往 ws URL 上挂它自己的同名 token，这里一并复现。
        path: '/?token=vite-hmr-handshake',
        headers: {
          ...(cookie ? { cookie: `loopkanban_token=${TOKEN}` } : {}),
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.headers['x-echo-url'] as string | undefined)
      })
      // 被 guard 挡下时 host 直接 destroy socket，这里体现为连接被掐断。
      req.on('error', () => { resolve(undefined) })
      req.on('response', (res) => { res.resume(); reject(new Error(`没有升级，返回 ${String(res.statusCode)}`)) })
      req.end()
    })
  }

  it('WebSocket 升级也照转 —— 少了它 HMR 连不上，改代码不刷新', async () => {
    // 连 vite 自己的那个 ?token= 都要原样带过去，否则它会拒绝握手。
    expect(await upgrade(true)).toBe('/?token=vite-hmr-handshake')
  })

  it('升级请求同样要过 token 关，没 cookie 一律掐断', async () => {
    expect(await upgrade(false)).toBeUndefined()
  })
})

describe('静态资源路径（回归）', () => {
  it('嵌套资源按原路径返回，而不是回落到 index.html', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-nested-'))
    const root = join(sandbox, 'dist')
    await mkdir(join(root, 'assets', 'deep'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>', 'utf8')
    await writeFile(join(root, 'assets', 'deep', 'app.js'), 'export const x = 1', 'utf8')

    const nested = await startServer({ storage: store, token: TOKEN, sseHeartbeatMs: 50, staticDir: root })
    try {
      const res = await fetch(`http://127.0.0.1:${String(nested.port)}/assets/deep/app.js`, {
        headers: { cookie: `loopkanban_token=${TOKEN}` },
      })
      // 越界判断若写死分隔符（Windows 上是反斜杠），这里会拿到 index.html。
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(await res.text()).toContain('export const x')
    } finally {
      await nested.close()
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
