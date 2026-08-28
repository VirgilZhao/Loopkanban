/**
 * MCP server 用来跟看板说话的客户端。
 *
 * **走 HTTP，不直接开数据库。** 直连 SQLite 看起来更省事，但派活要 Runner
 * （worktree、子进程、租约续期都在它手上），而 Runner 只活在看板那个进程里。
 * 一个能读能写却派不了活的 MCP 是半个东西；更糟的是两个进程各写一份状态，
 * CAS 还在、事件总线却不在，界面上会看到一张自己动起来的卡。
 *
 * 所以这一层只做三件事：找到看板、带上 token、把 4xx 翻译成能照做的话。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TOKEN_COOKIE } from '../server/auth.ts'
import { endpointPath, readEndpoint } from '../server/endpoint.ts'

/** 看板拒绝了这次调用。带着状态码与它自己的错误码，交给工具层照实回给 Agent。 */
export class BoardError extends Error {
  readonly status: number
  readonly code: string

  // 参数属性（`constructor(readonly x)`）在 node 的 strip-only 模式下跑不起来，
  // 而 core 与 host 开发时就直接跑在它上面 —— vitest 走 esbuild 能编过，真正
  // 启动时才会炸。字段老老实实写出来。
  constructor(status: number, code: string, detail: string) {
    super(detail)
    this.name = 'BoardError'
    this.status = status
    this.code = code
  }
}

/** 连不上看板。与"看板说不行"是两回事：这条要人去把看板打开。 */
export class BoardUnreachable extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'BoardUnreachable'
  }
}

export interface BoardClientOptions {
  /** 形如 `http://127.0.0.1:52341`。 */
  readonly baseUrl: string
  readonly token: string
  /** 供测试注入。 */
  readonly fetch?: typeof globalThis.fetch
}

export class BoardClient {
  private readonly options: BoardClientOptions

  constructor(options: BoardClientOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') }
  }

  get baseUrl(): string {
    return this.options.baseUrl
  }

  /**
   * 发一次请求。
   *
   * token 走 cookie 而不是查询串：查询串会进 access log、进 shell 历史，
   * 而这个 token 等于一台机器上的执行权限。
   *
   * @param method - HTTP 方法。
   * @param path - 以 `/api/` 开头的路径。
   * @param body - JSON 请求体；不给则不带。
   * @throws BoardUnreachable 连不上；BoardError 看板明确拒绝。
   */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.options.fetch ?? globalThis.fetch
    let res: Response
    try {
      res = await doFetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          cookie: `${TOKEN_COOKIE}=${encodeURIComponent(this.options.token)}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new BoardUnreachable(
        `连不上 ${this.options.baseUrl}：${error instanceof Error ? error.message : String(error)}。`
        + '看板可能没在跑 —— 先 `loopkanban` 起一个。',
      )
    }
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      throw new BoardError(
        res.status,
        String(payload['error'] ?? 'unknown'),
        String(payload['detail'] ?? res.statusText),
      )
    }
    return payload as T
  }

  get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.call<T>('POST', path, body ?? {})
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('PATCH', path, body)
  }
}

export interface DiscoverOptions {
  /** 数据目录，`endpoint.json` 与 `token` 都在里面。 */
  readonly dataDir: string
  /** 覆盖地址，对应 `--url` / `LOOPKANBAN_URL`。 */
  readonly url?: string | undefined
  /** 覆盖 token，对应 `LOOPKANBAN_TOKEN`。 */
  readonly token?: string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/**
 * 那个进程还在吗。
 *
 * `signal 0` 不真的发信号，只做一次"存在且我够得着"的检查。EPERM 表示进程
 * 在、只是不归我们管，那也算活着。
 */
function isAlive(pid: number): boolean {
  // 0 是"这条记录没写 pid"（旧版本或手写的文件），不知道就不拦。
  if (pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 先确认对面真的是 LoopKanban，**再把 token 交出去**。
 *
 * 地址文件是崩溃时留不下遗言的：被 SIGKILL 掉、机器断电，`clearEndpoint`
 * 都没机会跑，文件就指着一个已经没人听的端口。而端口是会被回收的 —— 过一会儿
 * 那个号码可能属于另一个本机服务。此时若直接带着 cookie 去请求，我们就把
 * **一个能在这台机器上起 Agent、跑任意代码的凭据**递给了一个陌生进程；
 * 而它还长期有效（token 存在数据目录里，跨重启不变）。
 *
 * 所以先不带 token 问一句：看板会用 401 `missing-token` 认领自己，而这次
 * 问话一个秘密都不带 —— 端口真被别人占了的话，泄漏出去的只有"有人问过"。
 *
 * @param baseUrl - 待确认的地址。
 * @param doFetch - 供测试注入。
 * @throws BoardUnreachable 连不上，或者对面不是看板。
 */
async function probeBoard(baseUrl: string, doFetch: typeof globalThis.fetch): Promise<void> {
  let res: Response
  try {
    res = await doFetch(`${baseUrl}/api/state`)
  } catch (error) {
    throw new BoardUnreachable(
      `连不上 ${baseUrl}：${error instanceof Error ? error.message : String(error)}。`
      + '看板可能没在跑 —— 先 `loopkanban` 起一个。',
    )
  }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (res.status !== 401 || body['error'] !== 'missing-token') {
    throw new BoardUnreachable(
      `${baseUrl} 上应答的不是 LoopKanban（HTTP ${String(res.status)}）—— `
      + '多半是看板已经退出、这个端口被别的程序占了。没把 token 发出去；'
      + '先 `loopkanban` 起一个，或用 LOOPKANBAN_URL 指对地址。',
    )
  }
}

/**
 * 找到正在跑的看板。
 *
 * 顺序是「显式给的 → 数据目录里的记录」。找不到就抛，且**话要说到能照做**：
 * MCP server 是被客户端悄悄拉起来的，它的 stderr 多半没人看，一句"连接失败"
 * 会变成一个查不动的哑故障。
 *
 * 拿到地址之后还要过两道：写下它的进程还活着吗、那个端口上应答的真是看板吗。
 * 两道都是为了同一件事 —— **不把 token 递给一个不是看板的东西**。
 *
 * @param options - 数据目录与覆盖项。
 */
export async function discoverBoard(options: DiscoverOptions): Promise<BoardClient> {
  const { dataDir } = options
  const endpoint = await readEndpoint(dataDir)
  const url = options.url ?? endpoint?.url
  if (url === undefined) {
    throw new BoardUnreachable(
      `${join(dataDir, 'endpoint.json')} 不在 —— 看板没在跑，或者它用的是别的数据目录。`
      + '先 `loopkanban` 起一个；数据目录不一样时给 `--data <dir>`，或用 LOOPKANBAN_URL 直接指地址。',
    )
  }

  // 只在"照着地址文件走"时查 pid：显式给了 --url / LOOPKANBAN_URL 的人
  // 知道自己在连什么，那条记录说的是别的进程。
  if (options.url === undefined && endpoint !== null && !isAlive(endpoint.pid)) {
    throw new BoardUnreachable(
      `${endpointPath(dataDir)} 指向的进程 ${String(endpoint.pid)} 已经不在了 —— `
      + '看板多半是崩掉或被 kill 的，地址文件没来得及删。先 `loopkanban` 起一个，'
      + '它会把这个文件覆盖成新的。',
    )
  }

  const token = options.token
    ?? (await readFile(join(dataDir, 'token'), 'utf8').catch(() => null))?.trim()
  if (token === undefined || token === null || token.length === 0) {
    throw new BoardUnreachable(
      `${join(dataDir, 'token')} 读不出来 —— 没有 token 就进不去看板。`
      + '确认数据目录给对了，或用 LOOPKANBAN_TOKEN 直接给。',
    )
  }

  const client = new BoardClient({
    baseUrl: url,
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  // 握手在返回之前完成：调用方拿到的 client 是"已经确认过对面是谁"的，
  // 第一次真正带着 token 的请求才不会打在陌生人身上。
  await probeBoard(client.baseUrl, options.fetch ?? globalThis.fetch)
  return client
}
