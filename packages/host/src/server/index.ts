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
  archiveTask, asProjectId, asRunId, asTaskId, deleteTask, dropDependency, editTask, moveTask,
  unarchiveTask, type Column, type Task, type TaskEdit,
} from '@loopkanban/core'
import { AgentPool, type DetectedAgent } from '../agents/index.ts'
import {
  canInline, mimeOf, safeFilename, AttachmentStore,
  MAX_ATTACHMENTS_PER_TASK, MAX_ATTACHMENT_BYTES,
} from '../attachments/index.ts'
import type { Review } from '../review/index.ts'
import type { Runner } from '../runner/index.ts'
import type { Scheduler } from '../scheduler/index.ts'
import type { Attachment, Storage } from '../storage/index.ts'
import { branchExists, detectBaseBranch, isGitRepo, listBranches } from '../worktree/index.ts'
import { createToken, guardRequest, tokenCookieHeader } from './auth.ts'
import { browseDirectory, defaultBrowseRoot } from './browse.ts'
import { readFilePreview, resolvePreviewTarget } from './preview.ts'
import { RunBus } from './bus.ts'
import { runCommand } from './exec.ts'
import { confine, listFiles, listWorkspaces, readFileText, refusalFor } from './files.ts'

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
    // 档位名字对不上实际约束时的警示，UI 有义务展示 —— 不能吞掉。
    ...(caps.permissionCaveat === undefined ? {} : { permissionCaveat: caps.permissionCaveat }),
  }
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
    at: attachment.at,
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
  const agents = options.agents ?? AgentPool.of([])
  const runner = options.runner
  const review = options.review
  const scheduler = options.scheduler
  const attachmentStore = options.attachments
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
      // 带了几个附件也捎上：看板上那枚回形针得知道自己该不该出现，而为它
      // 单独开一轮请求（每张卡一次）就太贵了。只给数量，内容按需再取。
      const attachments: Record<string, number> = {}
      for (const task of tasks) {
        const count = storage.listAttachments(task.id).length
        if (count > 0) attachments[task.id] = count
        const runId = task.lease?.runId
        if (task.column !== 'running' || runId === undefined) continue
        const event = storage.lastEvent(runId)
        if (event !== null) live[task.id] = { kind: event.kind, payload: event.payload, at: event.at }
      }
      sendJson(res, 200, { projects: storage.listProjects(), tasks, live, attachments }, extraHeaders)
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
     * 在工作区里跑一条命令。
     *
     * 这是用户自己的手，不是 Agent 的 —— 他正在看某个 worktree，想 `git log`
     * 一下就得切出去开终端、再 cd 到那个七层深的路径。命令自己失败（非零退出）
     * 照样是 200：那是它的输出，不是我们的故障。
     */
    if (method === 'POST' && pathname === '/api/exec') {
      const body = (await readJsonBody(req) ?? {}) as Record<string, unknown>
      const command = typeof body['command'] === 'string' ? body['command'].trim() : ''
      if (command.length === 0) {
        sendJson(res, 422, { error: 'empty-command', detail: '要一条命令' })
        return
      }
      const roots = projectRoots()
      const askedRoot = typeof body['root'] === 'string' ? body['root'].trim() : ''
      const asked = typeof body['cwd'] === 'string' ? body['cwd'].trim() : ''
      const root = await confine(roots, askedRoot)
      if (root === null) { await refuse(roots, askedRoot, '只能在已登记项目的仓库里跑命令'); return }
      const cwd = asked.length === 0 ? root : await confine([root], asked)
      if (cwd === null) { await refuse([root], asked, '只能在已登记项目的仓库里跑命令'); return }

      /*
       * cwd 可能在你浏览的这会儿就没了 —— 废弃一张卡会连它的 worktree 一起删掉。
       * 不先探一下的话，spawn 会以 `spawn /bin/zsh ENOENT` 失败，而那句话把锅
       * 甩给了 shell：真正不见的是目录，用户照着去查 shell 只会白费一晚上。
       */
      if (!await stat(cwd).then((info) => info.isDirectory(), () => false)) {
        sendJson(res, 404, { error: 'no-such-dir', detail: `打不开 ${cwd}` })
        return
      }
      const timeout = typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : undefined
      sendJson(res, 200, await runCommand(command, cwd, timeout), extraHeaders)
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

      const body = await readJsonBody(req) as Partial<{ name: string; baseBranch: string }> | undefined
      const name = body?.name?.trim()
      const baseBranch = body?.baseBranch?.trim()
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
        const body = await readJsonBody(req) as
          (Partial<{ body: string }> & Record<string, unknown>) | undefined
        const text = body?.body?.trim() ?? ''
        if (text.length === 0) {
          sendJson(res, 400, { error: 'bad-request', detail: '留言不能为空' })
          return
        }

        // 留言可以顺带改「下一轮交给谁、用哪个模型」—— 说"再改一版"和"这次换个人干"
        // 本来就是同一句话，不该逼人先去规格里存一遍再回来发言。
        // 同 PATCH：字段缺席只意味着"这次没提到"，显式 null 才是"清空"。
        const edit: TaskEdit = {
          ...(body !== undefined && 'preferredProvider' in body
            ? { preferredProvider: (body['preferredProvider'] as string | null) ?? undefined }
            : {}),
          ...(body !== undefined && 'model' in body
            ? { model: (body['model'] as string | null) ?? undefined }
            : {}),
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
        if (current.column === 'review') {
          const next = moveTask(current, {
            expectedRevision: current.revision, to: 'ready', now: Date.now(),
          })
          if (next.ok) moved = storage.commitTask(next.value)
        }
        sendJson(res, 201, { comments: storage.listComments(taskId), requeued: moved }, extraHeaders)
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
     */
    const attachmentsOf = matchPath(pathname, /^\/api\/tasks\/([^/]+)\/attachments$/)
    if (attachmentsOf !== null) {
      const taskId = asTaskId(decodeURIComponent(attachmentsOf))
      const task = storage.getTask(taskId)
      if (task === null) { sendJson(res, 404, { error: 'task-not-found' }); return }

      if (method === 'GET') {
        sendJson(res, 200, { attachments: storage.listAttachments(taskId).map(describeAttachment) }, extraHeaders)
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
        // 与「正在执行的卡不能改需求」同一条规矩：附件就是需求的一部分，
        // Agent 已经拿着 TASK.md 在干活了，此刻加一份材料只会让人和机器
        // 对着两份规格。归档的卡是冻结的，同理。
        if (task.column === 'running') {
          refuse(422, { error: 'task-running', detail: '正在执行的卡片不能加附件，先终止执行' })
          return
        }
        if (task.archivedAt !== undefined) {
          refuse(422, { error: 'task-archived', detail: '这张卡已归档。要动它先取消归档' })
          return
        }
        const existing = storage.listAttachments(taskId)
        if (existing.length >= MAX_ATTACHMENTS_PER_TASK) {
          refuse(422, {
            error: 'too-many-attachments',
            detail: `一张卡最多 ${String(MAX_ATTACHMENTS_PER_TASK)} 个附件`,
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
        if (owner?.column === 'running') {
          sendJson(res, 422, { error: 'task-running', detail: '正在执行的卡片不能删附件，先终止执行' })
          return
        }
        // 归档的卡是冻结的，删附件和加附件同属"改需求"，两边必须同一套规矩
        // —— 上传拒了、删除放行，等于让归档这个动作只挡住一半。
        if (owner?.archivedAt !== undefined) {
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
