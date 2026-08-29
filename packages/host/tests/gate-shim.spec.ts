import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { handleMessage } from '../src/mcp/gate-shim.mjs'

/**
 * 起一个模拟宿主的 HTTP server：实现 shim 需要的两条路由
 * （创建决策、查询决策）。决策的收场由测试自己控制 —— 想让它等人就晚点
 * 写终态，想让它超时就永远不写。
 */
function fakeHost(): {
  server: Server
  port: Promise<number>
  /** 测试登记"哪个决策何时以何状态收场"。不登记的决策永远 pending。 */
  resolve: (id: string, status: string, answer?: unknown) => void
  requests: { path: string; body: unknown }[]
} {
  const resolutions = new Map<string, { status: string; answer?: unknown }>()
  const requests: { path: string; body: unknown }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      requests.push({ path: req.url ?? '', body: raw.length === 0 ? undefined : JSON.parse(raw) })
      const auth = req.headers.authorization ?? ''
      if (!auth.startsWith('Bearer gate-token')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing-token', detail: '缺少访问 token' }))
        return
      }
      const created = /^\/api\/runs\/run-1\/decisions$/.exec(req.url ?? '')
      if (created !== null && req.method === 'POST') {
        const id = `dec-${String(requests.length).padStart(8, '0')}`
        resolutions.set(id, { status: 'pending' })
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decision: { id, status: 'pending', ...(JSON.parse(raw) as object) } }))
        return
      }
      const polled = /^\/api\/runs\/run-1\/decisions\/(dec-\d+)$/.exec(req.url ?? '')
      if (polled !== null && req.method === 'GET') {
        const id = polled[1] as string
        const at = resolutions.get(id) ?? { status: 'pending' }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decision: { id, status: at.status, ...(at.answer === undefined ? {} : { answer: at.answer }) } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not-found', detail: req.url }))
    })
  })
  const port = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port)
    })
  })
  return {
    server, port, requests,
    resolve: (id, status, answer) => { resolutions.set(id, { status, answer }) },
  }
}

let host: ReturnType<typeof fakeHost>
let config: { baseUrl: string; runId: string; token: string; timeoutMs: number }

beforeEach(async () => {
  host = fakeHost()
  config = {
    baseUrl: `http://127.0.0.1:${String(await host.port)}`,
    runId: 'run-1',
    token: 'gate-token',
    timeoutMs: 5_000,
  }
})

afterEach(async () => {
  await new Promise<void>((resolve) => { host.server.close(() => { resolve() }) })
})

/** 把一次 handleMessage 调用按 JSON-RPC 帧包起来。 */
const rpc = async (method: string, params?: object, id: unknown = 1): Promise<Record<string, unknown>> => {
  const response = await handleMessage(config, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
  return response as Record<string, unknown>
}

describe('gate shim 协议层', () => {
  it('initialize 回协议版本与 serverInfo', async () => {
    const response = await rpc('initialize', { protocolVersion: '2025-06-18' })
    const result = response['result'] as Record<string, unknown>
    expect(result['protocolVersion']).toBe('2025-06-18')
    expect(result['capabilities']).toEqual({ tools: {} })
  })

  it('tools/list 给出 ask_user 与 request_permission', async () => {
    const { result } = await rpc('tools/list') as { result: { tools: { name: string }[] } }
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['ask_user', 'request_permission'])
  })

  it('通知（没有 id）不回帧', async () => {
    const response = await handleMessage(config, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(response).toBeNull()
  })

  it('未知方法回 error 帧', async () => {
    const response = await rpc('resources/list')
    expect((response['error'] as { code: number }).code).toBe(-32601)
  })

  it('坏参数（缺 question）回 error 帧而不是崩掉', async () => {
    const response = await rpc('tools/call', { name: 'ask_user', arguments: {} })
    expect(response['error']).toBeDefined()
  })

  it('没有凭据时宿主拒绝，工具调用收到 error 帧', async () => {
    const bad = { ...config, token: 'wrong-token' }
    const response = await handleMessage(bad, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'ask_user', arguments: { question: 'q' } },
    }) as Record<string, unknown>
    expect((response['error'] as { message: string }).message).toContain('token')
  })
})

describe('gate shim ask_user', () => {
  it('创建提问、轮询到回答、把文本作为工具结果返回', async () => {
    // shim 只有拿到创建响应里的 id 之后才会开始轮询，所以从轮询路径上
    // 抓到 id 就说明创建成功了 —— 此时放行。
    const watcher = setInterval(() => {
      for (const request of host.requests) {
        const match = /\/decisions\/(dec-\d+)$/.exec(request.path)
        if (match !== null) {
          clearInterval(watcher)
          host.resolve(match[1] as string, 'answered', { text: '用 A 方案' })
        }
      }
    }, 30)

    const response = await rpc('tools/call', { name: 'ask_user', arguments: { question: '用哪个方案？' } })
    const result = response['result'] as { content: { text: string }[]; isError?: boolean }
    expect(result.content[0]?.text).toBe('用 A 方案')
    // 创建请求带的负载形状要对。
    const create = host.requests.find((request) => request.path.endsWith('/decisions'))
    expect((create?.body as Record<string, unknown>)['kind']).toBe('question')
    expect((create?.body as Record<string, unknown>)['payload']).toEqual({ question: '用哪个方案？' })
  }, 10_000)
})

describe('gate shim request_permission', () => {
  it('放行时按契约回 allow + 原参数', async () => {
    const watcher = setInterval(() => {
      for (const request of host.requests) {
        const match = /\/decisions\/(dec-\d+)$/.exec(request.path)
        if (match !== null) {
          clearInterval(watcher)
          host.resolve(match[1] as string, 'allowed', { decision: 'allow' })
        }
      }
    }, 30)

    const args = { tool_name: 'Bash', input: { command: 'npm test' } }
    const response = await rpc('tools/call', { name: 'request_permission', arguments: args })
    const result = response['result'] as { content: { text: string }[] }
    const verdict = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>
    expect(verdict['behavior']).toBe('allow')
    expect(verdict['updatedInput']).toEqual({ command: 'npm test' })
  }, 10_000)

  it('拒绝时回 deny + 理由', async () => {
    const watcher = setInterval(() => {
      for (const request of host.requests) {
        const match = /\/decisions\/(dec-\d+)$/.exec(request.path)
        if (match !== null) {
          clearInterval(watcher)
          host.resolve(match[1] as string, 'denied', { decision: 'deny', message: '不要跑这个' })
        }
      }
    }, 30)

    const response = await rpc('tools/call', {
      name: 'request_permission', arguments: { tool_name: 'Bash', input: {} },
    })
    const result = response['result'] as { content: { text: string }[] }
    const verdict = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>
    expect(verdict['behavior']).toBe('deny')
    expect(verdict['message']).toBe('不要跑这个')
  }, 10_000)
})
