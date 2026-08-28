/**
 * 本地 HTTP server：REST + SSE。
 *
 * 安全前提（见 `auth.ts`）：只 bind `127.0.0.1`、随机端口、一次性 token、
 * 校验 Host/Origin 防 DNS rebinding。远程访问走 SSH 端口转发。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  createServer as createHttpServer, request as httpRequest,
  type IncomingMessage, type Server, type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { extname, isAbsolute, join, normalize, relative, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  archiveTask, asProjectId, asRunId, asTaskId, deleteTask, dropDependency, editTask, moveTask,
  unarchiveTask, type Column, type Task, type TaskEdit,
} from '@loopkanban/core'
import type { DetectedAgent } from '../agents/index.ts'
import type { Review } from '../review/index.ts'
import type { Runner } from '../runner/index.ts'
import type { Scheduler } from '../scheduler/index.ts'
import type { Storage } from '../storage/index.ts'
import { detectBaseBranch, isGitRepo } from '../worktree/index.ts'
import { createToken, guardRequest, tokenCookieHeader } from './auth.ts'
import { browseDirectory, defaultBrowseRoot } from './browse.ts'
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
  /** 本机探测到的 Agent CLI。UI 只允许在这些里面选。 */
  readonly agents?: readonly DetectedAgent[]
  /** 执行器。不给则只能看板，不能真正派活。 */
  readonly runner?: Runner
  /** 验收器。不给则不能通过/打回/废弃。 */
  readonly review?: Review
  /** 自动认领调度器。不给则界面上没有自动驾驶开关。 */
  readonly scheduler?: Scheduler
  readonly bus?: RunBus
  /** 0 表示由系统分配随机端口（默认）。 */
  readonly port?: number
  /** 供测试注入固定 token。 */
  readonly token?: string
  /** SSE 心跳间隔，同时决定发现死连接的最长延迟。 */
  readonly sseHeartbeatMs?: number
  /** 前端构建产物目录；不给则只提供 API。 */
  readonly staticDir?: string
  /**
   * 开发模式下 vite 的地址，例如 `http://127.0.0.1:5273`。给了就**优先于
   * `staticDir`**：非 `/api` 的请求（含 HMR 的 WebSocket 升级）原样转发过去。
   *
   * 为什么要绕这一道，而不是让浏览器直接开 vite 的端口：token 是 httpOnly
   * cookie，而 cookie 不区分端口但请求要同源才带得干净；走同一个 origin，
   * 开发时的鉴权路径与发布后完全一致，不必为 dev 开后门。
   */
  readonly devServer?: string
}

export interface RunningServer {
  readonly url: string
  readonly token: string
  readonly port: number
  readonly bus: RunBus
  close(): Promise<void>
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
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

/** 客户端输入有问题，不是服务端故障 —— 用它和内部异常区分开。 */
export class BadRequestError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'BadRequestError'
  }
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new BadRequestError('请求体过大')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    // 客户端发了坏 JSON 是 400，不是 500 —— 报成 500 会把调用方的输入问题
    // 伪装成服务端故障，前端也没法据此给出可操作的提示。
    throw new BadRequestError('请求体不是合法的 JSON')
  }
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
  const agents = options.agents ?? []
  const runner = options.runner
  const review = options.review
  const scheduler = options.scheduler
  const staticDir = options.staticDir === undefined ? undefined : resolvePath(options.staticDir)
  const devServer = options.devServer === undefined ? undefined : new URL(options.devServer)

  const server: Server = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.end(); return }
      if (error instanceof BadRequestError) {
        sendJson(res, 400, { error: 'bad-request', detail: error.message })
        return
      }
      // 内部异常的原文可能带着文件路径等细节，只写进日志，不回给调用方。
      console.error('[loopkanban] 未处理的请求异常:', error)
      sendJson(res, 500, { error: 'internal-error', detail: '服务端处理这次请求时出错，详情见运行日志' })
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
      const tasks = storage.listTasks()
      // 运行中的卡各捎一条最新事件，看板据此在卡上显示一行日志预览 ——
      // 不然关着详情弹窗就完全看不出 Agent 正在干什么。
      const live: Record<string, { kind: string; payload: unknown; at: number }> = {}
      for (const task of tasks) {
        const runId = task.lease?.runId
        if (task.column !== 'running' || runId === undefined) continue
        const event = storage.lastEvent(runId)
        if (event !== null) live[task.id] = { kind: event.kind, payload: event.payload, at: event.at }
      }
      sendJson(res, 200, { projects: storage.listProjects(), tasks, live }, extraHeaders)
      return
    }

    // ── 本机目录浏览：新增项目时选文件夹用 ───────────────────
    if (method === 'GET' && pathname === '/api/fs') {
      const asked = url.searchParams.get('path')
      const target = asked === null || asked.trim().length === 0 ? defaultBrowseRoot() : asked
      if (!isAbsolute(target)) {
        sendJson(res, 422, { error: 'path-not-absolute', detail: '要绝对路径' })
        return
      }
      try {
        sendJson(res, 200, await browseDirectory(target), extraHeaders)
      } catch {
        // 不存在、不是目录、没权限 —— 对调用方是同一件事：这儿看不了。
        sendJson(res, 404, { error: 'no-such-dir', detail: `打不开 ${target}` })
      }
      return
    }

    // ── 项目：列出与新增 ─────────────────────────────────────
    if (pathname === '/api/projects') {
      if (method === 'GET') {
        sendJson(res, 200, { projects: storage.listProjects() }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as Partial<{ name: string; path: string }> | undefined
        const name = body?.name?.trim() ?? ''
        const raw = body?.path?.trim() ?? ''
        if (name.length === 0 || raw.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '需要项目名称与目录' })
          return
        }
        if (!isAbsolute(raw)) {
          sendJson(res, 422, { error: 'path-not-absolute', detail: '项目目录要给绝对路径' })
          return
        }
        const repoPath = resolvePath(raw)
        // 必须是 git 仓库：任务在它派生的 worktree 上干活，不是仓库就无从派生。
        if (!(await isGitRepo(repoPath))) {
          sendJson(res, 422, { error: 'not-a-repo', detail: `${repoPath} 不是一个 git 仓库` })
          return
        }
        const baseBranch = await detectBaseBranch(repoPath)
        if (storage.listProjects().some((project) => project.repoPath === repoPath)) {
          sendJson(res, 409, { error: 'project-exists', detail: '这个目录已经是一个项目了' })
          return
        }
        const project = {
          id: asProjectId(`p-${randomUUID().slice(0, 8)}`),
          name,
          repoPath,
          baseBranch,
          createdAt: Date.now(),
        }
        storage.createProject(project)
        sendJson(res, 201, { project }, extraHeaders)
        return
      }
    }

    // ── 已探测到的 Agent ────────────────────────────────────
    if (method === 'GET' && pathname === '/api/agents') {
      // 只暴露能力事实，不暴露 help 原文这类噪音。
      sendJson(res, 200, {
        agents: agents.map(({ provider, caps }) => ({
          id: provider.id,
          bin: caps.bin,
          version: caps.version,
          streaming: caps.streaming,
          canPinSessionId: caps.canPinSessionId,
          canResume: caps.canResume,
          canPickModel: caps.canPickModel,
          // 探测到的模型清单。空数组表示这个 CLI 没法枚举，界面据此退回自由输入。
          models: caps.models,
          permissionTiers: caps.permissionTiers,
          // 档位名字对不上实际约束时的警示，UI 有义务展示 —— 不能吞掉。
          ...(caps.permissionCaveat === undefined ? {} : { permissionCaveat: caps.permissionCaveat }),
        })),
      }, extraHeaders)
      return
    }

    // ── 统计 ────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/stats') {
      sendJson(res, 200, storage.stats(), extraHeaders)
      return
    }

    // ── 自动驾驶：状态与设置 ─────────────────────────────────
    if (pathname === '/api/scheduler') {
      if (scheduler === undefined) { sendJson(res, 503, { error: 'no-scheduler' }); return }
      if (method === 'GET') {
        sendJson(res, 200, scheduler.state(), extraHeaders)
        return
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req) as
          { autopilot?: boolean; maxConcurrent?: number; maxPerRepo?: number } | undefined
        const settings = scheduler.updateSettings(body ?? {})
        // 立刻跑一轮，让开关点下去马上有反应，而不是等下一个节拍。
        // tick() 会排在进行中的那一轮之后，所以这里拿到的一定是**新设置下**
        // 的结果，而不是上一轮的陈旧报告。
        const lastTick = await scheduler.tick()
        sendJson(res, 200, { settings, lastTick }, extraHeaders)
        return
      }
    }

    // ── 改项目名 ────────────────────────────────────────────
    const projectId = matchPath(pathname, /^\/api\/projects\/([^/]+)$/)
    if (method === 'PATCH' && projectId !== null) {
      const target = asProjectId(decodeURIComponent(projectId))
      const body = await readJsonBody(req) as Partial<{ name: string }> | undefined
      const name = body?.name?.trim() ?? ''
      if (name.length === 0) {
        sendJson(res, 400, { error: 'bad-request', detail: '项目名不能为空' })
        return
      }
      if (!storage.renameProject(target, name)) {
        sendJson(res, 404, { error: 'project-not-found' })
        return
      }
      sendJson(res, 200, { project: storage.getProject(target) }, extraHeaders)
      return
    }

    // ── 删除项目 ────────────────────────────────────────────
    if (method === 'DELETE' && projectId !== null) {
      const target = asProjectId(decodeURIComponent(projectId))
      const project = storage.getProject(target)
      if (project === null) { sendJson(res, 404, { error: 'project-not-found' }); return }

      const tasks = storage.listTasks(target)
      // 正在跑的卡意味着有个活着的进程正在改这个仓库。把它的账本抽走，
      // 那个进程会继续跑到没人认识它 —— 先停下来，再删。
      const running = tasks.filter((task) => task.column === 'running')
      if (running.length > 0) {
        sendJson(res, 422, {
          error: 'project-busy',
          detail: `还有 ${String(running.length)} 张卡在执行，先终止它们`,
        })
        return
      }

      // Run 要在删库之前读出来 —— 删完就查不到该收拾哪些 worktree 了。
      const runsOfTask = new Map(tasks.map((task) => [task.id, storage.listRuns(task.id)]))
      if (!storage.deleteProject(target)) {
        sendJson(res, 404, { error: 'project-not-found' })
        return
      }
      // 同 accept / discard / 删卡：状态先落定，不可逆的删除在后。
      // 收拾的只是我们自己建的 worktree 与任务分支，仓库本身一个字不动。
      if (review !== undefined) {
        for (const task of tasks) await review.purge(task, runsOfTask.get(task.id) ?? [])
      }
      sendJson(res, 200, { deleted: true, tasks: tasks.length }, extraHeaders)
      return
    }

    // ── 新建任务 ────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/tasks') {
      const body = await readJsonBody(req) as Partial<{
        projectId: string; description: string; acceptance: string[]
        preferredProvider: string; model: string
      }> | undefined
      // 仓库与基线跟着项目走，不由建卡方指定 —— 任务干活的地方是这个项目
      // 派生出来的 worktree，两者对不上就没有意义。
      const projects = storage.listProjects()
      const project = projects.find((p) => p.id === body?.projectId) ?? projects[0]
      if (project === undefined) { sendJson(res, 400, { error: 'no-project' }); return }

      const now = Date.now()
      const tasks = storage.listTasks(project.id)
      const created: Task = {
        id: asTaskId(`t-${randomUUID().slice(0, 8)}`),
        projectId: project.id,
        revision: 1,
        // 新卡一律先落 backlog：验收标准没写全就不该进队列。
        column: 'backlog',
        position: Math.max(0, ...tasks.map((t) => t.position)) + 1,
        // 建一张空白卡是正常的：先落地，再在弹窗里慢慢写。
        description: body?.description ?? '',
        acceptance: (body?.acceptance ?? []).filter((a) => a.trim().length > 0),
        repoPath: project.repoPath,
        baseBranch: project.baseBranch,
        ...(body?.preferredProvider === undefined ? {} : { preferredProvider: body.preferredProvider }),
        ...(body?.model === undefined ? {} : { model: body.model }),
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      }
      storage.createTask(created)
      sendJson(res, 201, { task: created }, extraHeaders)
      return
    }

    // ── 讨论：读线程 / 留一条 ───────────────────────────────
    const commentsOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/comments$/)
    if (commentsOf !== null) {
      const taskId = asTaskId(decodeURIComponent(commentsOf))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }

      if (method === 'GET') {
        sendJson(res, 200, { comments: storage.listComments(taskId) }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as Partial<{ body: string }> | undefined
        const text = body?.body?.trim() ?? ''
        if (text.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '留言不能为空' })
          return
        }
        storage.addComment({
          id: `c-${randomUUID().slice(0, 8)}`,
          taskId,
          author: 'human',
          body: text,
          at: Date.now(),
        })
        // 在 Review 里留言就是"再改一版"：卡自动回队列，下一次执行带着
        // 整条讨论走。别的列只是留个话，不动卡的位置。
        let moved = false
        if (task.column === 'review') {
          const next = moveTask(task, { expectedRevision: task.revision, to: 'ready', now: Date.now() })
          if (next.ok) moved = storage.commitTask(next.value)
        }
        sendJson(res, 201, { comments: storage.listComments(taskId), requeued: moved }, extraHeaders)
        return
      }
    }

    // ── 某任务的 Run 列表 ───────────────────────────────────
    const runsOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/runs$/)
    if (method === 'GET' && runsOf !== null) {
      sendJson(res, 200, { runs: storage.listRuns(asTaskId(decodeURIComponent(runsOf))) }, extraHeaders)
      return
    }

    // ── 编辑任务（CAS）──────────────────────────────────────
    const editId = /^\/api\/tasks\/([^/]+)$/.exec(pathname)?.[1]
    if (method === 'PATCH' && editId !== undefined) {
      const task = storage.getTask(asTaskId(decodeURIComponent(editId)))
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      const body = await readJsonBody(req) as
        ({ expectedRevision?: number } & Record<string, unknown>) | undefined
      if (body?.expectedRevision === undefined) {
        sendJson(res, 400, { error: 'bad-request', detail: '需要 expectedRevision' })
        return
      }
      const { expectedRevision, ...rest } = body
      // null 意为"清空这个字段"。字段缺席只意味着"这次没提到它"，两者不能混为
      // 一谈 —— JSON 里没有 undefined，客户端要清空只能显式送 null。
      const edit = Object.fromEntries(
        Object.entries(rest).map(([key, value]) => [key, value === null ? undefined : value]),
      ) as TaskEdit
      const edited = editTask(task, { expectedRevision, edit, now: Date.now() })
      if (!edited.ok) {
        sendJson(res, edited.reason === 'revision-conflict' ? 409 : 422, {
          error: edited.reason, detail: edited.detail,
        })
        return
      }
      if (!storage.commitTask(edited.value)) {
        sendJson(res, 409, { error: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' })
        return
      }
      sendJson(res, 200, { task: edited.value }, extraHeaders)
      return
    }

    // ── 删除任务（CAS）──────────────────────────────────────
    if (method === 'DELETE' && editId !== undefined) {
      const taskId = asTaskId(decodeURIComponent(editId))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      const body = await readJsonBody(req) as { expectedRevision?: number } | undefined
      // DELETE 带请求体不是所有客户端都方便，查询串是等价的入口（curl 用得上）。
      const fromQuery = Number.parseInt(url.searchParams.get('expectedRevision') ?? '', 10)
      const expectedRevision = body?.expectedRevision ?? (Number.isFinite(fromQuery) ? fromQuery : undefined)
      if (expectedRevision === undefined) {
        sendJson(res, 400, { error: 'bad-request', detail: '需要 expectedRevision' })
        return
      }
      const verdict = deleteTask(task, { expectedRevision })
      if (!verdict.ok) {
        sendJson(res, verdict.reason === 'revision-conflict' ? 409 : 422, {
          error: verdict.reason, detail: verdict.detail,
        })
        return
      }

      // 下游对它的依赖要一并摘掉：留着一个查无此卡的 id，那些卡会永远停在
      // "依赖未完成"，而界面上没有任何操作能解开它。
      const now = Date.now()
      const cascade = storage.listTasks(task.projectId)
        .filter((other) => other.id !== task.id)
        .map((other) => dropDependency(other, task.id, now))
        .filter((next): next is Task => next !== null)
      // Run 要在删库之前读出来 —— 删完就查不到该收拾哪些 worktree 了。
      const runs = storage.listRuns(task.id)

      if (!storage.deleteTask(task.id, expectedRevision, cascade)) {
        sendJson(res, 409, { error: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' })
        return
      }
      // 同 accept / discard：状态先落定，不可逆的删除在后。反过来的话一次
      // CAS 冲突就会留下"worktree 没了、卡还在"的残局。
      if (review !== undefined) await review.purge(task, runs)
      sendJson(res, 200, { deleted: true, unblocked: cascade.map((t) => t.id) }, extraHeaders)
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

    // ── 归档 / 取消归档（CAS）───────────────────────────────
    const shelf = /^\/api\/tasks\/([^/]+)\/(archive|unarchive)$/.exec(pathname)
    if (method === 'POST' && shelf !== null) {
      const task = storage.getTask(asTaskId(decodeURIComponent(shelf[1] as string)))
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      const body = await readJsonBody(req) as { expectedRevision?: number } | undefined
      if (body?.expectedRevision === undefined) {
        sendJson(res, 400, { error: 'bad-request', detail: '需要 expectedRevision' })
        return
      }

      const apply = shelf[2] === 'archive' ? archiveTask : unarchiveTask
      const next = apply(task, { expectedRevision: body.expectedRevision, now: Date.now() })
      if (!next.ok) {
        sendJson(res, next.reason === 'revision-conflict' ? 409 : 422, {
          error: next.reason, detail: next.detail,
        })
        return
      }
      if (!storage.commitTask(next.value)) {
        sendJson(res, 409, { error: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' })
        return
      }
      sendJson(res, 200, { task: next.value }, extraHeaders)
      return
    }

    // ── 派活 ────────────────────────────────────────────────
    const runTarget = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/run$/)
    if (method === 'POST' && runTarget !== null) {
      if (runner === undefined) {
        sendJson(res, 503, { error: 'no-runner', detail: '当前实例未启用执行器' })
        return
      }
      const body = await readJsonBody(req) as { provider?: string } | undefined
      const result = await runner.start(asTaskId(decodeURIComponent(runTarget)), body?.provider)
      if (!result.ok) {
        // 422 表达"这个请求本身不成立"，重试也没用；409 才是"重读后再试"。
        sendJson(res, result.reason === 'revision-conflict' ? 409 : 422, {
          error: result.reason, detail: result.detail,
        })
        return
      }
      sendJson(res, 202, { run: result.run }, extraHeaders)
      return
    }

    // ── 验收：看 diff ───────────────────────────────────────
    const diffOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/diff$/)
    if (method === 'GET' && diffOf !== null) {
      if (review === undefined) { sendJson(res, 503, { error: 'no-review' }); return }
      const view = await review.diff(asTaskId(decodeURIComponent(diffOf)))
      if (view === null) { sendJson(res, 404, { error: 'no-run', detail: '这张卡还没有执行记录' }); return }
      sendJson(res, 200, { diff: view }, extraHeaders)
      return
    }

    // ── 验收：通过 / 废弃 ───────────────────────────────────
    const verdict = /^\/api\/tasks\/([^/]+)\/(accept|discard)$/.exec(pathname)
    if (method === 'POST' && verdict !== null) {
      if (review === undefined) { sendJson(res, 503, { error: 'no-review' }); return }
      const taskId = asTaskId(decodeURIComponent(verdict[1] as string))
      const body = await readJsonBody(req) as { merge?: boolean } | undefined

      const result = verdict[2] === 'accept'
        ? await review.accept(taskId, body?.merge === true)
        : await review.discard(taskId)

      if (!result.ok) {
        sendJson(res, result.reason === 'revision-conflict' ? 409 : 422, {
          error: result.reason, detail: result.detail,
        })
        return
      }
      sendJson(res, 200, result, extraHeaders)
      return
    }

    // ── 取消执行 ────────────────────────────────────────────
    const cancelTarget = matchPath(pathname, /^\/api\/runs\/([^/]+)\/cancel$/)
    if (method === 'POST' && cancelTarget !== null) {
      if (runner === undefined) { sendJson(res, 503, { error: 'no-runner' }); return }
      const stopped = await runner.cancel(asRunId(decodeURIComponent(cancelTarget)))
      sendJson(res, stopped ? 202 : 404, { stopped }, extraHeaders)
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

    // ── 前端：开发时转发给 vite，否则托管构建产物 ─────────────
    if (!pathname.startsWith('/api/')) {
      if (devServer !== undefined) { proxyToDev(devServer, req, res, extraHeaders); return }
      if (method === 'GET' && staticDir !== undefined) {
        if (await serveStatic(staticDir, pathname, res, extraHeaders)) return
      }
    }

    sendJson(res, 404, { error: 'not-found', detail: pathname })
  }

  /**
   * 把一个普通请求整个转给 vite。
   *
   * 刻意不改写 body、不缓存：dev server 自己会处理 304 与模块图，
   * 这里多做一层只会让"改了文件页面没变"重新变得可能。
   */
  function proxyToDev(
    target: URL,
    req: IncomingMessage,
    res: ServerResponse,
    extraHeaders: Record<string, string>,
  ): void {
    const upstream = httpRequest({
      host: target.hostname,
      port: target.port,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers: { ...req.headers, host: target.host },
    }, (proxied) => {
      res.writeHead(proxied.statusCode ?? 502, { ...proxied.headers, ...extraHeaders })
      proxied.pipe(res)
    })
    upstream.on('error', (error: unknown) => {
      if (res.headersSent) { res.destroy(); return }
      // vite 还没起来或者已经退出。说清楚是哪一环，不然只看到一个白页。
      sendJson(res, 502, {
        error: 'dev-server-unreachable',
        detail: `连不上前端 dev server ${target.origin}：${error instanceof Error ? error.message : String(error)}`,
      })
    })
    req.pipe(upstream)
  }

  // HMR 的 WebSocket 也得从这个端口走 —— 少了它，页面能开但改代码不会刷新，
  // 而浏览器控制台里只留下一句 vite 连不上的报错，很难往这边想。
  if (devServer !== undefined) {
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const port = (server.address() as AddressInfo).port
      if (!guardRequest(req, { token, port, cookieOnly: true }).ok) { socket.destroy(); return }

      const upstream = httpRequest({
        host: devServer.hostname,
        port: devServer.port,
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        headers: { ...req.headers, host: devServer.host },
      })
      upstream.on('upgrade', (proxied, upSocket, upHead) => {
        const headers = Object.entries(proxied.headers)
          .flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => `${key}: ${v}`) : [`${key}: ${String(value)}`]))
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`)
        if (upHead.length > 0) socket.write(upHead)
        if (head.length > 0) upSocket.write(head)
        upSocket.pipe(socket).pipe(upSocket)
        upSocket.on('error', () => { socket.destroy() })
        socket.on('error', () => { upSocket.destroy() })
      })
      // vite 拒绝握手时会回一个普通响应而不是 101。原样转回去，
      // 让浏览器控制台看到真正的原因，而不是一个没有下文的挂起连接。
      upstream.on('response', (proxied) => {
        socket.write(`HTTP/1.1 ${String(proxied.statusCode ?? 502)} ${proxied.statusMessage ?? ''}\r\nconnection: close\r\n\r\n`)
        proxied.resume()
        proxied.on('end', () => { socket.end() })
      })
      upstream.on('error', () => { socket.destroy() })
      upstream.end()
    })
  }

  /**
   * 托管前端产物。找不到具体文件时回落到 `index.html`，让前端路由接管。
   * @returns 是否已经把响应处理掉了。
   */
  async function serveStatic(
    root: string,
    pathname: string,
    res: ServerResponse,
    extraHeaders: Record<string, string>,
  ): Promise<boolean> {
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    // 目录穿越防线：拼完再验证它仍在 root 之下，`../` 一律出局。
    // 用 path.relative 而不是字符串前缀比较 —— 后者要写死分隔符，
    // 在 Windows 上（反斜杠）会把每一个正常资源都误判成越界。
    const candidate = resolvePath(join(root, normalize(requested)))
    const rel = relative(root, candidate)
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    const target = inside ? candidate : join(root, 'index.html')

    const file = await stat(target).catch(() => null)
    const finalPath = file?.isFile() === true ? target : join(root, 'index.html')
    const fallback = await stat(finalPath).catch(() => null)
    if (fallback?.isFile() !== true) return false

    res.writeHead(200, {
      'content-type': MIME[extname(finalPath)] ?? 'application/octet-stream',
      'content-length': fallback.size,
      // 带内容哈希的资源可以长缓存，index.html 绝不缓存。
      'cache-control': finalPath.endsWith('index.html')
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
      ...extraHeaders,
    })
    createReadStream(finalPath).pipe(res)
    return true
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
