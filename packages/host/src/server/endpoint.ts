/**
 * 正在跑的看板把自己的地址写在数据目录里，别的进程照着找过来。
 *
 * 为什么需要它：端口默认是随机的（`--port` 才固定），而 MCP server 是**另一个
 * 进程**，由 Claude Code / Codex 这类客户端拉起来，没人给它传参。token 早就
 * 存在同一个目录里了，缺的只是"它这次听在哪个端口"。
 *
 * **token 不写进这个文件**。它已经在 `<dataDir>/token` 里躺着（0600），
 * 同一份秘密存两处只是多一个会泄漏、会过期、会对不上的地方。
 *
 * 文件是**线索而不是事实**：进程崩掉时来不及删，下次读到的就是一个死地址。
 * 所以读到之后仍要连一次才算数，连不上就当没有 —— 见 `mcp/client.ts`。
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 一次运行对外的样子。 */
export interface Endpoint {
  /** 形如 `http://127.0.0.1:52341`，不带尾斜杠、不带 token。 */
  readonly url: string
  readonly port: number
  /** 写下它的进程。用来判断这条记录是不是上次崩溃留下的。 */
  readonly pid: number
  readonly startedAt: number
}

/** 地址文件的位置。 */
export function endpointPath(dataDir: string): string {
  return join(dataDir, 'endpoint.json')
}

/**
 * 记下本次运行的地址。
 *
 * 权限收到 0600 与 token 文件一致：它本身不是秘密，但"这台机器上有个能起
 * Agent 的接口，听在这个端口"也不必让别的用户随手读到。
 *
 * @param dataDir - 数据目录。
 * @param endpoint - 本次运行的地址。
 */
export async function writeEndpoint(dataDir: string, endpoint: Endpoint): Promise<void> {
  await writeFile(
    endpointPath(dataDir),
    `${JSON.stringify(endpoint, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

/**
 * 读出上一次写下的地址。
 *
 * 不存在、读不动、内容坏掉 —— 对调用方是同一件事：这儿没有可用的线索。
 * 一个坏文件不该让 MCP server 起不来。
 *
 * @param dataDir - 数据目录。
 * @returns 地址；没有可用记录时 null。
 */
export async function readEndpoint(dataDir: string): Promise<Endpoint | null> {
  const raw = await readFile(endpointPath(dataDir), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Endpoint>
    if (typeof parsed.url !== 'string' || typeof parsed.port !== 'number') return null
    return {
      url: parsed.url.replace(/\/+$/, ''),
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    }
  } catch {
    return null
  }
}

/** 关站时把地址抹掉，免得下一个进程照着一个已经没人听的端口去连。 */
export async function clearEndpoint(dataDir: string): Promise<void> {
  await rm(endpointPath(dataDir), { force: true }).catch(() => undefined)
}
