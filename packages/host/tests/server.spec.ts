import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { asBoardId, asRunId, asTaskId, type Task } from '@openkanban/core'
import { Storage } from '../src/storage/index.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'

const T0 = 1_000_000
const TOKEN = 'test-token-' + 'x'.repeat(32)
const BOARD = asBoardId('b1')

let store: Storage
let server: RunningServer

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), boardId: BOARD, revision: 1, column: 'ready', position: 1,
    subject: id, description: '', acceptance: ['ok'], repoPath: '/repo', baseBranch: 'main',
    blockedBy: [], writeScopes: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 带 cookie 的 fetch，模拟浏览器拿到 token 之后的后续请求。 */
const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
    ...init,
    headers: { cookie: `openkanban_token=${TOKEN}`, ...init.headers },
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
  store.createBoard({ id: BOARD, name: '默认', repoPath: '/repo', baseBranch: 'main', createdAt: T0 })
  // 心跳调快，让「发现死连接」的延迟在测试里可控。
  server = await startServer({ storage: store, token: TOKEN, sseHeartbeatMs: 50 })
})

afterEach(async () => {
  await server.close()
  store.close()
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
      cookie: 'openkanban_token=wrong',
    })).toBe(401)
  })

  it('伪造的 Host 被拒 —— 即使 token 正确（DNS rebinding 防线）', async () => {
    expect(await rawRequest({
      host: 'evil.com',
      cookie: `openkanban_token=${TOKEN}`,
    })).toBe(403)
  })

  it('跨源 Origin 被拒', async () => {
    expect(await rawRequest({
      host: `127.0.0.1:${String(server.port)}`,
      cookie: `openkanban_token=${TOKEN}`,
      origin: 'https://evil.com',
    })).toBe(403)
  })
})

describe('GET /api/state', () => {
  it('返回看板与任务', async () => {
    store.createTask(task({ id: 't1' }))
    const body = await (await api('/api/state')).json() as { boards: unknown[]; tasks: Task[] }
    expect(body.boards).toHaveLength(1)
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
      headers: { cookie: `openkanban_token=${TOKEN}`, 'last-event-id': '3' },
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
