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
import { readEndpoint } from '../server/endpoint.ts'

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
 * 找到正在跑的看板。
 *
 * 顺序是「显式给的 → 数据目录里的记录」。找不到就抛，且**话要说到能照做**：
 * MCP server 是被客户端悄悄拉起来的，它的 stderr 多半没人看，一句"连接失败"
 * 会变成一个查不动的哑故障。
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

  const token = options.token
    ?? (await readFile(join(dataDir, 'token'), 'utf8').catch(() => null))?.trim()
  if (token === undefined || token === null || token.length === 0) {
    throw new BoardUnreachable(
      `${join(dataDir, 'token')} 读不出来 —— 没有 token 就进不去看板。`
      + '确认数据目录给对了，或用 LOOPKANBAN_TOKEN 直接给。',
    )
  }

  return new BoardClient({
    baseUrl: url,
    token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
}
