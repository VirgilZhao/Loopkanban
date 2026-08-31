/**
 * 本地 HTTP server：REST + SSE。
 *
 * 安全前提（见 `auth.ts`）：只 bind `127.0.0.1`、随机端口、一次性 token、
 * 校验 Host/Origin 防 DNS rebinding。远程访问走 SSH 端口转发。
 */

import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import {
  createServer as createHttpServer, request as httpRequest,
  type IncomingMessage, type Server, type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { basename, extname, isAbsolute, join, normalize, relative, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  archiveTask, asExecutorId, asProjectId, asRunId, asTaskId, deleteTask, dropReferences, editTask,
  mentionedExecutors, moveTask, referencedTasks, unarchiveTask, PERMISSION_TIERS,
  type Column, type Executor, type Task, type TaskEdit, type TaskId,
} from '@loopkanban/core'
import { AgentPool, type DetectedAgent } from '../agents/index.ts'
import {
  canInline, mimeOf, safeFilename, AttachmentStore,
  MAX_ATTACHMENTS_PER_COMMENT, MAX_ATTACHMENTS_PER_TASK, MAX_ATTACHMENT_BYTES,
} from '../attachments/index.ts'
import type { ChatService } from '../chat/index.ts'
import type { DecisionHub } from '../decisions/index.ts'
import { DecisionInputError } from '../decisions/index.ts'
import {
  createExecutor, defaultExecutor, setDefaultExecutor, updateExecutor,
  type CreateProblem,
} from '../executors/index.ts'
import type { Review } from '../review/index.ts'
import type { Runner } from '../runner/index.ts'
import type { Scheduler } from '../scheduler/index.ts'
import { DRAFT_COMMENT, type Attachment, type Storage } from '../storage/index.ts'
import type { TestEnvs } from '../testenv/index.ts'
import { branchExists, detectBaseBranch, isGitRepo, listBranches } from '../worktree/index.ts'
import { createToken, guardRequest, tokenCookieHeader } from './auth.ts'
import { browseDirectory, defaultBrowseRoot } from './browse.ts'
import { readFilePreview, resolvePreviewTarget } from './preview.ts'
import { RunBus } from './bus.ts'
import { confine, listFiles, listWorkspaces, readFileText, refusalFor } from './files.ts'
import { ShellBusyError, ShellHub, type ShellEvent, type ShellSession } from './shell.ts'

/** 只监听回环地址。**绝不 `0.0.0.0`** —— 那等于把执行任意代码的接口挂到局域网。 */
const LOOPBACK = '127.0.0.1'

/**
 * SSE 心跳间隔。除了穿过代理，它还是**发现对端已断开的主要手段** ——
 * 浏览器关掉标签页时，服务端往往要等到下一次写入失败才知道。间隔越长，
 * 死连接占着订阅的时间越久。
 */
const DEFAULT_SSE_HEARTBEAT_MS = 20_000

/**
 * 终端里允许发的信号。
 *
 * 白名单而不是照单全收：信号名是原样交给 `process.kill` 的，而进程组号是
 * 我们自己算的 —— 一个拼错的名字在这儿只该是 422，不该变成一次意外的终止。
 */
const SHELL_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGQUIT', 'SIGHUP'])

/** 一次性读取事件日志时最多回多少条。轮询的调用方要的是最近发生了什么。 */
const EVENT_PAGE = 200

export interface ServerOptions {
  readonly storage: Storage
  /**
   * 本机探测到的 Agent CLI。UI 只允许在这些里面选。
   *
   * 是**活视图**：`POST /api/agents/refresh` 会让它重新探测一遍，runner 与
   * scheduler 共用同一个实例，所以刷出来的结果立刻就能派上活。
   */
  readonly agents?: AgentPool
  /** 执行器。不给则只能看板，不能真正派活。 */
  readonly runner?: Runner
  /** 验收器。不给则不能通过/打回/废弃。 */
  readonly review?: Review
  /**
   * 附件的磁盘侧。不给则附件接口一律 503 —— 库里能记元数据，但没有
   * 落字节的地方，让上传"看起来成功"是最糟的结果。
   */
  readonly attachments?: AttachmentStore
  /** 自动认领调度器。不给则界面上没有自动驾驶开关。 */
  readonly scheduler?: Scheduler
  /**
   * 建卡之前那段对话。不给则那几条接口一律 503 —— 界面据此退回从前
   * 「写一句话就是一张卡」的样子，而不是给一个说了话没人应的输入框。
   */
  readonly chat?: ChatService
  /**
   * 一键测试环境。不给则那几条接口一律 503 —— 界面据此把按钮收起来，
   * 而不是给一个按下去永远失败的按钮。
   */
  readonly testEnvs?: TestEnvs
  /**
   * 决策中枢（权限审批 / 向人提问）。不给则那几条接口一律 503，
   * runner 那边也不会给执行接 gate —— 两边的一致性由装配处保证。
   */
  readonly decisions?: DecisionHub
  readonly bus?: RunBus
  /** 0 表示由系统分配随机端口（默认）。 */
  readonly port?: number
  /** 供测试注入固定 token。 */
  readonly token?: string
  /** SSE 心跳间隔，同时决定发现死连接的最长延迟。 */
  readonly sseHeartbeatMs?: number
  /**
   * 终端会话没人看着能留多久，超时连同它正在跑的命令一起收掉。
   *
   * 默认十分钟。一个网页终端最不该干的事，是在用户关掉标签页之后，还在
   * 机器上留一个谁也看不见的 `npm run dev`。
   */
  readonly shellIdleMs?: number
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

/**
 * 一个执行器对外的样子：只暴露能力事实，不暴露 help 原文这类噪音。
 *
 * GET /api/agents 与刷新用的是同一份映射 —— 两处各写一遍的话，迟早有一处
 * 少给一个字段，而界面会以为那个能力消失了。
 */
function describeAgent({ provider, caps }: DetectedAgent): Record<string, unknown> {
  return {
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
    // 反向通道的能力：能不能向人提问、能不能把权限审批路由给人。
    // 界面据此决定要不要展示 supervised 档与"提问可用"的说明。
    canAskUser: caps.canAskUser,
    canPromptPermission: caps.canPromptPermission,
    // 档位名字对不上实际约束时的警示，UI 有义务展示 —— 不能吞掉。
    ...(caps.permissionCaveat === undefined ? {} : { permissionCaveat: caps.permissionCaveat }),
  }
}

/** 校验关联卡片的结果：要么是一串确实存在的同项目 id，要么是可回给调用方的拒绝。 */
type RelatedResult =
  | { readonly ok: true; readonly ids: TaskId[] }
  | { readonly ok: false; readonly error: string; readonly detail: string }

/**
 * 把执行器的校验问题翻译成 HTTP。
 *
 * 名字重了是 409（"这个名字已经有人用了"是一次冲突，不是一个格式错误），
 * 要改的那个不在了是 404，其余都是 422 —— 请求本身读得懂，只是内容不合规矩。
 */
function sendExecutorProblem(res: ServerResponse, problem: CreateProblem): void {
  const status = problem === 'duplicate' ? 409 : problem === 'not-found' ? 404 : 422
  const detail = {
    empty: '执行器要有名字',
    'too-long': '名字太长了',
    'illegal-chars': '名字里不能有空格、@ 或 #',
    duplicate: '已经有同名的执行器了',
    'unknown-provider': '本机没有探测到这个 CLI',
    'not-found': '这个执行器已经不在了',
  }[problem]
  sendJson(res, status, { error: `executor-${problem}`, detail })
}

/**
 * 校验一批关联卡片 id。
 *
 * 关联**只在同一个项目内成立**：任务在这个项目派生出来的 worktree 里干活，
 * 指向另一个仓库里的卡，Agent 既读不到也用不上 —— 而它照样会被展开写进
 * TASK.md，变成一段没法照做的需求。存进去之前就挡住，比派活那一刻才发现强。
 *
 * 同理，查无此卡的 id 也当场拒绝：领域层能去掉自指与重复，但"这个 id 到底
 * 存不存在"要看别的卡，那不在它的视野里。
 *
 * @param raw - 请求里的原始值；`null` 与缺席都当作"清空"。
 * @param siblings - 同项目的全部卡片。
 * @param self - 这张卡自己；建卡时还没有，给 null。
 */
function resolveRelated(raw: unknown, siblings: readonly Task[], self: TaskId | null): RelatedResult {
  if (raw === null || raw === undefined) return { ok: true, ids: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'bad-request', detail: 'relatedTo 要给一个任务 id 数组' }
  }
  const known = new Set(siblings.map((task) => String(task.id)))
  const ids: TaskId[] = []
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'bad-request', detail: 'relatedTo 里只能是任务 id' }
    }
    if (self !== null && item === String(self)) {
      return { ok: false, error: 'self-related', detail: '一张卡不能关联它自己' }
    }
    if (!known.has(item)) {
      return {
        ok: false,
        error: 'no-such-related-task',
        detail: `${item} 不在这个项目里 —— 只能关联同项目的卡`,
      }
    }
    const id = asTaskId(item)
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, ids }
}

/**
 * 校验一批依赖卡片 id。
 *
 * 依赖与关联共用同一批基础约束 —— 同项目、必须存在、不含自己：依赖跨了项目
 * 永远等不到完成，指向查无此卡的 id 会让调度器永远算它"依赖未完成"，而那张
 * 卡在界面上根本不存在，没有任何操作能解开它。
 *
 * 依赖比关联多一条：**不许成环**。沿着依赖链走回这张卡，就是环上的卡互相等
 * —— 谁也不会先开工，这张卡从队列里彻底消失。只拒绝"这次修改造出的、经过
 * 自己的环"；别处已经存在的环不是这次编辑造出来的，不该由它背锅。
 *
 * @param raw - 请求里的原始值；`null` 与缺席都当作"清空"。
 * @param siblings - 同项目的全部卡片，存在性按它判。
 * @param self - 这张卡自己；建卡时还没有，给 null（新卡不可能成环）。
 * @param all - 全部卡片，成环检测沿它走。
 */
function resolveBlocked(
  raw: unknown,
  siblings: readonly Task[],
  self: TaskId | null,
  all: readonly Task[],
): RelatedResult {
  if (raw === null || raw === undefined) return { ok: true, ids: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'bad-request', detail: 'blockedBy 要给一个任务 id 数组' }
  }
  const known = new Set(siblings.map((task) => String(task.id)))
  const ids: TaskId[] = []
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'bad-request', detail: 'blockedBy 里只能是任务 id' }
    }
    if (self !== null && item === String(self)) {
      return { ok: false, error: 'self-dependency', detail: '一张卡不能依赖它自己' }
    }
    if (!known.has(item)) {
      return {
        ok: false,
        error: 'no-such-blocked-task',
        detail: `${item} 不在这个项目里 —— 只能依赖同项目的卡`,
      }
    }
    const id = asTaskId(item)
    if (!ids.includes(id)) ids.push(id)
  }
  if (self !== null && ids.length > 0) {
    // 从新选的依赖出发沿着 blockedBy 走：能到这张卡自己就是环。带父指针做
    // BFS，拒绝的时候能把整条链亮给调用方看。
    const edges = new Map(all.map((task) => [String(task.id), task.blockedBy.map(String)]))
    const me = String(self)
    const come = new Map<string, string | null>(ids.map((id) => [String(id), null]))
    const queue = ids.map((id) => String(id))
    while (queue.length > 0) {
      const current = queue.shift() as string
      if (current === me) {
        const chain: string[] = []
        let at: string | null = current
        while (at !== null) { chain.unshift(at); at = come.get(at) ?? null }
        return {
          ok: false,
          error: 'dependency-cycle',
          detail: `依赖成环：${chain.join(' → ')} —— 沿着依赖链走回了这张卡，环上的卡互相等，谁也不会开工`,
        }
      }
      for (const next of edges.get(current) ?? []) {
        if (!come.has(next)) { come.set(next, current); queue.push(next) }
      }
    }
  }
  return { ok: true, ids }
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

/**
 * 整块读请求体。上传附件用 —— 二进制不走 JSON。
 *
 * 刻意不流式落盘：本地工具，单文件上限 25 MB，先收全再写能让"超限"和
 * "写坏"两种失败都在落盘之前发生，磁盘上不会留下半个文件。
 *
 * @param req - 进来的请求。
 * @param limitBytes - 超过就拒收。
 */
async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limitBytes) throw new BadRequestError(`文件超过 ${String(Math.round(limitBytes / 1024 / 1024))} MB 上限`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * 附件对外的样子：**不含磁盘路径**。
 *
 * 路径是服务端的内部事实，前端拿它没有任何用处，漏出去只是白白告诉页面
 * 数据目录在哪儿。要拿内容走 `GET /api/attachments/<id>`。
 */
function describeAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    // 三态原样带出去（空串 = 还没发出去的草稿）：前端要靠它分辨这个文件
    // 是撤得回的草稿，还是已经进了讨论记录的东西。
    ...(attachment.commentId === undefined ? {} : { commentId: attachment.commentId }),
    at: attachment.at,
  }
}

/**
 * 讨论线程对外的样子：每条留言把自己带的文件挂在身上。
 *
 * 附件不另开一个接口去拼：一句话和它随手贴的那张截图是一起说出来的，
 * 前端要是得自己按 id 对齐两份列表，迟早会在某个刷新时序里把图挂到
 * 上一条留言底下。
 */
function describeComments(storage: Storage, taskId: TaskId): Record<string, unknown>[] {
  const byComment = new Map<string, Record<string, unknown>[]>()
  for (const file of storage.listCommentAttachments(taskId)) {
    const key = file.commentId ?? ''
    const list = byComment.get(key) ?? []
    list.push(describeAttachment(file))
    byComment.set(key, list)
  }
  return storage.listComments(taskId).map((comment) => ({
    ...comment,
    ...(byComment.has(comment.id) ? { attachments: byComment.get(comment.id) } : {}),
  }))
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
  const agents = options.agents ?? AgentPool.of([])
  const runner = options.runner
  const review = options.review
  const scheduler = options.scheduler
  const chat = options.chat
  const testEnvs = options.testEnvs
  const decisions = options.decisions
  const attachmentStore = options.attachments
  const staticDir = options.staticDir === undefined ? undefined : resolvePath(options.staticDir)
  const devServer = options.devServer === undefined ? undefined : new URL(options.devServer)
  const shells = new ShellHub(options.shellIdleMs === undefined ? {} : { idleMs: options.shellIdleMs })

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
    const guard = guardRequest(req, {
      token, port,
      // gate shim 只有限权 bearer token：只能为它自己的 run 创建/轮询决策。
      // 校验逻辑在决策中枢，这里只递一个谓词过去。
      ...(decisions === undefined ? {} : {
        bearer: (bearer, pathname) => {
          const owner = decisions.runIdForToken(bearer)
          if (owner === null) return false
          // 只有它自己这次执行的两条路：创建决策、查看/轮询决策。
          return pathname === `/api/runs/${owner}/decisions`
            || pathname.startsWith(`/api/runs/${owner}/decisions/`)
        },
      }),
    })
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
      // 带了几个附件也捎上：看板上那枚回形针得知道自己该不该出现，而为它
      // 单独开一轮请求（每张卡一次）就太贵了。只给数量，内容按需再取。
      const attachments: Record<string, number> = {}
      /*
       * 上一轮没跑成的卡，把收场也捎上。
       *
       * 成功与失败都停在 Review（running 只有这一个出口），所以那一列里
       * 「已经干完等你验」和「压根没跑起来」长得一模一样 —— 不标出来，人只能
       * 一张张点开才知道该验哪张。**只给 Review 那一列**：别处的卡要么还没跑、
       * 要么已经判过，一个红标记在那儿只是旧闻。
       */
      const failures: Record<string, {
        runId: string; provider: string; status: string; diagnostic?: string; at: number
      }> = {}
      const latest = storage.latestRuns()
      for (const task of tasks) {
        const count = storage.listAttachments(task.id).length
        if (count > 0) attachments[task.id] = count

        const last = latest.get(task.id)
        if (task.column === 'review' && last !== undefined
          && (last.status === 'failed' || last.status === 'aborted')) {
          failures[task.id] = {
            runId: last.id,
            provider: last.provider,
            status: last.status,
            ...(last.diagnostic === undefined ? {} : { diagnostic: last.diagnostic }),
            at: last.endedAt ?? last.startedAt,
          }
        }

        const runId = task.lease?.runId
        if (task.column !== 'running' || runId === undefined) continue
        const event = storage.lastEvent(runId)
        if (event !== null) live[task.id] = { kind: event.kind, payload: event.payload, at: event.at }
      }
      // 卡面上要标出"这张卡合过哪几条 PR"，所以一次读完全部 —— 一张卡问
      // 一次的话，Done 列有多少张卡就是多少个请求。
      const prs: Record<string, unknown[]> = {}
      for (const pr of storage.listAllPullRequests()) {
        (prs[pr.taskId] ??= []).push(pr)
      }
      // 每张卡跑过几轮也一次读完：卡面上的"第 N 轮"标记靠它。
      const rounds: Record<string, number> = {}
      for (const [taskId, count] of storage.runCounts()) rounds[taskId] = count
      // 等人拍板的决策挂在哪张卡上，也一次读完 —— Agent 停下来等审批/
      // 等回答的时候，卡要是毫无表示，人根本不会知道有东西在等他。
      const pending: Record<string, { id: string; kind: string }[]> = {}
      for (const [taskId, list] of decisions?.pendingByTask() ?? []) {
        pending[taskId] = list.map((item) => ({ id: item.id, kind: item.kind }))
      }
      // 执行器跟着看板一起来：卡面、聊天、@ 补全都要按 id 说出名字，
      // 而它们数量很少、又几乎不变 —— 单开一轮请求只是多一次往返。
      sendJson(res, 200, {
        projects: storage.listProjects(), tasks, live, attachments, prs, failures, rounds, pending,
        executors: storage.listExecutors(),
        defaultExecutorId: defaultExecutor(storage)?.id ?? null,
      }, extraHeaders)
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

    /*
     * 某个仓库有哪些分支，以及默认该选哪个。
     *
     * 新增项目时让人自己挑基线：默认值只是个猜测，猜错了每张卡都会长在
     * 一堆无关改动上面。`base` 是推荐值（main / master 优先），不是命令。
     */
    if (method === 'GET' && pathname === '/api/branches') {
      const asked = url.searchParams.get('path')?.trim() ?? ''
      if (asked.length === 0 || !isAbsolute(asked)) {
        sendJson(res, 422, { error: 'path-not-absolute', detail: '要绝对路径' })
        return
      }
      const repoPath = resolvePath(asked)
      if (!(await isGitRepo(repoPath))) {
        sendJson(res, 422, { error: 'not-a-repo', detail: `${repoPath} 不是一个 git 仓库` })
        return
      }
      sendJson(res, 200, {
        path: repoPath,
        branches: await listBranches(repoPath).catch(() => []),
        base: await detectBaseBranch(repoPath),
      }, extraHeaders)
      return
    }

    /*
     * ── 文件浏览与命令行 ─────────────────────────────────────
     *
     * 三个接口共用一条围栏：路径必须落在**已登记项目的仓库**里面（worktree
     * 长在 `<repo>/.loopkanban/worktrees/` 下，天然包含在内）。围栏防的是我们
     * 自己的路径拼接写错 —— 那种 bug 在「只列目录名」时是噪音，在「读文件正文」
     * 和「跑命令」时就是把整台机器摊开。
     */
    /**
     * 把一个文件的原始字节直接流给浏览器。
     *
     * PDF 与图片是这样出去的，而不是 base64 进 JSON：浏览器自带 PDF 阅读器，
     * 图片更是给个 URL 就完事，绕一圈 base64 只是凭空胖三分之一再让前端解回来。
     *
     * **类型是一份允许清单，不是猜测**：只有图片和 PDF 会内联，别的一律拒绝。
     * 这些字节和看板同源 —— 一个能内联渲染的 `.html` 就能拿着 cookie 调本机的
     * 执行接口，那是把「看一眼文件」变成「在你机器上跑任意命令」。`.svg` 同样
     * 不在清单里，它是能跑脚本的。
     *
     * @param path - 已经过围栏校验的绝对路径。
     * @param name - 下载/内联时报的文件名。
     */
    const streamRaw = async (path: string, name: string): Promise<void> => {
      const mime = mimeOf(name)
      if (!canInline(mime)) {
        sendJson(res, 415, { error: 'not-inlineable', detail: `${name} 不是能直接在浏览器里打开的类型` })
        return
      }
      // 先拿 fd 再决定状态码：stat 与 open 之间那道缝里文件可能被删掉，而那时
      // 头已经发出去了就改不成 404 了。（同附件那条路由，理由见其注释。）
      const handle = await open(path, 'r').catch(() => null)
      if (handle === null) {
        sendJson(res, 404, { error: 'no-such-file', detail: `打不开 ${path}` })
        return
      }
      const info = await handle.stat().catch(() => null)
      if (info?.isFile() !== true) {
        await handle.close().catch(() => undefined)
        sendJson(res, 404, { error: 'no-such-file', detail: `打不开 ${path}` })
        return
      }
      res.writeHead(200, {
        'content-type': mime,
        'content-length': info.size,
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        // 不许浏览器自作主张改判类型 —— 上面那份允许清单就白设了。
        'x-content-type-options': 'nosniff',
        // 文件随时在被 Agent 改写，缓存住只会让人看到上一版。
        'cache-control': 'no-store',
        ...extraHeaders,
      })
      const stream = handle.createReadStream()
      // 读到一半的 I/O 错误改不了状态码，只能掐断连接 —— 但这个监听必须在：
      // 少了它，一个读错误就是一次 uncaughtException，整个看板跟着没。
      stream.on('error', (error: unknown) => {
        console.error(`[loopkanban] 文件读取中断 ${path}:`, error)
        res.destroy()
      })
      res.on('close', () => { stream.destroy() })
      stream.pipe(res)
    }

    const projectRoots = (): string[] => storage.listProjects().map((project) => project.repoPath)

    /**
     * 一张卡够得着的目录：它历次执行的 worktree，加上项目仓库。
     *
     * 预览与取原始字节两条路由共用它 —— 围栏只算一遍，才不会有一天走岔。
     */
    const reachableRoots = (task: Task): string[] =>
      [...new Set([...storage.listRuns(task.id).map((run) => run.worktreePath), task.repoPath])]

    /**
     * 围栏没放行时的应答。
     *
     * 一律说成「在项目外面」是不行的：仓库被移走或删掉时，用户送来的**正是**
     * 这个项目登记的路径，那句话等于告诉他「你逛的不是你自己的项目」，而他逛的
     * 恰恰就是 —— 把人往完全错误的方向带。所以要分清是哪一种。
     *
     * @param roots - 与 `confine` 拿到的是同一份。
     * @param asked - 被拒的那个路径。
     * @param outside - 真的越界时说什么。
     */
    const refuse = async (roots: readonly string[], asked: string, outside: string): Promise<void> => {
      const reason = await refusalFor(roots, asked)
      // 410 而不是 422：路径没错，是它指向的东西整个不在了。
      sendJson(res, reason === 'repo-missing' ? 410 : 422, {
        error: reason,
        detail: reason === 'repo-missing' ? `项目的仓库目录已经不在了：${asked}` : outside,
      })
    }

    /** 一个项目能逛哪些工作区：主仓库，加上卡片留下的 worktree。 */
    if (method === 'GET' && pathname === '/api/workspaces') {
      const asked = url.searchParams.get('projectId')?.trim() ?? ''
      const project = asked.length === 0 ? null : storage.getProject(asProjectId(asked))
      if (project === null) {
        sendJson(res, 404, { error: 'project-not-found', detail: '没有这个项目' })
        return
      }
      sendJson(res, 200, { workspaces: await listWorkspaces(project.repoPath) }, extraHeaders)
      return
    }

    /**
     * 某个文件的原始字节。PDF 与图片走这里 —— 正文接口只回文本。
     *
     * 围栏与正文接口完全一样，一个字都不放松：能读到正文的地方才能读到字节。
     */
    if (method === 'GET' && pathname === '/api/files/raw') {
      const roots = projectRoots()
      const askedRoot = url.searchParams.get('root')?.trim() ?? ''
      const askedPath = url.searchParams.get('path')?.trim() ?? ''
      const root = await confine(roots, askedRoot)
      if (root === null) { await refuse(roots, askedRoot, '只能看已登记项目仓库里的文件'); return }
      const target = await confine([root], askedPath)
      if (target === null) { await refuse([root], askedPath, '只能看已登记项目仓库里的文件'); return }
      await streamRaw(target, basename(target))
      return
    }

    /** 某个文件的正文。放在 `/api/files` 前面 —— 两条都是精确匹配，顺序只为读着清楚。 */
    if (method === 'GET' && pathname === '/api/files/content') {
      const roots = projectRoots()
      const askedRoot = url.searchParams.get('root')?.trim() ?? ''
      const askedPath = url.searchParams.get('path')?.trim() ?? ''
      const root = await confine(roots, askedRoot)
      if (root === null) { await refuse(roots, askedRoot, '只能看已登记项目仓库里的文件'); return }
      const target = await confine([root], askedPath)
      if (target === null) { await refuse([root], askedPath, '只能看已登记项目仓库里的文件'); return }
      try {
        sendJson(res, 200, await readFileText(root, target), extraHeaders)
      } catch {
        sendJson(res, 404, { error: 'no-such-file', detail: `打不开 ${target}` })
      }
      return
    }

    /** 列一个目录。不给 path 就列工作区根。 */
    if (method === 'GET' && pathname === '/api/files') {
      const roots = projectRoots()
      const askedRoot = url.searchParams.get('root')?.trim() ?? ''
      const asked = url.searchParams.get('path')?.trim() ?? ''
      const root = await confine(roots, askedRoot)
      if (root === null) { await refuse(roots, askedRoot, '只能逛已登记项目仓库里的目录'); return }
      const target = asked.length === 0 ? root : await confine([root], asked)
      if (target === null) { await refuse([root], asked, '只能逛已登记项目仓库里的目录'); return }
      try {
        sendJson(res, 200, await listFiles(root, target), extraHeaders)
      } catch {
        sendJson(res, 404, { error: 'no-such-dir', detail: `打不开 ${target}` })
      }
      return
    }

    /*
     * ── 终端会话 ─────────────────────────────────────────────
     *
     * 开一个会话。**围栏只画在这一步**：起步目录必须落在已登记项目的仓库里。
     * 开完之后，会话的 cwd 跟着 shell 自己的 `$PWD` 走 —— `cd ~` 就真的去了
     * 家目录。这不是围栏漏了：命令本来就能自己 `cd /`，拦不住也不打算拦，
     * 这层围栏防的是**我们的路径拼接写错**，不是防用户。
     */
    if (method === 'POST' && pathname === '/api/shell') {
      const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
      const roots = projectRoots()
      const askedRoot = typeof body['root'] === 'string' ? body['root'].trim() : ''
      const asked = typeof body['cwd'] === 'string' ? body['cwd'].trim() : ''
      const root = await confine(roots, askedRoot)
      if (root === null) { await refuse(roots, askedRoot, '终端只能从已登记项目的仓库里起步'); return }
      const cwd = asked.length === 0 ? root : await confine([root], asked)
      if (cwd === null) { await refuse([root], asked, '终端只能从已登记项目的仓库里起步'); return }

      /*
       * cwd 可能在你浏览的这会儿就没了 —— 废弃一张卡会连它的 worktree 一起删掉。
       * 不先探一下的话，spawn 会以 `spawn /bin/zsh ENOENT` 失败，而那句话把锅
       * 甩给了 shell：真正不见的是目录，用户照着去查 shell 只会白费一晚上。
       */
      if (!await stat(cwd).then((info) => info.isDirectory(), () => false)) {
        sendJson(res, 404, { error: 'no-such-dir', detail: `打不开 ${cwd}` })
        return
      }
      sendJson(res, 201, { session: shells.open(cwd).snapshot() }, extraHeaders)
      return
    }

    /*
     * 会话上的动作。会话不在了一律 404 —— 页面据此重新开一个，而不是把
     * 用户敲的命令送进一个已经被回收的会话里。
     */
    const shellRoute = /^\/api\/shell\/([^/]+)(?:\/(events|exec|input|signal|list))?$/.exec(pathname)
    if (shellRoute !== null) {
      const session = shells.get(decodeURIComponent(shellRoute[1] ?? ''))
      if (session === null) {
        sendJson(res, 404, { error: 'no-such-shell', detail: '这个终端会话已经不在了' })
        return
      }
      const action = shellRoute[2] ?? ''

      if (method === 'GET' && action === 'events') {
        /*
         * `after` 是**页面自己记着的游标**：它已经画在屏幕上的最后一个 seq。
         * EventSource 建新连接时带不上 `Last-Event-ID`（那是重连才有的），
         * 少了这个参数，每次重新订阅都会把整个回放缓冲再倒一遍 —— 用户刚
         * 清掉的屏幕会自己长回来。
         */
        const after = Number.parseInt(url.searchParams.get('after') ?? '', 10)
        streamShell(req, res, session, Number.isFinite(after) && after > 0 ? after : 0)
        return
      }

      if (method === 'GET' && action === '') {
        sendJson(res, 200, { session: session.snapshot() }, extraHeaders)
        return
      }

      if (method === 'DELETE' && action === '') {
        await shells.close(session.id)
        sendJson(res, 200, { closed: true }, extraHeaders)
        return
      }

      /*
       * 跑一条命令。回 202 而不是结果：`npm run dev` 根本不打算结束，等它
       * exit 再回应等于把这类命令整个排除在外。输出与结局都从事件流里出去。
       */
      if (method === 'POST' && action === 'exec') {
        const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
        const command = typeof body['command'] === 'string' ? body['command'].trim() : ''
        if (command.length === 0) {
          sendJson(res, 422, { error: 'empty-command', detail: '要一条命令' })
          return
        }
        try {
          session.exec(command)
        } catch (error) {
          // 一次一条。第二条该等着，而不是和前一条抢同一块屏幕。
          if (error instanceof ShellBusyError) {
            sendJson(res, 409, { error: 'shell-busy', detail: error.message })
            return
          }
          throw error
        }
        sendJson(res, 202, { accepted: true }, extraHeaders)
        return
      }

      /** 往正在跑的命令的 stdin 里写。`eof` 相当于 ctrl+d。 */
      if (method === 'POST' && action === 'input') {
        const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
        const data = typeof body['data'] === 'string' ? body['data'] : ''
        const eof = body['eof'] === true
        sendJson(res, 200, { delivered: session.input(data, eof) }, extraHeaders)
        return
      }

      /** ctrl+c 走这里。信号发给整个进程组，孙进程一起收到。 */
      if (method === 'POST' && action === 'signal') {
        const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
        const asked = typeof body['signal'] === 'string' ? body['signal'] : 'SIGINT'
        if (!SHELL_SIGNALS.has(asked)) {
          sendJson(res, 422, { error: 'bad-signal', detail: `不认识的信号 ${asked}` })
          return
        }
        sendJson(res, 200, { delivered: session.signal(asked as NodeJS.Signals) }, extraHeaders)
        return
      }

      /*
       * 列一个目录，只为 Tab 补全。
       *
       * 不走 `/api/files` 那条：那条的围栏钉在某个工作区根上，而会话 `cd`
       * 出去之后就补不出任何东西了 —— 一个补不了路径的终端，Tab 按下去
       * 什么都不动，最像的解释是这个功能坏了。这里不另设围栏：会话本来就能
       * 跑 `ls`，列目录严格地更弱。
       */
      if (method === 'GET' && action === 'list') {
        const asked = url.searchParams.get('dir')?.trim() ?? ''
        const target = asked.length === 0 ? session.cwd : resolvePath(session.cwd, asked)
        try {
          sendJson(res, 200, {
            cwd: session.cwd,
            ...await listFiles(target, target),
          }, extraHeaders)
        } catch {
          sendJson(res, 404, { error: 'no-such-dir', detail: `打不开 ${target}` })
        }
        return
      }

      sendJson(res, 405, { error: 'method-not-allowed', detail: `${method} ${pathname}` })
      return
    }

    // ── 项目：列出与新增 ─────────────────────────────────────
    if (pathname === '/api/projects') {
      if (method === 'GET') {
        sendJson(res, 200, { projects: storage.listProjects() }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as
          Partial<{ name: string; path: string; baseBranch: string }> | undefined
        const name = body?.name?.trim() ?? ''
        const raw = body?.path?.trim() ?? ''
        const askedBase = body?.baseBranch?.trim() ?? ''
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
        // 指定了基线就得真有这个分支：写下一个不存在的名字，要等到第一次
        // 派活建 worktree 时才炸，那时人早已不在这个弹窗前面了。
        if (askedBase.length > 0 && !(await branchExists(repoPath, askedBase))) {
          sendJson(res, 422, { error: 'no-such-branch', detail: `${repoPath} 里没有分支 ${askedBase}` })
          return
        }
        const baseBranch = askedBase.length > 0 ? askedBase : await detectBaseBranch(repoPath)
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

    /*
     * ── 执行器：一个起了名字的「哪个 CLI + 哪个模型」────────
     *
     * 名字是给人用的（`@大壮`），provider 必须是本机探测得到的那几个之一 ——
     * 手打一个 CLI 不认的名字只会在派活那一刻才炸，而那时人早不在这页了。
     */
    if (pathname === '/api/executors') {
      if (method === 'GET') {
        sendJson(res, 200, {
          executors: storage.listExecutors(),
          defaultId: defaultExecutor(storage)?.id ?? null,
          // 能选哪些 CLI 也一并给：新建那个表单要照着它渲染下拉。
          providers: agents.list().map((agent) => ({
            id: agent.provider.id,
            version: agent.caps.version,
            models: agent.caps.models,
            canPickModel: agent.caps.canPickModel,
          })),
        }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as Partial<{ name: string; provider: string; model: string }> | undefined
        const made = createExecutor(
          storage,
          {
            name: body?.name ?? '',
            provider: body?.provider ?? '',
            ...(body?.model === undefined ? {} : { model: body.model }),
          },
          agents.list().map((agent) => agent.provider.id),
        )
        if (!made.ok) { sendExecutorProblem(res, made.problem); return }
        sendJson(res, 201, { executor: made.executor }, extraHeaders)
        return
      }
    }

    const executorId = matchPath(pathname, /^\/api\/executors\/([^/]+)$/)
    if (executorId !== null) {
      const id = asExecutorId(decodeURIComponent(executorId))
      if (storage.getExecutor(id) === null) {
        sendJson(res, 404, { error: 'executor-not-found' })
        return
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req) as Partial<{ name: string; provider: string; model: string | null }> | undefined
        const patch: Partial<{ name: string; provider: string; model: string }> = {
          ...(body?.name === undefined ? {} : { name: body.name }),
          ...(body?.provider === undefined ? {} : { provider: body.provider }),
          // null 与空串都表示"用这个 CLI 自己的默认模型"。
          ...(body !== undefined && 'model' in body ? { model: body.model ?? '' } : {}),
        }
        const saved = updateExecutor(storage, id, patch, agents.list().map((agent) => agent.provider.id))
        if (!saved.ok) { sendExecutorProblem(res, saved.problem); return }
        sendJson(res, 200, { executor: saved.executor }, extraHeaders)
        return
      }
      if (method === 'DELETE') {
        // 引用它的卡就地解绑（见 storage.deleteExecutor），不连带删卡。
        storage.deleteExecutor(id)
        sendJson(res, 200, {
          executors: storage.listExecutors(),
          defaultId: defaultExecutor(storage)?.id ?? null,
        }, extraHeaders)
        return
      }
    }

    const makeDefault = matchPath(pathname, /^\/api\/executors\/([^/]+)\/default$/)
    if (method === 'POST' && makeDefault !== null) {
      const id = asExecutorId(decodeURIComponent(makeDefault))
      if (!setDefaultExecutor(storage, id)) {
        sendJson(res, 404, { error: 'executor-not-found' })
        return
      }
      sendJson(res, 200, { defaultId: id }, extraHeaders)
      return
    }

    /*
     * ── 建卡之前的那段对话 ──────────────────────────────────
     *
     * 挂在项目上：聊的是某个仓库里的事，执行器也要在那个仓库里才看得懂
     * 「这块面板」指的是什么。
     */
    const chatOf = matchPath(pathname, /^\/api\/projects\/([^/]+)\/chat$/)
    if (chatOf !== null) {
      const project = storage.listProjects().find((p) => p.id === decodeURIComponent(chatOf))
      if (project === undefined) { sendJson(res, 404, { error: 'project-not-found' }); return }
      if (chat === undefined) {
        sendJson(res, 503, { error: 'chat-unavailable', detail: '这个看板没有装对话服务' })
        return
      }
      if (method === 'GET') {
        sendJson(res, 200, chat.state(project), extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as Partial<{ body: string }> | undefined
        const text = body?.body?.trim() ?? ''
        if (text.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '说点什么' })
          return
        }
        sendJson(res, 201, chat.say(project, text), extraHeaders)
        return
      }
      if (method === 'DELETE') {
        chat.clear(project)
        sendJson(res, 200, chat.state(project), extraHeaders)
        return
      }
    }

    /*
     * 采纳一份草案：把它变成一张真的卡。
     *
     * 落在哪一列由人当场决定 —— `backlog` 是"记下来，回头再说"，`ready` 是
     * "现在就开工"。**建卡这一步永远经过人**，所以它是一个显式的接口，而不是
     * 执行器自己能调的工具。
     */
    const adopt = matchPath(pathname, /^\/api\/chat\/([^/]+)\/adopt$/)
    if (method === 'POST' && adopt !== null) {
      const messageId = decodeURIComponent(adopt)
      const body = await readJsonBody(req) as Partial<{ column: string }> | undefined
      const column = body?.column === 'ready' ? 'ready' : 'backlog'

      const projects = storage.listProjects()
      const message = projects
        .flatMap((project) => storage.listChat(project.id))
        .find((item) => item.id === messageId)
      if (message === undefined || message.proposal === undefined) {
        sendJson(res, 404, { error: 'proposal-not-found' })
        return
      }
      if (message.taskId !== undefined) {
        sendJson(res, 409, { error: 'already-adopted', detail: '这份草案已经建成卡片了' })
        return
      }
      const project = projects.find((p) => p.id === message.projectId)
      if (project === undefined) { sendJson(res, 404, { error: 'project-not-found' }); return }

      const siblings = storage.listTasks(project.id)
      /*
       * 草案里的关联卡要过一遍，但**滤掉而不是整批拒绝**。
       *
       * 这和人手填的那条路不一样：那儿写错一个 id 是打错字，当场说一声让他
       * 改；这儿的 id 是执行器写下的，它可能顺手编了一个不存在的卡号 ——
       * 为此把整份谈了半天的草案挡回去，代价完全不成比例。真实存在的那几条
       * 留下，其余当没写过。
       */
      const known = new Set(siblings.map((task) => String(task.id)))
      const related = resolveRelated(
        message.proposal.relatedTo.filter((id) => known.has(id)), siblings, null,
      )
      const now = Date.now()
      const created: Task = {
        id: asTaskId(`t-${randomUUID().slice(0, 8)}`),
        projectId: project.id,
        revision: 1,
        column: 'backlog',
        position: Math.max(0, ...siblings.map((task) => task.position)) + 1,
        description: message.proposal.description,
        acceptance: [...message.proposal.acceptance],
        repoPath: project.repoPath,
        baseBranch: project.baseBranch,
        // 谈这件事的那个执行器就是它的第一任负责人 —— 上下文在它那儿。
        ...(message.executorId === undefined ? {} : { executorId: message.executorId }),
        blockedBy: [],
        relatedTo: related.ok ? related.ids : [],
        createdAt: now,
        updatedAt: now,
      }
      /*
       * **先认领这份草案，再建卡。**
       *
       * `linkChatProposal` 那条 UPDATE 带着 `task_id IS NULL`，所以它就是这份
       * 草案的唯一一次机会：两个标签页同时点"建卡"，只有一个能命中。反过来
       * （先建卡再认领）的话，两边都会先建出一张一模一样的卡，而认领失败的
       * 那一张没有任何人再回头把它收走。
       *
       * 代价是万一建卡本身炸了（数据库写不进去），草案会被标成已采纳却没有卡。
       * 那是一次硬故障，看得见；而无声多出一张重复的卡不是。
       */
      if (!storage.linkChatProposal(messageId, created.id)) {
        sendJson(res, 409, { error: 'already-adopted', detail: '这份草案已经建成卡片了' })
        return
      }
      storage.createTask(created)
      // 先落 backlog 再走一次正常的流转，而不是直接建在 ready 上：
      // "新卡一律从想法池起步"是领域层的规则，绕过它就等于有两条建卡的路。
      let task = created
      if (column === 'ready') {
        const moved = moveTask(created, { expectedRevision: created.revision, to: 'ready', now })
        if (moved.ok && storage.commitTask(moved.value)) task = moved.value
      }
      sendJson(res, 201, { task, chat: chat?.state(project) ?? null }, extraHeaders)
      return
    }

    // ── 已探测到的 Agent ────────────────────────────────────
    if (method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, { agents: agents.list().map(describeAgent) }, extraHeaders)
      return
    }

    /*
     * 重新探测一遍本机。
     *
     * 装了个新 CLI、升级了版本、或者刚 `claude login` 完 —— 这些都不该逼人
     * 重启看板。POST 而不是 GET：它会真的去起一串子进程，不是一次读取。
     */
    if (method === 'POST' && pathname === '/api/agents/refresh') {
      sendJson(res, 200, { agents: (await agents.refresh()).map(describeAgent) }, extraHeaders)
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
          { autopilot?: boolean; maxPerProvider?: number; maxPerRepo?: number } | undefined
        const settings = scheduler.updateSettings(body ?? {})
        // 立刻跑一轮，让开关点下去马上有反应，而不是等下一个节拍。
        // tick() 会排在进行中的那一轮之后，所以这里拿到的一定是**新设置下**
        // 的结果，而不是上一轮的陈旧报告。
        const lastTick = await scheduler.tick()
        sendJson(res, 200, { settings, lastTick }, extraHeaders)
        return
      }
    }

    // ── 改项目名 / 换基线分支 ───────────────────────────────
    const projectId = matchPath(pathname, /^\/api\/projects\/([^/]+)$/)
    if (method === 'PATCH' && projectId !== null) {
      const target = asProjectId(decodeURIComponent(projectId))
      const project = storage.getProject(target)
      if (project === null) { sendJson(res, 404, { error: 'project-not-found' }); return }

      const body = await readJsonBody(req) as
        (Partial<{ name: string; baseBranch: string; testCommand: string | null; testEnvFiles: string[] | null }> & Record<string, unknown>)
        | undefined
      const name = body?.name?.trim()
      const baseBranch = body?.baseBranch?.trim()
      // 同 PATCH 卡片：缺席是"这次没提到"，显式 null / 空串才是"清空"。
      // 两者必须分得开，否则改个项目名就会顺手把启动命令抹掉。
      const testCommand = body !== undefined && 'testCommand' in body
        ? (body['testCommand'] as string | null) ?? ''
        : undefined
      const testEnvFiles = body !== undefined && 'testEnvFiles' in body
        ? (Array.isArray(body['testEnvFiles'])
          ? (body['testEnvFiles'] as unknown[])
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
          : [])
        : undefined
      if (name !== undefined && name.length === 0) {
        sendJson(res, 400, { error: 'bad-request', detail: '项目名不能为空' })
        return
      }
      /*
       * 换基线只影响此后新建的卡 —— 已经建出来的卡各自记着自己的基线。
       * 把它们一起改掉会让某张正在 Review 的卡的 diff 与合并目标在脚下换掉，
       * 而那正是人此刻在看的东西。
       */
      if (baseBranch !== undefined) {
        if (baseBranch.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '基线分支不能为空' })
          return
        }
        if (!(await branchExists(project.repoPath, baseBranch))) {
          sendJson(res, 422, { error: 'no-such-branch', detail: `${project.repoPath} 里没有分支 ${baseBranch}` })
          return
        }
      }
      if (!storage.updateProject(target, {
        ...(name === undefined ? {} : { name }),
        ...(baseBranch === undefined ? {} : { baseBranch }),
        ...(testCommand === undefined ? {} : { testCommand }),
        ...(testEnvFiles === undefined ? {} : { testEnvFiles }),
      })) {
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
      // 附件同理：库里的记录跟着项目一起没，磁盘上的字节不会自己消失。
      const hadAttachments = storage.listProjectAttachments(target).length > 0
      if (!storage.deleteProject(target)) {
        sendJson(res, 404, { error: 'project-not-found' })
        return
      }
      // 同 accept / discard / 删卡：状态先落定，不可逆的删除在后。
      // 收拾的只是我们自己建的 worktree 与任务分支，仓库本身一个字不动。
      for (const task of tasks) await testEnvs?.stop(task.id, 'verdict')
      if (review !== undefined) {
        for (const task of tasks) await review.purge(task, runsOfTask.get(task.id) ?? [])
      }
      if (hadAttachments && attachmentStore !== undefined) {
        for (const task of tasks) await attachmentStore.removeTask(task.id)
      }
      sendJson(res, 200, { deleted: true, tasks: tasks.length }, extraHeaders)
      return
    }

    // ── 新建任务 ────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/tasks') {
      const body = await readJsonBody(req) as Partial<{
        projectId: string; description: string; acceptance: string[]
        preferredProvider: string; model: string; executorId: string
        relatedTo: string[]; blockedBy: string[]
      }> | undefined
      // 仓库与基线跟着项目走，不由建卡方指定 —— 任务干活的地方是这个项目
      // 派生出来的 worktree，两者对不上就没有意义。
      const projects = storage.listProjects()
      const project = projects.find((p) => p.id === body?.projectId) ?? projects[0]
      if (project === undefined) { sendJson(res, 400, { error: 'no-project' }); return }

      const now = Date.now()
      const tasks = storage.listTasks(project.id)
      // 建卡时就能带上关联 —— MCP 那边"照着这张卡再开一张"是常事，逼它先
      // 建后改只是多一次往返。同项目的约束一样要过。
      const related = resolveRelated(body?.relatedTo, tasks, null)
      if (!related.ok) {
        sendJson(res, related.error === 'bad-request' ? 400 : 422, {
          error: related.error, detail: related.detail,
        })
        return
      }
      // 依赖一样建卡时就能带上。新卡还没有 id，谁也依赖不了它，成环检查天然
      // 不用做 —— resolveBlocked 里 self 为 null 时会跳过。
      const blocked = resolveBlocked(body?.blockedBy, tasks, null, tasks)
      if (!blocked.ok) {
        sendJson(res, blocked.error === 'bad-request' ? 400 : 422, {
          error: blocked.error, detail: blocked.detail,
        })
        return
      }
      const asked = body?.executorId
      const pinnedExecutor: Executor | null = asked === undefined || asked === ''
        ? null
        : storage.getExecutor(asExecutorId(asked))
      if (asked !== undefined && asked !== '' && pinnedExecutor === null) {
        sendJson(res, 422, { error: 'executor-not-found', detail: `没有 ${asked} 这个执行器` })
        return
      }
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
        // 建卡时**不必**指定执行器 —— 不指定就是默认那位，第一次派活时才
        // 写到卡上（见 runner）。给了就得是真的存在的那个。
        ...(pinnedExecutor === null ? {} : { executorId: pinnedExecutor.id }),
        blockedBy: blocked.ids,
        relatedTo: related.ids,
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
        sendJson(res, 200, { comments: describeComments(storage, taskId) }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as
          (Partial<{ body: string }> & Record<string, unknown>) | undefined
        const text = body?.body?.trim() ?? ''
        if (text.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '留言不能为空' })
          return
        }
        // 这条话带上哪几个已经传好的草稿附件。文件先传、留言后发，所以
        // 这里收的是 id 而不是字节 —— 真正的认领在留言落库之后。
        const rawIds = body?.['attachmentIds']
        const attachmentIds = Array.isArray(rawIds)
          ? rawIds.filter((value): value is string => typeof value === 'string')
          : []
        /*
         * 数量在这儿就挡住，**而且必须挡在留言落库之前**。
         *
         * 认领那一句是 `id IN (?, ?, …)`，一个 id 一个占位符；数量一大就顶穿
         * SQLite 的参数上限，`prepare` 直接抛 —— 而那时留言已经写进去、卡可能
         * 也已经回了队列，调用方却拿到一个 500，重试就多一条重复留言。
         * 上传那一路本来就传不出超过这个数的草稿，所以这里拒绝也不冤枉任何
         * 正常的客户端。
         */
        if (attachmentIds.length > MAX_ATTACHMENTS_PER_COMMENT) {
          sendJson(res, 422, {
            error: 'too-many-attachments',
            detail: `一条留言最多带 ${String(MAX_ATTACHMENTS_PER_COMMENT)} 个附件`,
          })
          return
        }

        /*
         * 一句话里可以顺带交代两件事，都是从**话本身**读出来的：
         *
         *   `@大壮`      下一轮换他干。说"再改一版"和"这次换个人干"本来就是
         *                同一句话，逼人先去规格里存一遍再回来发言是多一道手续；
         *                而一个下拉框还会出现"改了下拉却忘了发言"。
         *   `#t-1a2b3c4d` 参考那张卡。落到卡上就是 relatedTo，派活时那张卡的
         *                内容会被展开写进规格里 —— 于是执行器"通过 #任务id
         *                拿到该任务的详情"这件事，就是既有的关联机制。
         *
         * 不点名就不换人：卡上记着第一次派活时用的那个执行器，后面几轮都归他。
         */
        const executors = storage.listExecutors()
        const mentioned = mentionedExecutors(text, executors)[0]
        // 只认同项目、真实存在的卡；`#` 后面打错一个字符不该变成一次报错，
        // 更不该变成一条指向查无此卡的关联。
        const siblings = storage.listTasks(task.projectId)
        const known = new Set(siblings.map((other) => String(other.id)))
        const referenced = referencedTasks(text)
          .filter((id) => known.has(String(id)) && String(id) !== String(task.id))
        const merged = [...new Set([...task.relatedTo.map(String), ...referenced.map(String)])] as TaskId[]

        /*
         * 卡在**执行中**（或已归档）时改不动 —— `editTask` 会拒。两件事在这里
         * 分道扬镳：
         *
         * - `@` 点名是一次明确的意图，改不了就得**当场说**（422，那句话也不
         *   留下）。悄悄咽掉的话，人以为下一轮换了人，其实没换。
         * - `#` 引用只是顺手提一句"参考那张卡"。为它把整条留言退回去太重了
         *   —— 卡正跑着的时候留一句话本来是允许的，加一个 `#` 不该让它 422。
         *   这一轮就不记那条关联了，那个卡号仍然原样留在话里，跟着讨论走。
         */
        const editable = task.column !== 'running' && task.archivedAt === undefined
        const edit: TaskEdit = {
          // 点的正是眼下这一位就什么都不改 —— 白白 +1 一次 revision 会让
          // 别处正拿着旧 revision 的请求平白撞上一次冲突。
          ...(mentioned === undefined || String(mentioned.id) === String(task.executorId)
            ? {}
            : { executorId: mentioned.id }),
          ...(!editable || merged.length === task.relatedTo.length ? {} : { relatedTo: merged }),
        }
        // 改在留言落库之前：被拒的换人不该留下一条已经发出去的话。
        let current = task
        if (Object.keys(edit).length > 0) {
          const edited = editTask(current, { expectedRevision: current.revision, edit, now: Date.now() })
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
          current = edited.value
        }

        const commentId = `c-${randomUUID().slice(0, 8)}`
        storage.addComment({
          id: commentId,
          taskId,
          author: 'human',
          body: text,
          at: Date.now(),
        })
        // 认领在留言之后：反过来的话，留言写失败会留下一批挂在幽灵 id 上的
        // 附件 —— 它们既不在草稿里也不在任何一条留言底下，谁都再看不见。
        storage.attachToComment(taskId, attachmentIds, commentId)
        // 在 Review **或 Done** 里留言就是"再改一版"：卡自动回队列，下一次
        // 执行带着整条讨论走。Done 也算，是因为"合上去才发现还差一条"本来
        // 就是这张卡的下一轮 —— 另开一张新卡会把讨论、worktree、已经合过的
        // PR 全丢掉，而那些正是接着干最需要的东西。别的列只是留个话，
        // 不动卡的位置。
        let moved = false
        if (current.column === 'review' || current.column === 'done') {
          const next = moveTask(current, {
            expectedRevision: current.revision, to: 'ready', now: Date.now(),
          })
          if (next.ok) moved = storage.commitTask(next.value)
          // 打回就是"这一版不要了，接着改"。那个还开着的测试环境跑的是上一版，
          // 留着它只会让人对着一个马上就要被改掉的页面继续验。
          if (moved) await testEnvs?.stop(taskId, 'verdict')
        }
        sendJson(res, 201, { comments: describeComments(storage, taskId), requeued: moved }, extraHeaders)
        return
      }
    }

    /*
     * ── 附件：列出 / 上传 ────────────────────────────────────
     *
     * 上传是**裸的请求体**，不是 multipart：一次一个文件，文件名走
     * `x-filename` 头（URI 编码，非 ASCII 的文件名只有这样才能安全过头部）。
     * 自己写一个 multipart 解析器是这个项目最不值得的那种代码 —— 而"零运行时
     * 依赖"这条线又不允许引一个库进来。前端本来就一个一个地传。
     *
     * `?scope=draft` 走的是讨论那一路：文件先落地、等留言发出去时再认领。
     * 两路共用这个口子是因为它们从头到尾是同一件事（收一份字节、记一条
     * 元数据），只有"挂在哪儿"和"什么时候能传"不一样。
     */
    const attachmentsOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/attachments$/)
    if (attachmentsOf !== null) {
      const taskId = asTaskId(decodeURIComponent(attachmentsOf))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      // 讨论里传的文件属于那条还没发出去的留言，不是需求的一部分 ——
      // 两路各看各的清单，谁也不该出现在对方的列表里。
      const draft = url.searchParams.get('scope') === 'draft'

      if (method === 'GET') {
        const listed = draft ? storage.listDraftAttachments(taskId) : storage.listAttachments(taskId)
        sendJson(res, 200, { attachments: listed.map(describeAttachment) }, extraHeaders)
        return
      }
      if (method === 'POST') {
        /*
         * 早退之前先**把请求体读完**。这些拒绝多半发生在几 MB 的文件正在路上
         * 的时候；不读完就应答，socket 会被连接层直接掐掉，客户端拿到的是一条
         * 网络错误而不是我们精心写的那句"这张卡正在执行"。
         */
        const refuse = (status: number, body: unknown): void => {
          req.resume()
          sendJson(res, status, body)
        }
        if (attachmentStore === undefined) {
          refuse(503, { error: 'no-attachments', detail: '当前实例没有配置附件存储' })
          return
        }
        /*
         * 冻结的规矩只管规格附件。
         *
         * 与「正在执行的卡不能改需求」同一条：附件是需求的一部分，Agent
         * 已经拿着 TASK.md 在干活了，此刻加一份材料只会让人和机器对着两份
         * 规格。归档的卡是冻结的，同理。
         *
         * **讨论不受这条约束**，因为留言本来就不受：跑着的时候看见哪儿不对
         * 顺手贴张图，和顺手留一句话是同一个动作，它们一起等下一轮被带走。
         */
        if (!draft && task.column === 'running') {
          refuse(422, { error: 'task-running', detail: '正在执行的卡片不能加附件，先终止执行' })
          return
        }
        if (!draft && task.archivedAt !== undefined) {
          refuse(422, { error: 'task-archived', detail: '这张卡已归档。要动它先取消归档' })
          return
        }
        const cap = draft ? MAX_ATTACHMENTS_PER_COMMENT : MAX_ATTACHMENTS_PER_TASK
        const existing = draft ? storage.listDraftAttachments(taskId) : storage.listAttachments(taskId)
        if (existing.length >= cap) {
          refuse(422, {
            error: 'too-many-attachments',
            detail: draft
              ? `一条留言最多带 ${String(cap)} 个附件`
              : `一张卡最多 ${String(cap)} 个附件`,
          })
          return
        }

        const header = req.headers['x-filename']
        const raw = typeof header === 'string' ? header : ''
        if (raw.trim().length === 0) {
          refuse(400, { error: 'bad-request', detail: '缺少 x-filename 头' })
          return
        }
        let declaredName: string
        try {
          declaredName = decodeURIComponent(raw)
        } catch {
          // 头部没编码好（或者根本不是 URI 编码）就按原文用，别为此拒收整个文件。
          declaredName = raw
        }
        const filename = safeFilename(declaredName)

        const bytes = await readRawBody(req, MAX_ATTACHMENT_BYTES)
        if (bytes.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '空文件' })
          return
        }

        const id = `a-${randomUUID().slice(0, 8)}`
        const mime = mimeOf(filename, req.headers['content-type'])
        // 先落字节再记库：反过来的话，写文件失败会留下一条指向空气的记录，
        // 而界面上它看起来和正常附件一模一样。
        const stored = await attachmentStore.save(taskId, id, filename, bytes)
        const attachment: Attachment = {
          id,
          taskId,
          // 库里记的是**用户原来的文件名**，落盘用的是压过的安全名 ——
          // 界面上该显示他自己起的那个名字。
          filename: declaredName.split(/[/\\]/).pop() ?? filename,
          mime,
          size: stored.size,
          path: stored.path,
          // 草稿先挂在空串上，等那条留言发出去再认领过去。
          ...(draft ? { commentId: DRAFT_COMMENT } : {}),
          at: Date.now(),
        }
        storage.addAttachment(attachment)
        sendJson(res, 201, { attachment: describeAttachment(attachment) }, extraHeaders)
        return
      }
    }

    // ── 附件：取内容 / 删除 ──────────────────────────────────
    const attachmentId = matchPath(pathname, /^\/api\/attachments\/([^/]+)$/)
    if (attachmentId !== null) {
      const attachment = storage.getAttachment(decodeURIComponent(attachmentId))
      if (attachment === null) { sendJson(res, 404, { error: 'attachment-not-found' }); return }

      if (method === 'GET') {
        /*
         * **先拿到 fd，再决定状态码。**
         *
         * 换成 `stat` 之后再 `createReadStream` 有两个毛病，而且都是真会发生的：
         *
         * 1. 两步之间有一道缝。同一时刻另一个请求走 DELETE 把文件删掉（看板
         *    上的 `<img>` 请求和人点的删除按钮完全可能撞上），或者文件根本
         *    打不开（权限被改过），`createReadStream` 就会**异步**抛出一个
         *    没人接的 `'error'` 事件 —— `pipe()` 不转发源端错误，外面的
         *    try/catch 也接不到，结果是整个进程被 uncaughtException 带走，
         *    看板没了，正在跑的 Agent 全部失去托管。
         * 2. 那时头已经发出去了，想改成 410 也来不及。
         *
         * 拿着 fd 就没有这道缝：POSIX 下文件即使随后被 unlink，这个 fd 仍然
         *读得到完整内容；打不开则在写任何响应头之前就知道了。
         */
        const handle = await open(attachment.path, 'r').catch(() => null)
        if (handle === null) {
          // 文件被外力删了，或者读不了。说清楚是哪一种缺失，
          // 比让浏览器拿到一个空响应强。
          sendJson(res, 410, { error: 'attachment-gone', detail: '这个附件的文件已经读不出来了' })
          return
        }
        const file = await handle.stat().catch(() => null)
        if (file?.isFile() !== true) {
          // 目录也能 open 成功，所以这一步仍要问一句它到底是不是文件。
          await handle.close().catch(() => undefined)
          sendJson(res, 410, { error: 'attachment-gone', detail: '这个附件的文件已经读不出来了' })
          return
        }
        res.writeHead(200, {
          'content-type': attachment.mime,
          // 长度来自这个 fd 自己的 stat，和接下来读到的字节必然一致。
          'content-length': file.size,
          // 只有图片和 PDF 内联；别的一律下载。附件和看板同源，一个能在
          // 页面里跑起来的附件就能拿着 cookie 调本机的执行接口。
          'content-disposition': `${canInline(attachment.mime) ? 'inline' : 'attachment'}; `
            + `filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
          // 不许浏览器自作主张改判类型 —— 上面那条允许清单就白设了。
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          ...extraHeaders,
        })
        const stream = handle.createReadStream()
        // 读到一半的 I/O 错误仍然可能发生（坏扇区、网络盘掉线）。此刻头
        // 已经发出去了，改不了状态码，只能掐断连接让客户端知道这次没传完
        // —— 但**这个监听必须在**：少了它，一个读错误就是一次进程退出。
        stream.on('error', (error: unknown) => {
          console.error(`[loopkanban] 附件读取中断 ${attachment.id}:`, error)
          res.destroy()
        })
        // 客户端提前断开（关标签页、取消下载）时把读流也收掉，
        // 否则它会攥着一个 fd 把整个文件读完再扔掉。
        res.on('close', () => { stream.destroy() })
        stream.pipe(res)
        return
      }

      if (method === 'DELETE') {
        const owner = storage.getTask(attachment.taskId)
        /*
         * 已经跟着留言发出去的附件撤不回。
         *
         * 讨论是一份记录：话说出去了改不了，话里带的那张图自然也不该消失
         * —— 底下若还接着 Agent 的回复，抽掉它就等于让那段对话失去依据。
         * 要更正就再留一条，这也正是这条线程本来的用法。
         */
        if (attachment.commentId !== undefined && attachment.commentId !== DRAFT_COMMENT) {
          sendJson(res, 422, {
            error: 'attachment-sent', detail: '这个附件已经跟着留言发出去了，讨论是一份记录，撤不回来',
          })
          return
        }
        // 冻结只管规格附件：草稿附件和留言一样，跑着的时候也能收拾 ——
        // 它要到下一轮才被带走，此刻动它谁也不碍着。
        if (attachment.commentId === undefined && owner?.column === 'running') {
          sendJson(res, 422, { error: 'task-running', detail: '正在执行的卡片不能删附件，先终止执行' })
          return
        }
        // 归档的卡是冻结的，删附件和加附件同属"改需求"，两边必须同一套规矩
        // —— 上传拒了、删除放行，等于让归档这个动作只挡住一半。
        if (attachment.commentId === undefined && owner?.archivedAt !== undefined) {
          sendJson(res, 422, { error: 'task-archived', detail: '这张卡已归档。要动它先取消归档' })
          return
        }
        // 库先删：记录没了，界面上它就不在了；磁盘上的字节即使删不掉，
        // 也只是一个没人再引用的文件，不会让人对着一个点不开的附件发懵。
        const removed = storage.deleteAttachment(attachment.id)
        if (removed && attachmentStore !== undefined) await attachmentStore.remove(attachment.path)
        sendJson(res, removed ? 200 : 404, { deleted: removed }, extraHeaders)
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
      // permission 的取值在这里把关：不认识的档位当场拒绝，而不是存进库
      // 里等派活时才炸。空串等价于"回到默认"，归一成 undefined（清空）。
      if ('permission' in rest) {
        const asked = rest['permission']
        if (asked !== null && (typeof asked !== 'string' || !(PERMISSION_TIERS as readonly string[]).includes(asked))) {
          sendJson(res, 422, {
            error: 'bad-permission',
            detail: `没有 ${String(asked)} 这一档，只能是：${PERMISSION_TIERS.join(' / ')}`,
          })
          return
        }
        if (asked === null || asked === '') rest['permission'] = null
      }
      // 执行器也在这儿把关：指着一个不存在的执行器，那张卡会在派活时静悄悄
      // 退回默认执行器 —— 存下去比当场拒绝更难查。空串同 null，都是"不再指定"。
      if ('executorId' in rest) {
        const asked = rest['executorId']
        if (asked !== null && asked !== '') {
          if (typeof asked !== 'string' || storage.getExecutor(asExecutorId(asked)) === null) {
            sendJson(res, 422, { error: 'executor-not-found', detail: `没有 ${String(asked)} 这个执行器` })
            return
          }
        }
        if (asked === null || asked === '') rest['executorId'] = null
      }
      // null 意为"清空这个字段"。字段缺席只意味着"这次没提到它"，两者不能混为
      // 一谈 —— JSON 里没有 undefined，客户端要清空只能显式送 null。
      const edit = Object.fromEntries(
        Object.entries(rest).map(([key, value]) => [key, value === null ? undefined : value]),
      ) as TaskEdit
      // 关联要单独过一遍：那几个 id 是否真的存在、是否同项目，领域层看不到
      // 别的卡，答不上来。**清空写成空数组而不是 undefined** —— 后者在
      // editTask 眼里是"这次没提到关联"，于是"取消全部关联"永远存不下去。
      let checked = edit
      if ('relatedTo' in rest) {
        const related = resolveRelated(rest['relatedTo'], storage.listTasks(task.projectId), task.id)
        if (!related.ok) {
          sendJson(res, related.error === 'bad-request' ? 400 : 422, {
            error: related.error, detail: related.detail,
          })
          return
        }
        checked = { ...edit, relatedTo: related.ids }
      }
      // 依赖的校验比关联多一层：成环的依赖链永远解不开，存进去等于让这张卡
      // 从队列里无声消失。拒绝是整批的 —— 半截依赖比没有依赖更难查。
      if ('blockedBy' in rest) {
        const everyone = storage.listTasks()
        const blocked = resolveBlocked(
          rest['blockedBy'],
          everyone.filter((other) => other.projectId === task.projectId),
          task.id,
          everyone,
        )
        if (!blocked.ok) {
          sendJson(res, blocked.error === 'bad-request' ? 400 : 422, {
            error: blocked.error, detail: blocked.detail,
          })
          return
        }
        checked = { ...checked, blockedBy: blocked.ids }
      }
      const edited = editTask(task, { expectedRevision, edit: checked, now: Date.now() })
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

      // 别的卡对它的引用要一并摘掉：依赖留着一个查无此卡的 id，那些卡会永远
      // 停在"依赖未完成"，而界面上没有任何操作能解开它；关联留着则会把一段
      // 指向不存在之物的需求写进 TASK.md。
      const now = Date.now()
      const cascade = storage.listTasks(task.projectId)
        .filter((other) => other.id !== task.id)
        .map((other) => dropReferences(other, task.id, now))
        .filter((next): next is Task => next !== null)
      // Run 要在删库之前读出来 —— 删完就查不到该收拾哪些 worktree 了。
      const runs = storage.listRuns(task.id)

      if (!storage.deleteTask(task.id, expectedRevision, cascade)) {
        sendJson(res, 409, { error: 'revision-conflict', detail: '这张卡刚被他人改动，请重读后重试' })
        return
      }
      // 同 accept / discard：状态先落定，不可逆的删除在后。反过来的话一次
      // CAS 冲突就会留下"worktree 没了、卡还在"的残局。
      // purge 会删掉 worktree，所以跑在里面的测试环境必须先停。
      await testEnvs?.stop(task.id, 'verdict')
      if (review !== undefined) await review.purge(task, runs)
      // 附件的字节也跟着卡一起走。库里的记录已经在事务里删掉了。
      if (attachmentStore !== undefined) await attachmentStore.removeTask(task.id)
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
      // 用拖的把卡挪出 Review，跟按下验收按钮是同一个意思：这张卡判完了。
      // 只认"离开 Review"，列内换位置不动它 —— 那只是在排序。
      if (task.column === 'review' && moved.value.column !== 'review') {
        await testEnvs?.stop(task.id, 'verdict')
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

    /*
     * 预览工作区里的一个文件。
     *
     * Agent 常常把方案写成一份文档再在讨论里给出路径 —— 那条路径指向的是它
     * 自己的 worktree，浏览器打不开。够得着的范围只有这张卡历次执行的
     * worktree 与项目仓库，越界一律拒绝（细则见 `preview.ts`）。
     */
    /**
     * 同一份文件的原始字节。PDF 与图片走这里 —— 预览接口只回文本与文档树。
     *
     * 围栏跟预览接口共用 `resolvePreviewTarget`，不是各写一遍：这两条路
     * 只要有一天走岔，其中一条就是个能读任意文件的洞。
     */
    const rawOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/file\/raw$/)
    if (method === 'GET' && rawOf !== null) {
      const taskId = asTaskId(decodeURIComponent(rawOf))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }

      const found = await resolvePreviewTarget(url.searchParams.get('path') ?? '', reachableRoots(task))
      if (!found.ok) {
        sendJson(res, found.reason === 'path-outside-workspace' ? 422 : 404, {
          error: found.reason, detail: found.detail,
        })
        return
      }
      // 读的是解完符号链接那条（真正的文件），报的名字用原路径的末段。
      await streamRaw(found.target.real, basename(found.target.path))
      return
    }

    const fileOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/file$/)
    if (method === 'GET' && fileOf !== null) {
      const taskId = asTaskId(decodeURIComponent(fileOf))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }

      const found = await readFilePreview(url.searchParams.get('path') ?? '', reachableRoots(task))
      if (!found.ok) {
        // 越界是「这个请求本身不成立」，不是「东西不在」——分开报，不然
        // 界面只能笼统地说一句打不开。
        const status = found.reason === 'path-outside-workspace' ? 422
          : found.reason === 'not-text' ? 415
          // 「这是份 Word 但读不出来」跟「这个格式看不了」不是一回事，
          // 混成同一个码，界面就只能笼统地说一句打不开。
          : found.reason === 'bad-document' ? 422
          : found.reason === 'too-large' ? 413
          : found.reason === 'unreadable' ? 403
          : 404
        sendJson(res, status, { error: found.reason, detail: found.detail })
        return
      }
      sendJson(res, 200, { file: found.file }, extraHeaders)
      return
    }

    /*
     * ── Pull Request ────────────────────────────────────────
     *
     * GET  列出这张卡的 PR，外加"这个仓库能不能开 PR"。
     * POST 开一条：提交 → 跟上基线 → 推 → gh pr create。合不合由人在 GitHub
     *      上决定，我们只在它真的合上之后把卡收进 Done。
     * POST …/sync 问一遍现在怎么样了，顺带做那次收尾。
     */
    const prSync = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/prs\/sync$/)
    if (method === 'POST' && prSync !== null) {
      if (review === undefined) { sendJson(res, 503, { error: 'no-review' }); return }
      const taskId = asTaskId(decodeURIComponent(prSync))
      if (storage.getTask(taskId) === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      const result = await review.syncPullRequests(taskId)
      sendJson(res, 200, {
        prs: storage.listPullRequests(taskId),
        collected: result.collected,
        task: storage.getTask(taskId),
      }, extraHeaders)
      return
    }

    const prsOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/prs$/)
    if (prsOf !== null) {
      const taskId = asTaskId(decodeURIComponent(prsOf))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }
      if (review === undefined) { sendJson(res, 503, { error: 'no-review' }); return }

      if (method === 'GET') {
        sendJson(res, 200, {
          prs: storage.listPullRequests(taskId),
          capability: await review.pullRequestCapability(task.repoPath),
        }, extraHeaders)
        return
      }

      if (method === 'POST') {
        const result = await review.openPullRequest(taskId)
        if (!result.ok) {
          /*
           * 冲突是**有下一步**的失败：改动已经提交在分支上，冲突原样留在
           * 工作区里，卡也已经回了队列。既然本机就有 Agent，直接把这一轮派
           * 出去 —— 让用户回看板再点一次"派活"，只是把一个我们已经知道该做
           * 的动作推给他。派不出去（没装 CLI、卡刚被人动过）也不改变结论：
           * 冲突这件事本身已经如实报了。
           */
          let dispatched: string | undefined
          if (result.reason === 'merge-conflict' && result.requeued === true && runner !== undefined) {
            const started = await runner.start(taskId)
            if (started.ok) dispatched = started.run.id
          }
          sendJson(res, result.reason === 'revision-conflict' ? 409 : 422, {
            error: result.reason,
            detail: result.detail,
            ...(result.files === undefined ? {} : { files: result.files }),
            ...(result.requeued === undefined ? {} : { requeued: result.requeued }),
            ...(dispatched === undefined ? {} : { dispatched }),
          })
          return
        }
        sendJson(res, 201, {
          pr: result.pr,
          created: result.created,
          commit: result.commit,
          prs: storage.listPullRequests(taskId),
          task: storage.getTask(taskId),
        }, extraHeaders)
        return
      }
    }

    /*
     * ── 一键测试环境：起 / 看 / 停 ───────────────────────────
     *
     * 起在这张卡自己的 worktree 里，端口由 host 分配。**事件流那条连接就是
     * 心跳** —— 关掉面板、关掉标签页之后没人再订阅，环境会自己被收掉，
     * 不必让人记得回来按停止。
     */
    const envOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/testenv$/)
    if (envOf !== null) {
      if (testEnvs === undefined) { sendJson(res, 503, { error: 'no-testenv' }); return }
      const taskId = asTaskId(decodeURIComponent(envOf))

      if (method === 'GET') {
        // 没有环境不是错：界面据此显示"未启动"。给 404 会逼前端把正常状态
        // 当成异常来处理。
        sendJson(res, 200, { env: testEnvs.view(taskId) }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const started = await testEnvs.start(taskId)
        if (!started.ok) {
          sendJson(res, started.reason === 'task-not-found' ? 404 : 422, {
            error: started.reason, detail: started.detail,
          })
          return
        }
        sendJson(res, 201, { env: started.env }, extraHeaders)
        return
      }
      if (method === 'DELETE') {
        // 本来就没有环境也是 200：那是"它已经停了"这个完全正常的结果，同上面的
        // GET。回 404 的话前端只能把它当异常抛出来，而 404 的响应体里没有
        // `error` 字段，界面最后显示的是一句没有对应文案的 "unknown"。
        const stopped = await testEnvs.stop(taskId, 'manual')
        sendJson(res, 200, { stopped, env: testEnvs.view(taskId) }, extraHeaders)
        return
      }
    }

    const envStream = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/testenv\/events$/)
    if (method === 'GET' && envStream !== null) {
      if (testEnvs === undefined) { sendJson(res, 503, { error: 'no-testenv' }); return }
      streamTestEnv(req, res, asTaskId(decodeURIComponent(envStream)), testEnvs)
      return
    }

    // ── 验收：通过 / 废弃 ───────────────────────────────────
    const verdict = /^\/api\/tasks\/([^/]+)\/(accept|discard)$/.exec(pathname)
    if (method === 'POST' && verdict !== null) {
      if (review === undefined) { sendJson(res, 503, { error: 'no-review' }); return }
      const taskId = asTaskId(decodeURIComponent(verdict[1] as string))
      const body = await readJsonBody(req) as { merge?: boolean } | undefined

      /*
       * 测试环境由 Review 自己在动 worktree 之前收掉（`ReviewOptions.beforeMutate`）。
       * **不在这儿先斩后奏**：验收会因为主工作区脏、卡被人改过这些原因被拒，
       * 而在门口就把环境杀掉的话，一次被拒的验收会顺手弄没人正在用的试跑环境，
       * 让他重新装一遍依赖 —— 明明这张卡一个字都没动过。
       */
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

    /*
     * ── 决策：权限审批 / 向人提问 ───────────────────────────
     *
     * 四条路，两种身份：
     *
     *   POST   /api/runs/:id/decisions           gate shim 创建（bearer）
     *   GET    /api/runs/:id/decisions/:decId    gate shim 轮询（bearer + 界面恢复）
     *   GET    /api/runs/:id/decisions           界面列出
     *   POST   /api/runs/:id/decisions/:decId    界面拍板
     *
     * 创建与拍板的负载校验都做在路由里：shim 那头是 Agent 的输出，形状
     * 不能信；界面这头要给出人能读懂的拒绝理由。
     */
    const decisionsOf = matchPath(pathname, /^\/api\/runs\/([^/]+)\/decisions$/)
    if (decisionsOf !== null) {
      const runId = asRunId(decodeURIComponent(decisionsOf))
      if (decisions === undefined) { sendJson(res, 503, { error: 'no-decisions' }); return }
      if (storage.getRun(runId) === null) { sendJson(res, 404, { error: 'run-not-found' }); return }

      if (method === 'GET') {
        sendJson(res, 200, { decisions: decisions.list(runId) }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as { kind?: string; payload?: unknown } | undefined
        if (body?.kind !== 'permission' && body?.kind !== 'question') {
          sendJson(res, 422, { error: 'bad-kind', detail: "kind 只能是 'permission' 或 'question'" })
          return
        }
        try {
          const decision = decisions.create(runId, { kind: body.kind, payload: body.payload })
          sendJson(res, 201, { decision }, extraHeaders)
        } catch (error) {
          if (!(error instanceof DecisionInputError)) throw error
          sendJson(res, 422, { error: 'bad-payload', detail: error.message })
        }
        return
      }
    }

    // 这里要两个捕获组（run id + decision id），matchPath 只回第一个组 —— 直接用正则。
    const decisionTarget = /^\/api\/runs\/([^/]+)\/decisions\/([^/]+)$/.exec(pathname)
    if (decisionTarget !== null) {
      if (decisions === undefined) { sendJson(res, 503, { error: 'no-decisions' }); return }
      const runId = asRunId(decodeURIComponent(decisionTarget[1] as string))
      const id = decodeURIComponent(decisionTarget[2] as string)
      const decision = decisions.get(runId, id)
      if (decision === null) { sendJson(res, 404, { error: 'decision-not-found' }); return }

      if (method === 'GET') {
        sendJson(res, 200, { decision }, extraHeaders)
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req) as
          { decision?: string; scope?: string; answer?: string } | undefined
        let status: 'allowed' | 'denied' | 'answered'
        let answer: unknown
        let scope: 'once' | 'run' = 'once'
        if (decision.kind === 'permission') {
          // 权限的拍板必须明确 allow/deny —— 没有"算了"这个选项。
          if (body?.decision !== 'allow' && body?.decision !== 'deny') {
            sendJson(res, 422, { error: 'bad-decision', detail: "权限请求要明确 decision: 'allow' 或 'deny'" })
            return
          }
          status = body.decision === 'allow' ? 'allowed' : 'denied'
          scope = body.scope === 'run' ? 'run' : 'once'
          answer = {
            decision: body.decision,
            scope,
            ...(typeof body['answer'] === 'string' && body.answer.length > 0 ? { message: body.answer } : {}),
          }
        } else {
          const text = body?.answer
          if (typeof text !== 'string' || text.trim().length === 0) {
            sendJson(res, 422, { error: 'bad-answer', detail: '回答不能是空的' })
            return
          }
          status = 'answered'
          answer = { text: text.trim() }
        }
        // 已被处理过（并发点了两下、或超时刚收场）是 409：重读后就没有
        // 任何可做的了，不是"再试一次"的问题。
        const settled = decisions.resolve(runId, id, { status, answer }, scope)
        if (settled === null) {
          sendJson(res, 409, { error: 'already-resolved', detail: '这条决策已经被处理过了' })
          return
        }
        sendJson(res, 200, { decision: settled }, extraHeaders)
        return
      }
    }

    // ── Run 详情 ────────────────────────────────────────────
    const runId = matchPath(pathname, /^\/api\/runs\/([^/]+)$/)
    if (method === 'GET' && runId !== null) {
      const run = storage.getRun(asRunId(decodeURIComponent(runId)))
      if (run === null) { sendJson(res, 404, { error: 'run-not-found' }); return }
      sendJson(res, 200, { run }, extraHeaders)
      return
    }

    /*
     * ── 事件日志（一次性读取）────────────────────────────────
     *
     * 与下面的 SSE 同源同数据，区别只在"谁在等谁"：浏览器开着面板，推给它
     * 最省事；而 MCP 那边的调用方是一次问一句的 Agent，给它开一条流等于让它
     * 抱着一个永远不结束的响应。`after` 与 SSE 的 `Last-Event-ID` 是同一个
     * 游标，所以轮询与订阅之间可以无缝接上。
     */
    const logOf = matchPath(pathname, /^\/api\/runs\/([^/]+)\/log$/)
    if (method === 'GET' && logOf !== null) {
      const id = asRunId(decodeURIComponent(logOf))
      if (storage.getRun(id) === null) { sendJson(res, 404, { error: 'run-not-found' }); return }
      const asked = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
      // 消毒过的游标只算一次，后面一律用它 —— 分两处算的话，`?after=abc`
      // 会让 lastSeq 变成 NaN（JSON 里就是 null），调用方拿它回问等于从头重来。
      const after = Number.isFinite(asked) ? asked : 0
      // 一次跑几万条事件是常事，整段回给调用方只会撑爆它的上下文。截断在
      // **SQL 里**做（见 readRecentEvents），并且留最新的那一段 —— Agent 要的是
      // "现在到哪儿了"；说清楚丢了多少，下一次拿 lastSeq 接着问就是。
      const { events, total } = storage.readRecentEvents(id, after, EVENT_PAGE)
      sendJson(res, 200, {
        events,
        lastSeq: events.at(-1)?.seq ?? after,
        truncated: total > events.length,
      }, extraHeaders)
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

  /**
   * 终端会话的事件流。
   *
   * 和 Run 的流有一处关键不同：**这一头是有背压的**。`res.write` 写不动
   * （内核缓冲满了、页面在别的标签页里被节流）时就把子进程的输出暂停下来，
   * 排空了再放开 —— 终端本来就是这么工作的，读得慢，写的人就该被堵住。
   * 少了这一层，一条 `find /` 会在服务端攒出几百兆待发数据。
   */
  function streamShell(
    req: IncomingMessage,
    res: ServerResponse,
    session: ShellSession,
    after: number,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    // 两个游标取大的那个：`after` 是页面开新连接时给的，`Last-Event-ID` 是
    // 浏览器自己重连时补的。谁更靠后就从谁之后接着发。
    const lastHeader = req.headers['last-event-id']
    const lastSeq = typeof lastHeader === 'string' ? Number.parseInt(lastHeader, 10) : 0
    let cursor = Math.max(after, Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0)
    let held = false

    const write = (event: ShellEvent): void => {
      cursor = Math.max(cursor, event.seq)
      const room = res.write(
        `id: ${String(event.seq)}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.payload)}\n\n`,
      )
      // 会话没了，这条流也就没有对端了 —— 把它收掉，别留一个心跳还在响、
      // 后面永远不会再有内容的连接。
      if (event.kind === 'closed') { res.end(); return }
      if (room || held) return
      held = true
      session.hold()
      res.once('drain', () => {
        if (!held) return
        held = false
        session.release()
      })
    }

    // 先补回放，再报快照，最后接实时。
    //
    // 快照必须在回放**之后**：断线的这段时间里命令可能已经跑完了，而回放
    // 缓冲装不下全部历史，那条 `began` 也许早被挤掉。以快照为准，页面才不会
    // 对着一条其实已经结束的命令一直显示"执行中"。
    //
    // 它不带 `id:` —— 这不是一条历史事件，不该顶掉重连时的游标。
    for (const event of session.replay(cursor)) write(event)
    res.write(`event: state\ndata: ${JSON.stringify(session.snapshot())}\n\n`)

    // 这中间没有 await，所以「补完历史」与「接上实时」之间不存在缝隙。
    const unsubscribe = session.subscribe((event) => {
      if (event.seq > cursor) write(event)
    })

    const heartbeat = setInterval(() => { res.write(': ping\n\n') }, heartbeatMs)
    heartbeat.unref()
    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
      // 断开的订阅者不能把命令永远堵在那儿 —— 它已经没人读了。
      if (held) { held = false; session.release() }
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  /**
   * 测试环境的事件流：状态变化与日志。
   *
   * 与 Run 的事件流有一处根本不同：**这条连接是有副作用的**。它是"还有人在看"
   * 的唯一凭据，断开即开始收尸倒计时（见 `TestEnvs.subscribe`）。所以这里
   * 一定要把 `close` 接好 —— 漏掉的话，那个环境会一直以为有人看着。
   */
  function streamTestEnv(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: ReturnType<typeof asTaskId>,
    envs: TestEnvs,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const lastHeader = req.headers['last-event-id']
    const lastSeq = typeof lastHeader === 'string' ? Number.parseInt(lastHeader, 10) : 0
    const from = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0

    const unsubscribe = envs.subscribe(taskId, from, (event) => {
      res.write(`id: ${String(event.seq)}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
    })

    const heartbeat = setInterval(() => { res.write(': ping\n\n') }, heartbeatMs)
    heartbeat.unref()
    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
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
    close: async () => {
      // 先收终端会话与测试环境：它们手里攥着真实的进程树（`npm run dev`
      // 就是典型），关掉 HTTP 端口不会让它们退出，只会让它们变成没人认领
      // 的孤儿 —— 而那时已经没有任何界面能再找到它们了。
      await Promise.all([shells.dispose(), testEnvs?.stopAll('shutdown')])
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { error === undefined ? resolve() : reject(error) })
        server.closeAllConnections()
      })
    },
  }
}

export { RunBus } from './bus.ts'
export * from './auth.ts'
