/**
 * 本地 server 的访问守卫。
 *
 * 这是整个项目**攻击面最大**的地方：一个能起 Agent、改代码、执行命令的
 * HTTP 接口跑在你机器上。相比桌面应用，这是多出来的风险，必须在第一版就
 * 做对，不能留到以后补。
 *
 * 三道关，缺一不可：
 *
 * 1. **只 bind `127.0.0.1`**（在 server 层强制，不在这里）。远程访问一律
 *    走 SSH 端口转发，绝不 `0.0.0.0`。
 * 2. **校验 `Host` / `Origin`**，防 DNS rebinding。攻击者让 `evil.com`
 *    解析到 `127.0.0.1`，浏览器就会带着 `Host: evil.com` 打你的本地接口；
 *    只放行 `127.0.0.1` / `localhost` 才能挡住。**光有 token 挡不住它**，
 *    因为 cookie 会被浏览器自动带上。
 * 3. **一次性随机 token**，进程启动时生成，随 URL 交给浏览器后转存
 *    httpOnly cookie。常数时间比较，避免计时侧信道。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** cookie 名。带 `__Host-` 前缀在 https 下才有意义，本地 http 用普通名。 */
export const TOKEN_COOKIE = 'loopkanban_token'

/** 只有这两个主机名被认为是"本机"。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type GuardFailure =
  | 'bad-host'
  | 'bad-origin'
  | 'missing-token'
  | 'bad-token'

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly reason: GuardFailure; readonly detail: string }

const deny = (status: number, reason: GuardFailure, detail: string): GuardResult =>
  ({ ok: false, status, reason, detail })

/** 生成一次性会话 token。 */
export function createToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 常数时间比较，长度不同直接判否。 */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 从 `Cookie` 头里取一个值。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}

/** 拆出主机名部分（去掉端口）。IPv6 字面量保留方括号。 */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end < 0 ? hostHeader : hostHeader.slice(0, end + 1)
  }
  const colon = hostHeader.lastIndexOf(':')
  return colon < 0 ? hostHeader : hostHeader.slice(0, colon)
}

/** 该主机名是否是本机。 */
function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase())
}

export interface GuardConfig {
  readonly token: string
  readonly port: number
  /**
   * 只认 cookie 里的 token，无视 URL 上的同名参数。
   *
   * 给 WebSocket 升级用：vite 的 HMR 客户端会往自己的 ws URL 上挂一个
   * **同样叫 `token`** 的握手凭据，两边撞名，按 query 优先取到的是它的那份。
   * 升级请求一定来自已经加载好的页面，cookie 必然在，所以直接不看 query ——
   * 这不放松任何一道关，只是换个地方取同一个 token。
   */
  readonly cookieOnly?: boolean
}

/**
 * 校验一个请求是否可以放行。
 * @param req - 进来的请求。
 * @param config - 本进程的 token 与监听端口。
 * @returns 放行，或带状态码与原因的拒绝。
 */
export function guardRequest(req: IncomingMessage, config: GuardConfig): GuardResult {
  // ── 关卡 1：Host 必须是本机 ───────────────────────────────────
  const host = req.headers.host
  if (host === undefined) return deny(400, 'bad-host', '缺少 Host 头')
  const hostname = hostnameOf(host)
  if (!isLocalHost(hostname)) {
    // DNS rebinding：evil.com 解析到 127.0.0.1，浏览器带着 Host: evil.com 打进来。
    return deny(403, 'bad-host', `只接受本机 Host，收到 ${hostname}`)
  }

  // ── 关卡 2：Origin 若存在必须也是本机 ─────────────────────────
  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'null') {
    let originHost: string
    try {
      originHost = new URL(origin).hostname
    } catch {
      return deny(403, 'bad-origin', `Origin 无法解析: ${origin}`)
    }
    if (!isLocalHost(originHost)) {
      return deny(403, 'bad-origin', `跨源请求被拒: ${origin}`)
    }
  }

  // ── 关卡 3：token ────────────────────────────────────────────
  const fromQuery = config.cookieOnly === true
    ? null
    : new URL(req.url ?? '/', `http://${host}`).searchParams.get('token')
  const supplied = fromQuery ?? readCookie(req.headers.cookie, TOKEN_COOKIE)
  if (supplied === null || supplied === undefined || supplied.length === 0) {
    return deny(401, 'missing-token', '缺少访问 token')
  }
  if (!tokensEqual(supplied, config.token)) {
    return deny(401, 'bad-token', 'token 不匹配')
  }

  return { ok: true }
}

/**
 * 首次带 token 访问时下发的 cookie。
 * @param token - 本进程的会话 token。
 * @returns `Set-Cookie` 头的值。
 */
export function tokenCookieHeader(token: string): string {
  // httpOnly 防脚本读取；SameSite=Strict 让跨站请求不带它；本地 http 不能用 Secure。
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`
}
