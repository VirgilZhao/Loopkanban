import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable, Writable } from 'node:stream'
import { asProjectId, asRunId, asTaskId, type Task } from '@loopkanban/core'
import { BoardClient, discoverBoard, handleMessage, serveMcp, TOOLS } from '../src/mcp/index.ts'
import { writeEndpoint } from '../src/server/endpoint.ts'
import { Storage } from '../src/storage/index.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'

const T0 = 1_000_000
const TOKEN = 'test-token-' + 'x'.repeat(32)
const PROJECT = asProjectId('p1')

let store: Storage
let server: RunningServer
let client: BoardClient

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), projectId: PROJECT, revision: 1, column: 'ready', position: 1,
    description: `${id} 要做的事`, acceptance: ['跑得通'], repoPath: '/repo', baseBranch: 'main',
    blockedBy: [], relatedTo: [], createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 调一次工具，把它回的那段 JSON 解出来。 */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{
  isError: boolean
  text: string
  data: unknown
}> {
  const response = await handleMessage(client, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  })
  const result = response?.result as { content: { text: string }[]; isError: boolean }
  const text = result.content[0]?.text ?? ''
  let data: unknown = null
  try {
    data = JSON.parse(text) as unknown
  } catch {
    // 失败时回的是给人读的一句话，不是 JSON —— 那也是被测行为之一。
  }
  return { isError: result.isError, text, data }
}

beforeEach(async () => {
  store = Storage.open(':memory:')
  store.createProject({ id: PROJECT, name: '默认', repoPath: '/repo', baseBranch: 'main', createdAt: T0 })
  server = await startServer({ storage: store, token: TOKEN })
  client = new BoardClient({ baseUrl: `http://127.0.0.1:${String(server.port)}`, token: TOKEN })
})

afterEach(async () => {
  await server.close()
  store.close()
})

describe('协议这一层', () => {
  it('initialize 报回客户端认识的版本与能力', async () => {
    const response = await handleMessage(client, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    })
    const result = response?.result as {
      protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string }
      instructions: string
    }
    // 客户端说的版本我们认识，就照它回 —— 不该逼一个老客户端跟着我们跳版本。
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.capabilities.tools).toBeDefined()
    expect(result.serverInfo.name).toBe('loopkanban')
    expect(result.instructions).toContain('claim_task')
  })

  it('客户端报一个我们不认识的版本时，回我们自己支持的那个', async () => {
    const response = await handleMessage(client, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' },
    })
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25')
  })

  it('通知一个字都不回 —— 回了会被当成对不上号的响应', async () => {
    expect(await handleMessage(client, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handleMessage(client, { jsonrpc: '2.0', method: '不认识的通知' })).toBeNull()
  })

  it('不支持的方法回 -32601，工具名拼错回 -32602', async () => {
    const method = await handleMessage(client, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
    expect(method?.error?.code).toBe(-32601)

    const tool = await handleMessage(client, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'accept_task', arguments: {} },
    })
    expect(tool?.error?.code).toBe(-32602)
  })

  it('tools/list 给出每个工具的名字与入参 schema', async () => {
    const response = await handleMessage(client, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const { tools } = response?.result as { tools: { name: string; inputSchema: unknown }[] }
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name))
    expect(tools.every((tool) => tool.inputSchema !== undefined)).toBe(true)
  })

  it('验收与废弃故意不给 —— 干活的人不能给自己盖章', () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(names).toContain('claim_task')
    expect(names).not.toContain('accept_task')
    expect(names).not.toContain('discard_task')
  })
})

describe('stdio 传输', () => {
  /** 把几行喂给 serveMcp，收集它写回来的行。 */
  async function exchange(lines: string[]): Promise<string[]> {
    const out: string[] = []
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) { out.push(chunk.toString('utf8')); done() },
    })
    await serveMcp({ client, input: Readable.from(lines.map((line) => `${line}\n`)), output })
    return out.join('').split('\n').filter((line) => line.length > 0)
  }

  it('一行一条 JSON，通知不产出任何一行', async () => {
    const lines = await exchange([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ])
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2])
  })

  it('坏掉的一行回 -32700，后面的照常处理 —— 一条烂消息不该掐断整条连接', async () => {
    const lines = await exchange([
      '{ 这不是 JSON',
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    ])
    expect((JSON.parse(lines[0] as string) as { error: { code: number } }).error.code).toBe(-32700)
    expect((JSON.parse(lines[1] as string) as { id: number }).id).toBe(7)
  })

  it('正文里的换行被转义，绝不会自己占一行', async () => {
    store.createTask(task({ id: 't1', description: '第一行\n第二行' }))
    const lines = await exchange([
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_task', arguments: { taskId: 't1' } },
      }),
    ])
    expect(lines).toHaveLength(1)
    const result = (JSON.parse(lines[0] as string) as { result: { content: { text: string }[] } }).result
    expect(result.content[0]?.text).toContain('第二行')
  })
})

describe('查询', () => {
  it('list_tasks 按项目与列筛选，归档的卡默认不出现', async () => {
    store.createTask(task({ id: 't1', column: 'ready' }))
    store.createTask(task({ id: 't2', column: 'done' }))
    store.createTask(task({ id: 't3', column: 'ready', archivedAt: T0 }))

    const ready = await callTool('list_tasks', { projectId: String(PROJECT), column: 'ready' })
    expect((ready.data as { id: string }[]).map((item) => item.id)).toEqual(['t1'])

    const all = await callTool('list_tasks', { includeArchived: true })
    expect(all.data).toHaveLength(3)
  })

  it('认不出来的列名当场拒绝 —— 筛成空数组会让 Agent 断定"看板是空的"', async () => {
    store.createTask(task({ id: 't1', column: 'ready' }))
    const result = await callTool('list_tasks', { column: 'todo' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('todo')
    expect(result.text).toContain('ready')
  })

  it('get_task 把关联的卡连正文一起展开 —— 只给 id 等于没给', async () => {
    store.createTask(task({ id: 't2', column: 'done', description: '统一错误码\n\n走 errors.ts' }))
    store.createTask(task({ id: 't1', relatedTo: [asTaskId('t2')] }))

    const { data } = await callTool('get_task', { taskId: 't1' })
    const detail = data as { related: { id: string; title: string; description: string; column: string }[] }
    expect(detail.related).toHaveLength(1)
    expect(detail.related[0]?.id).toBe('t2')
    expect(detail.related[0]?.column).toBe('done')
    expect(detail.related[0]?.description).toContain('走 errors.ts')
  })

  it('get_task 带上这张卡开过的 PR —— Agent 得知道自己那轮改动走到哪儿了', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    store.upsertPullRequest({
      id: 'pr-1', taskId: asTaskId('t1'), number: 7, url: 'https://example.invalid/pull/7',
      branch: 'task/t1', baseBranch: 'main', state: 'open', mergeable: 'mergeable',
      createdAt: T0, updatedAt: T0,
    })
    const { data } = await callTool('get_task', { taskId: 't1' })
    expect((data as { prs: { number: number }[] }).prs.map((pr) => pr.number)).toEqual([7])
  })

  it('没有这张卡时说清是哪一张，而不是回一个空对象', async () => {
    const result = await callTool('get_task', { taskId: 't-nope' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('t-nope')
  })

  it('参数缺了也是给 Agent 看的结果，不是协议错误', async () => {
    const result = await callTool('get_task', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('taskId')
  })
})

describe('写入', () => {
  it('create_task 落 Backlog，并能带上同项目的关联', async () => {
    store.createTask(task({ id: 't1' }))
    const { data } = await callTool('create_task', {
      projectId: String(PROJECT), description: '照着 t1 再来一张', relatedTo: ['t1'],
    })
    const created = data as { id: string; column: string; relatedTo: string[] }
    expect(created.column).toBe('backlog')
    expect(created.relatedTo).toEqual(['t1'])
  })

  it('关联跨项目会被看板挡下来，原因原样带回给 Agent', async () => {
    const other = asProjectId('p2')
    store.createProject({ id: other, name: '另一个', repoPath: '/other', baseBranch: 'main', createdAt: T0 })
    store.createTask(task({ id: 't1', column: 'backlog' }))
    store.createTask(task({ id: 'x1', column: 'backlog', projectId: other, repoPath: '/other' }))

    const result = await callTool('update_task', { taskId: 't1', relatedTo: ['x1'] })
    expect(result.isError).toBe(true)
    // 光说一句 "failed" 的话，Agent 只会原样重试。
    expect(result.text).toContain('no-such-related-task')
    expect(result.text).toContain('只能关联同项目的卡')
  })

  it('不给 expectedRevision 时按此刻的 revision 提交', async () => {
    store.createTask(task({ id: 't1', column: 'backlog', revision: 7 }))
    const { data } = await callTool('update_task', { taskId: 't1', description: '改过的需求' })
    expect((data as { revision: number }).revision).toBe(8)
  })

  it('给错 expectedRevision 就该被 CAS 挡住', async () => {
    store.createTask(task({ id: 't1', column: 'backlog', revision: 7 }))
    const result = await callTool('update_task', {
      taskId: 't1', description: 'x', expectedRevision: 3,
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('revision-conflict')
  })

  it('move_task 只在 backlog 与 ready 之间搬 —— 认领与验收都不走这儿', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))
    expect((await callTool('move_task', { taskId: 't1', to: 'ready' })).isError).toBe(false)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')

    // 领域层其实允许 ready → running（那是给认领用的入口），但从这儿搬过去
    // 会造出一张没有租约的"运行中"卡：看着在跑，实际没有任何进程，
    // 直到回收器把它拽回队列。挡在工具这一层，并且说清该用什么。
    const jump = await callTool('move_task', { taskId: 't1', to: 'running' })
    expect(jump.isError).toBe(true)
    expect(jump.text).toContain('claim_task')
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')

    const stamp = await callTool('move_task', { taskId: 't1', to: 'done' })
    expect(stamp.isError).toBe(true)
    expect(stamp.text).toContain('盖章')
  })

  it('Review 里的卡可以退回队列重做', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    expect((await callTool('move_task', { taskId: 't1', to: 'ready' })).isError).toBe(false)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
  })

  it('类型不对的参数当场拒绝，不送到服务端去炸成 500', async () => {
    store.createTask(task({ id: 't1', column: 'backlog' }))

    // 实测过的两种下场：字符串 acceptance 会让服务端 500（Agent 只看到
    // 一句"详情见运行日志"），数字 description 会被 SQLite 的 TEXT 亲和性
    // 悄悄存成 "12345.0"。两条都要在出门之前挡住。
    const listy = await callTool('update_task', { taskId: 't1', acceptance: '一条字符串' })
    expect(listy.isError).toBe(true)
    expect(listy.text).toContain('acceptance')

    const numeric = await callTool('update_task', { taskId: 't1', description: 12345 })
    expect(numeric.isError).toBe(true)
    expect(numeric.text).toContain('description')

    // 库里一个字都没动。
    const after = store.getTask(asTaskId('t1'))
    expect(after?.revision).toBe(1)
    expect(after?.description).toBe('t1 要做的事')
  })

  it('null 仍然是"清空"，缺席仍然是"这次没提到"', async () => {
    store.createTask(task({ id: 't1', column: 'backlog', preferredProvider: 'claude', model: 'opus' }))

    await callTool('update_task', { taskId: 't1', description: '换个说法' })
    expect(store.getTask(asTaskId('t1'))?.model).toBe('opus')

    await callTool('update_task', { taskId: 't1', preferredProvider: null, model: null })
    const cleared = store.getTask(asTaskId('t1'))
    expect(cleared?.preferredProvider).toBeUndefined()
    expect(cleared?.model).toBeUndefined()
  })

  it('acceptance 给空数组是合法的 —— 那是清空，不是类型错', async () => {
    store.createTask(task({ id: 't1', column: 'backlog', acceptance: ['旧判据'] }))
    const result = await callTool('update_task', { taskId: 't1', acceptance: [] })
    expect(result.isError).toBe(false)
    expect(store.getTask(asTaskId('t1'))?.acceptance).toEqual([])
  })

  it('comment_task：在 Review 里留言就是再改一版，卡回队列', async () => {
    store.createTask(task({ id: 't1', column: 'review' }))
    const { data } = await callTool('comment_task', { taskId: 't1', body: '标题被吃掉了' })
    expect((data as { requeued: boolean }).requeued).toBe(true)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('ready')
  })

  it('这个实例没有执行器时，claim_task 明说是这台看板没开执行器', async () => {
    store.createTask(task({ id: 't1', column: 'ready' }))
    const result = await callTool('claim_task', { taskId: 't1' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no-runner')
  })
})

describe('run_status', () => {
  it('把状态与事件日志一起给出，游标能接着用', async () => {
    const runId = asRunId('run-1')
    store.createTask(task({ id: 't1' }))
    store.createRun({
      id: runId, taskId: asTaskId('t1'), provider: 'claude', cliVersion: '2.1.247',
      worktreePath: '/wt', branch: 'task/t1', status: 'running', startedAt: T0,
    })
    store.appendEvent(runId, 'text', { text: '在改文件' }, T0)

    const { data } = await callTool('run_status', { runId: 'run-1' })
    const status = data as { run: { status: string }; events: unknown[]; lastSeq: number }
    expect(status.run.status).toBe('running')
    expect(status.events).toHaveLength(1)

    const next = await callTool('run_status', { runId: 'run-1', afterSeq: status.lastSeq })
    expect((next.data as { events: unknown[] }).events).toHaveLength(0)
  })
})

describe('找到正在跑的看板', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loopkanban-mcp-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** 指向本次测试那台 server 的一条地址记录。 */
  const liveEndpoint = () => ({
    url: `http://127.0.0.1:${String(server.port)}`,
    port: server.port,
    pid: process.pid,
    startedAt: T0,
  })

  it('地址从 endpoint.json 来，token 从 token 文件来', async () => {
    await writeEndpoint(dir, liveEndpoint())
    await writeFile(join(dir, 'token'), `${TOKEN}\n`, 'utf8')

    const found = await discoverBoard({ dataDir: dir })
    expect(found.baseUrl).toBe(`http://127.0.0.1:${String(server.port)}`)
    // 真的连得上才算数：地址文件只是线索，进程可能早就没了。
    const { projects } = await found.get<{ projects: unknown[] }>('/api/state')
    expect(projects).toHaveLength(1)
  })

  it('没有地址文件时，报的是"看板没在跑"而不是一句连接失败', async () => {
    await expect(discoverBoard({ dataDir: dir })).rejects.toThrow(/看板没在跑/)
  })

  it('有地址没 token 时，说清楚缺的是 token', async () => {
    await writeEndpoint(dir, { ...liveEndpoint(), url: 'http://127.0.0.1:1', port: 1 })
    await expect(discoverBoard({ dataDir: dir })).rejects.toThrow(/token/)
  })

  it('连不上时的错误里带着地址，并告诉人去起看板', async () => {
    await writeFile(join(dir, 'token'), TOKEN, 'utf8')
    await expect(discoverBoard({ dataDir: dir, url: 'http://127.0.0.1:1' }))
      .rejects.toThrow(/127\.0\.0\.1:1[\s\S]*loopkanban/)
  })

  it('写下地址的那个进程已经不在时，连都不连 —— 那条记录是崩溃留下的', async () => {
    await writeFile(join(dir, 'token'), TOKEN, 'utf8')
    // 一个几乎不可能存在的 pid。真被占用了这条断言会松掉，但不会误报。
    await writeEndpoint(dir, { ...liveEndpoint(), pid: 0x7ffffff0 })
    await expect(discoverBoard({ dataDir: dir })).rejects.toThrow(/已经不在了/)
  })

  it('端口上应答的不是看板时，token 一个字都不发', async () => {
    await writeFile(join(dir, 'token'), TOKEN, 'utf8')
    await writeEndpoint(dir, liveEndpoint())

    // 冒名顶替者：什么请求都回 200。看板在没有 token 时只会回 401
    // missing-token，所以这一位露馅。
    const seen: string[] = []
    const impostor = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const http = createHttpServer((req, res) => {
        seen.push(String(req.headers.cookie ?? ''))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"hello":"i am not loopkanban"}')
      })
      http.listen(0, '127.0.0.1', () => {
        resolve({
          port: (http.address() as AddressInfo).port,
          close: () => new Promise((done) => { http.close(() => { done() }) }),
        })
      })
    })
    try {
      await expect(discoverBoard({ dataDir: dir, url: `http://127.0.0.1:${String(impostor.port)}` }))
        .rejects.toThrow(/不是 LoopKanban/)
      // **这一条才是重点**：它收到过一次问话，但那次问话不带 token。
      expect(seen).toHaveLength(1)
      expect(seen[0]).not.toContain(TOKEN)
    } finally {
      await impostor.close()
    }
  })
})
