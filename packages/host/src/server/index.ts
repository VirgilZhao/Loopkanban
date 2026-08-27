/**
 * 本地 HTTP server：REST + SSE。
 *
 * 安全前提（见 `auth.ts`）：只 bind `127.0.0.1`、随机端口、一次性 token、
 * 校验 Host/Origin 防 DNS rebinding。远程访问走 SSH 端口转发。
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { asRunId, asTaskId, moveTask, type Column, type Task } from '@openkanban/core'
import type { Storage } from '../storage/index.ts'
import { createToken, guardRequest, tokenCookieHeader } from './auth.ts'
import { RunBus } from './bus.ts'

/** 只监听回环地址。**绝不 `0.0.0.0`** —— 那等于把执行任意代码的接口挂到局域网。 */
const LOOPBACK = '127.0.0.1'

/**
 * SSE 心跳间隔。除了穿过代理，它还是**发现对端已断开的主要手段** ——
 * 浏览器关掉标签页时，服务端往往要等到下一次写入失败才知道。间隔越长，
 * 死连接占着订阅的时间越久。
 */
const DEFAULT_SSE_HEARTBEAT_MS = 20_000

export interface ServerOptions {
  readonly storage: Storage
  readonly bus?: RunBus
  /** 0 表示由系统分配随机端口（默认）。 */
  readonly port?: number
  /** 供测试注入固定 token。 */
  readonly token?: string
  /** SSE 心跳间隔，同时决定发现死连接的最长延迟。 */
  readonly sseHeartbeatMs?: number
}

export interface RunningServer {
  readonly url: string
  readonly token: string
  readonly port: number
  readonly bus: RunBus
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // 本地接口不该被任何缓存层留存。
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** 从路径里取出形如 `/api/runs/<id>/events` 的片段。 */
function matchPath(pathname: string, pattern: RegExp): string | null {
  return pattern.exec(pathname)?.[1] ?? null
}

/**
 * 起 server。
 * @param options - 存储、可选端口与 token。
 * @returns 运行中的 server 句柄，含带 token 的访问 URL。
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { storage } = options
  const token = options.token ?? createToken()
  const bus = options.bus ?? new RunBus()
  const heartbeatMs = options.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS

  const server: Server = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: '内部错误', detail: error instanceof Error ? error.message : String(error) })
      } else {
        res.end()
      }
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port
    const guard = guardRequest(req, { token, port })
    if (!guard.ok) {
      sendJson(res, guard.status, { error: guard.reason, detail: guard.detail })
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? LOOPBACK}`)
    const { pathname } = url
    const method = req.method ?? 'GET'

    // 首次带 token 访问后转存 cookie，之后 URL 里就不必再带它。
    const extraHeaders = url.searchParams.has('token')
      ? { 'set-cookie': tokenCookieHeader(token) }
      : {}

    // ── 看板状态 ─────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/state') {
      sendJson(res, 200, {
        boards: storage.listBoards(),
        tasks: storage.listTasks(),
      }, extraHeaders)
      return
    }

    // ── 移动任务（CAS）──────────────────────────────────────
    const moveId = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/move$/)
    if (method === 'POST' && moveId !== null) {
      const body = await readJsonBody(req) as
        { expectedRevision?: number; to?: Column; position?: number } | undefined
      const task = storage.getTask(asTaskId(decodeURIComponent(moveId)))
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      if (body?.expectedRevision === undefined || body.to === undefined) {
        sendJson(res, 400, { error: 'bad-request', detail: '需要 expectedRevision 与 to' })
        return
      }

      const moved = moveTask(task, {
        expectedRevision: body.expectedRevision,
        to: body.to,
        ...(body.position === undefined ? {} : { position: body.position }),
        now: Date.now(),
      })
      if (!moved.ok) {
        // 409 表达"你读到的不是最新的"，客户端应重读后重试。
        sendJson(res, moved.reason === 'revision-conflict' ? 409 : 422, {
          error: moved.reason, detail: moved.detail,
        })
        return
      }
      if (!storage.commitTask(moved.value)) {
        sendJson(res, 409, { error: 'revision-conflict', detail: '提交时已被他人改动，请重读后重试' })
        return
      }
      sendJson(res, 200, { task: moved.value }, extraHeaders)
      return
    }

    // ── Run 详情 ────────────────────────────────────────────
    const runId = matchPath(pathname, /^\/api\/runs\/([^/]+)$/)
    if (method === 'GET' && runId !== null) {
      const run = storage.getRun(asRunId(decodeURIComponent(runId)))
      if (run === null) { sendJson(res, 404, { error: 'run-not-found' }); return }
      sendJson(res, 200, { run }, extraHeaders)
      return
    }

    // ── 事件流（SSE）────────────────────────────────────────
    const streamId = matchPath(pathname, /^\/api\/runs\/([^/]+)\/events$/)
    if (method === 'GET' && streamId !== null) {
      streamRunEvents(req, res, asRunId(decodeURIComponent(streamId)))
      return
    }

    sendJson(res, 404, { error: 'not-found', detail: pathname })
  }

  function streamRunEvents(req: IncomingMessage, res: ServerResponse, id: ReturnType<typeof asRunId>): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // 关掉中间层缓冲，否则事件会被攒着不发。
      'x-accel-buffering': 'no',
    })

    // 断线重连时浏览器会带上 Last-Event-ID，从那之后补齐即可，不必重传全部历史。
    const lastHeader = req.headers['last-event-id']
    const lastSeq = typeof lastHeader === 'string' ? Number.parseInt(lastHeader, 10) : 0
    let cursor = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0

    const write = (seq: number, kind: string, payload: unknown): void => {
      cursor = Math.max(cursor, seq)
      res.write(`id: ${String(seq)}\nevent: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    // 先补历史，再接实时 —— 顺序反过来会漏掉这中间产生的事件。
    for (const event of storage.readEvents(id, cursor)) write(event.seq, event.kind, event.payload)

    const unsubscribe = bus.subscribe(id, (event) => {
      if (event.seq > cursor) write(event.seq, event.kind, event.payload)
    })

    const heartbeat = setInterval(() => { res.write(': ping\n\n') }, heartbeatMs)
    // 心跳不该拖住进程退出。
    heartbeat.unref()
    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  await new Promise<void>((resolve) => { server.listen(options.port ?? 0, LOOPBACK, resolve) })
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://${LOOPBACK}:${String(port)}/?token=${token}`,
    token,
    port,
    bus,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { error === undefined ? resolve() : reject(error) })
      server.closeAllConnections()
    }),
  }
}

export { RunBus } from './bus.ts'
export * from './auth.ts'
