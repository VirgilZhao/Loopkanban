import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  createToken, guardRequest, readCookie, TOKEN_COOKIE, tokenCookieHeader, tokensEqual,
} from '../src/server/auth.ts'

const TOKEN = 'a'.repeat(43)
const CONFIG = { token: TOKEN, port: 4321 }

function request(patch: {
  host?: string | undefined
  origin?: string | undefined
  cookie?: string | undefined
  url?: string
} = {}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (patch.host !== undefined) headers['host'] = patch.host
  if (patch.origin !== undefined) headers['origin'] = patch.origin
  if (patch.cookie !== undefined) headers['cookie'] = patch.cookie
  return { headers, url: patch.url ?? '/api/tasks' } as unknown as IncomingMessage
}

const authed = (patch: Parameters<typeof request>[0] = {}) =>
  request({ host: '127.0.0.1:4321', cookie: `${TOKEN_COOKIE}=${TOKEN}`, ...patch })

describe('createToken', () => {
  it('生成足够长且每次不同的 token', () => {
    const a = createToken()
    const b = createToken()
    expect(a.length).toBeGreaterThanOrEqual(43)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('tokensEqual', () => {
  it('相同为真，不同为假', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true)
    expect(tokensEqual('abc', 'abd')).toBe(false)
  })

  it('长度不同直接判否，不抛错', () => {
    expect(tokensEqual('abc', 'abcdef')).toBe(false)
    expect(tokensEqual('', 'x')).toBe(false)
  })
})

describe('readCookie', () => {
  it('从多个 cookie 里取出目标值', () => {
    expect(readCookie('a=1; loopkanban_token=xyz; b=2', TOKEN_COOKIE)).toBe('xyz')
  })

  it('缺席时返回 undefined', () => {
    expect(readCookie(undefined, TOKEN_COOKIE)).toBeUndefined()
    expect(readCookie('a=1', TOKEN_COOKIE)).toBeUndefined()
  })

  it('值被 URL 编码过也能取回', () => {
    expect(readCookie('loopkanban_token=a%2Fb', TOKEN_COOKIE)).toBe('a/b')
  })
})

describe('guardRequest — Host 关卡（防 DNS rebinding）', () => {
  it('放行本机 Host', () => {
    for (const host of ['127.0.0.1:4321', 'localhost:4321', 'LOCALHOST:4321', '[::1]:4321']) {
      expect(guardRequest(authed({ host }), CONFIG), host).toMatchObject({ ok: true })
    }
  })

  it('拒绝非本机 Host —— 即使它解析到 127.0.0.1', () => {
    // 这正是 DNS rebinding 的形态：evil.com 解析到本机，浏览器自动带上 cookie。
    const result = guardRequest(authed({ host: 'evil.com:4321' }), CONFIG)
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'bad-host' })
  })

  it('拒绝缺少 Host 的请求', () => {
    expect(guardRequest(request({ cookie: `${TOKEN_COOKIE}=${TOKEN}` }), CONFIG))
      .toMatchObject({ ok: false, reason: 'bad-host' })
  })

  it('带着正确 token 也挡不住 Host 关卡 —— token 对 rebinding 无效', () => {
    const result = guardRequest(
      request({ host: 'evil.com:4321', url: `/api/tasks?token=${TOKEN}` }),
      CONFIG,
    )
    expect(result).toMatchObject({ ok: false, reason: 'bad-host' })
  })
})

describe('guardRequest — Origin 关卡', () => {
  it('放行本机 Origin', () => {
    expect(guardRequest(authed({ origin: 'http://127.0.0.1:4321' }), CONFIG)).toMatchObject({ ok: true })
  })

  it('拒绝跨源请求', () => {
    expect(guardRequest(authed({ origin: 'https://evil.com' }), CONFIG))
      .toMatchObject({ ok: false, status: 403, reason: 'bad-origin' })
  })

  it('拒绝无法解析的 Origin', () => {
    expect(guardRequest(authed({ origin: '???' }), CONFIG))
      .toMatchObject({ ok: false, reason: 'bad-origin' })
  })

  it('没有 Origin 头时放行 —— curl 之类的非浏览器客户端没有它', () => {
    expect(guardRequest(authed(), CONFIG)).toMatchObject({ ok: true })
  })

  it('Origin 为字面量 null 时放行（沙箱 iframe 等）', () => {
    expect(guardRequest(authed({ origin: 'null' }), CONFIG)).toMatchObject({ ok: true })
  })
})

describe('guardRequest — token 关卡', () => {
  it('接受来自 query 的 token —— 首次访问就是这样进来的', () => {
    const req = request({ host: '127.0.0.1:4321', url: `/?token=${TOKEN}` })
    expect(guardRequest(req, CONFIG)).toMatchObject({ ok: true })
  })

  it('接受来自 cookie 的 token', () => {
    expect(guardRequest(authed(), CONFIG)).toMatchObject({ ok: true })
  })

  it('缺 token 返回 401', () => {
    expect(guardRequest(request({ host: '127.0.0.1:4321' }), CONFIG))
      .toMatchObject({ ok: false, status: 401, reason: 'missing-token' })
  })

  it('token 错误返回 401', () => {
    expect(guardRequest(authed({ cookie: `${TOKEN_COOKIE}=wrong` }), CONFIG))
      .toMatchObject({ ok: false, status: 401, reason: 'bad-token' })
  })

  it('token 是别的 token 的前缀也不放行', () => {
    expect(guardRequest(authed({ cookie: `${TOKEN_COOKIE}=${TOKEN.slice(0, 10)}` }), CONFIG))
      .toMatchObject({ ok: false, reason: 'bad-token' })
  })
})

describe('guardRequest — cookieOnly（WebSocket 升级）', () => {
  const CONFIG_WS = { ...CONFIG, cookieOnly: true }

  it('无视 URL 上的同名 token，认 cookie', () => {
    // vite 的 HMR 客户端就是这样：ws URL 上挂着它自己的 `?token=`。
    const req = authed({ url: '/?token=vite-hmr-handshake' })
    expect(guardRequest(req, CONFIG_WS)).toMatchObject({ ok: true })
    // 不加 cookieOnly 的话，query 那份会被当成我们的 token，直接 401。
    expect(guardRequest(req, CONFIG)).toMatchObject({ ok: false, reason: 'bad-token' })
  })

  it('没有 cookie 时不因 query 里的 token 而放行', () => {
    const req = request({ host: '127.0.0.1:4321', url: `/?token=${TOKEN}` })
    expect(guardRequest(req, CONFIG_WS)).toMatchObject({ ok: false, reason: 'missing-token' })
  })
})

describe('tokenCookieHeader', () => {
  it('带 HttpOnly 与 SameSite=Strict', () => {
    const header = tokenCookieHeader(TOKEN)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Path=/')
  })

  it('值被编码，特殊字符不会破坏 cookie 结构', () => {
    expect(tokenCookieHeader('a;b=c')).toContain('a%3Bb%3Dc')
  })
})
