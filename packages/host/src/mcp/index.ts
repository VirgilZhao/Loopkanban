/**
 * LoopKanban 的 MCP server：把看板本身交给 Agent 用。
 *
 * 起法是 `loopkanban mcp`，由 Claude Code / Codex 这类客户端拉起来，走 stdio。
 * 传输就是**一行一条 JSON-RPC**（消息里不许有裸换行），所以这里没有引任何
 * SDK —— 协议这一层总共就是握手、列工具、调工具三件事，而"零运行时依赖"
 * 是这个项目的分发前提，为三件事引一棵依赖树不划算。
 *
 * 两条要守住的：
 *
 * - **stdout 只放协议消息**。任何一行调试输出都会让客户端的解析器炸掉，
 *   而它的表现是"这个 MCP server 坏了"，没人会想到是一句 console.log。
 *   要说话就写 stderr。
 * - **工具失败不是协议失败**。看板拒绝了一次调用（卡在跑、revision 冲突、
 *   关联跨了项目）是给 Agent 看的结果，要作为 `isError` 的内容回过去，
 *   让它读完自己改；回 JSON-RPC error 的话，多数客户端只会显示一句
 *   "tool failed"，Agent 连原因都看不到。
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { BoardError, BoardUnreachable, type BoardClient } from './client.ts'
import { TOOLS, ToolInputError } from './tools.ts'

export { discoverBoard, BoardClient } from './client.ts'
export { TOOLS } from './tools.ts'

/** 我们说的协议版本。客户端报一个我们认识的就照它回，否则回这个。 */
const PROTOCOL_VERSION = '2025-11-25'
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'])

const SERVER_INFO = {
  name: 'loopkanban',
  title: 'LoopKanban',
  version: '0.1.0',
} as const

/** JSON-RPC 的标准错误码，取我们真的会用到的那几个。 */
const CODE = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const ok = (id: string | number | null, result: unknown): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, result })

const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message } })

/** 工具的返回值：一段文本内容，外加"这是不是一次失败"。 */
function content(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError }
}

/**
 * 处理一条消息。
 *
 * 分出来是为了能直接测：协议这一层不该只能通过起进程、喂 stdin 来验证。
 *
 * @param client - 看板客户端。
 * @param message - 已经解析好的一条 JSON-RPC 消息。
 * @returns 要回的响应；通知（没有 id）返回 null，表示什么都不回。
 */
export async function handleMessage(
  client: BoardClient, message: JsonRpcMessage,
): Promise<JsonRpcResponse | null> {
  const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null
  const method = typeof message.method === 'string' ? message.method : null
  if (method === null) return id === null ? null : fail(id, CODE.invalidRequest, '缺少 method')

  // 通知没有 id，按协议**一个字都不能回** —— 回了会被当成对不上号的响应。
  const isNotification = message.id === undefined || message.id === null

  switch (method) {
    case 'initialize': {
      const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
      const version = typeof asked === 'string' && SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'LoopKanban 是本机的一个看板：卡片被 Agent CLI 认领，在项目派生的独立 git worktree 里执行，'
          + '完成后回到 Review 等人验收。先 list_tasks 看有什么，再 get_task 读全需求；'
          + '要它跑起来用 claim_task（只有 ready 列的卡能认领），跟进用 run_status。'
          + '验收通过与废弃只能由人在界面上做，这里没有对应的工具。',
      })
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return isNotification ? null : ok(id, {})
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
      const name = typeof params.name === 'string' ? params.name : ''
      const tool = TOOLS.find((candidate) => candidate.name === name)
      // 工具不存在是**调用方拼错了名字**，不是这次调用的结果 —— 它该回协议错误。
      if (tool === undefined) return fail(id, CODE.invalidParams, `没有这个工具：${name}`)
      const args = (typeof params.arguments === 'object' && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>
      try {
        return ok(id, content(JSON.stringify(await tool.run(client, args), null, 2)))
      } catch (error) {
        return ok(id, content(describe(error), true))
      }
    }
    default:
      return isNotification ? null : fail(id, CODE.methodNotFound, `不支持的方法：${method}`)
  }
}

/**
 * 把异常翻译成 Agent 读得懂、并且**能照着改**的一句话。
 *
 * 三类分开说：参数不对（改参数）、看板拒绝（读原因，多半要换个动作）、
 * 连不上（人去把看板打开）。混成一句 "error" 的话，Agent 只会原样重试。
 */
function describe(error: unknown): string {
  if (error instanceof ToolInputError) return `参数不对：${error.message}`
  if (error instanceof BoardUnreachable) return error.message
  if (error instanceof BoardError) {
    return `看板拒绝了这次调用（HTTP ${String(error.status)} ${error.code}）：${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

export interface ServeOptions {
  readonly client: BoardClient
  readonly input?: Readable
  readonly output?: Writable
}

/**
 * 起 stdio 上的 MCP server，直到对端关掉 stdin。
 *
 * @param options - 看板客户端与（供测试替换的）输入输出流。
 */
export async function serveMcp(options: ServeOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const write = (response: JsonRpcResponse): void => {
    // 一行一条，且**绝不换行**：JSON.stringify 会把正文里的换行转义成 \n，
    // 所以这里唯一的换行就是行尾那一个。
    output.write(`${JSON.stringify(response)}\n`)
  }

  for await (const line of createInterface({ input })) {
    const text = line.trim()
    if (text.length === 0) continue
    let message: JsonRpcMessage
    try {
      message = JSON.parse(text) as JsonRpcMessage
    } catch {
      write(fail(null, CODE.parse, '这一行不是合法的 JSON'))
      continue
    }
    try {
      const response = await handleMessage(options.client, message)
      if (response !== null) write(response)
    } catch (error) {
      // 走到这儿说明是我们自己的 bug（handleMessage 里工具的异常已经接住了）。
      // 仍然要回一条：不回的话，客户端会抱着这个 id 一直等下去。
      const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null
      write(fail(id, CODE.internal, describe(error)))
    }
  }
}
