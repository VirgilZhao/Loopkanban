/**
 * LoopKanban 的 MCP gate —— 一个零依赖的 stdio MCP server。
 *
 * 它由 Agent CLI（claude / codex / opencode）自己拉起，是宿主与 CLI 之间的
 * 反向通道：CLI 在执行途中通过这里的两个工具"打电话回看板"——
 *
 *   - `ask_user`            模型向人提问，阻塞到人给出回答；
 *   - `request_permission`  claude 的权限系统在 supervised 档下自动调用，
 *                           把"要不要放行这次工具调用"交给界面。
 *
 * 每次调用都会在宿主落一条决策记录并推给界面（SSE），然后轮询等它被处理。
 * 凭据是**只对这次执行有效**的限权 token（环境变量带进来），除了为这个
 * run 创建与轮询决策之外什么都干不了。
 *
 * 为什么是独立 .mjs 而不是 TS 模块：它是被外部 CLI spawn 的进程入口，
 * 必须不需要任何加载器就能跑 —— `node gate-shim.mjs`，仅此而已。
 * 全部逻辑导出为纯函数，宿主侧的测试直接 import 来测。
 */

import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'loopkanban-gate', version: '0.1.0' }

/** 轮询间隔。人的操作以秒计，半秒的延迟换最低的开销，够了。 */
const POLL_MS = 750

/** 从环境变量读出的本次运行配置。 */
function configFromEnv(env = process.env) {
  const baseUrl = env['LOOPKANBAN_GATE_URL']
  const runId = env['LOOPKANBAN_RUN_ID']
  const token = env['LOOPKANBAN_TOKEN']
  if (baseUrl === undefined || runId === undefined || token === undefined) return null
  const parsed = Number.parseInt(env['LOOPKANBAN_TIMEOUT_MS'] ?? '', 10)
  // 宿主那边到点一定会收场；这里的硬上限只是"宿主已经不在了"时的保险丝。
  return { baseUrl: baseUrl.replace(/\/$/, ''), runId, token, timeoutMs: Number.isFinite(parsed) ? parsed + 60_000 : 20 * 60_000 }
}

/** 向宿主发一次带凭据的请求，非 2xx 时抛出带 detail 的错误。 */
async function call(config, path, init) {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      'authorization': `Bearer ${config.token}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof body['detail'] === 'string' ? body['detail'] : `HTTP ${String(res.status)}`
    throw new Error(detail)
  }
  return body
}

/** 落一条决策并轮询到它被处理（或超时）。返回终态的 decision。 */
async function awaitDecision(config, kind, payload) {
  const { decision } = await call(config, `/api/runs/${encodeURIComponent(config.runId)}/decisions`, {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  })
  const id = decision?.['id']
  if (typeof id !== 'string') throw new Error('宿主返回的决策缺少 id')
  const deadline = Date.now() + config.timeoutMs
  for (;;) {
    if (decision['status'] !== 'pending') return decision
    if (Date.now() > deadline) throw new Error('等待人工处理超时（宿主可能已经退出）')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const next = await call(config, `/api/runs/${encodeURIComponent(config.runId)}/decisions/${encodeURIComponent(id)}`)
    Object.assign(decision, next['decision'] ?? {})
  }
}

/** ask_user 的执行：把问题交给宿主，把回答文本作为工具结果返回。 */
async function runAskUser(config, args) {
  const question = args?.['question']
  const decision = await awaitDecision(config, 'question', {
    question,
    ...(Array.isArray(args?.['choices']) ? { choices: args['choices'] } : {}),
  })
  const answer = decision['answer'] ?? {}
  const text = typeof answer['text'] === 'string' ? answer['text'] : '（没有收到回答）'
  // 执行被终止时这条提问没有下文了，标成错误让模型别再等它。
  return { content: [{ type: 'text', text }], isError: answer['by'] === 'cancelled' }
}

/**
 * request_permission 的执行：把审批请求交给宿主，按契约回 allow/deny。
 *
 * claude 对 permission-prompt-tool 的返回有约定：内容是一段 JSON——
 *   allow → {"behavior":"allow","updatedInput":<原始参数>}
 *   deny  → {"behavior":"deny","message":"..."}
 * updatedInput 用原始参数原样奉还：我们不解构任何工具的参数形状。
 */
async function runRequestPermission(config, args) {
  const tool = args?.['tool_name']
  const decision = await awaitDecision(config, 'permission', { tool, input: args?.['input'] ?? {} })
  const answer = decision['answer'] ?? {}
  if (decision['status'] === 'allowed') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: args?.['input'] ?? {} }) }],
    }
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        behavior: 'deny',
        message: typeof answer['message'] === 'string' && answer['message'].length > 0
          ? answer['message']
          : '用户拒绝了这次操作',
      }),
    }],
  }
}

const TOOLS = [
  {
    name: 'ask_user',
    description: '向看板上的人提问并等待回答。需求有歧义、做法需要拍板、缺关键信息时用；'
      + '一次只问一个问题，把背景与候选项写清楚。返回人的回答文本 —— 超时未答时按"自行判断并说明假设"处理。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题，写清背景' },
        choices: { type: 'array', items: { type: 'string' }, description: '可选的候选项，最多 10 条' },
      },
      required: ['question'],
    },
  },
  {
    name: 'request_permission',
    description: '请求用户批准一次工具调用。由权限系统在 supervised 档下自动调用，模型不要主动调用它。',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: '想使用的工具名' },
        input: { type: 'object', description: '该工具的调用参数' },
      },
      required: ['tool_name'],
    },
  },
]

/**
 * 处理一条 JSON-RPC 消息。返回要写回 stdout 的响应对象；通知与坏行返回 null。
 *
 * 抛错只可能是协议层的（未知方法等），回 error 帧；工具执行里的失败在
 * runXxx 里转成 isError 的工具结果 —— CLI 那头把它当一次失败的工具调用，
 * 执行可以继续，绝不连累整个会话。
 *
 * **响应必须带 `jsonrpc: '2.0'`**：实测 claude 的客户端对没有这个字段的
 * 响应不认账，连接会一直等到 30 秒超时（CONNECT_TIMEOUT）。
 */
export async function handleMessage(config, message) {
  if (message === null || typeof message !== 'object') return null
  const { id, method, params } = message
  if (typeof method !== 'string') return null
  // 没有 id 的是通知：按协议不回帧。
  if (id === undefined || id === null) return null

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          // 客户端带了版本就沿用它的 —— 协议规定服务器在能支持时应当如此。
          protocolVersion: typeof params?.['protocolVersion'] === 'string'
            ? params['protocolVersion']
            : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    if (method === 'tools/call') {
      const name = params?.['name']
      const args = params?.['arguments'] ?? {}
      let result
      if (name === 'ask_user') result = await runAskUser(config, args)
      else if (name === 'request_permission') result = await runRequestPermission(config, args)
      else {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `未知工具 ${String(name)}` },
        }
      }
      return { jsonrpc: '2.0', id, result }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/** 主入口：从 stdin 逐行读，逐行回。stdin 关闭即退出。 */
export async function main(config = configFromEnv()) {
  if (config === null) {
    console.error('[loopkanban-gate] 缺少 LOOPKANBAN_GATE_URL / RUN_ID / TOKEN 环境变量，无法连接看板')
    process.exitCode = 1
    return
  }
  const out = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      // 坏行不动 stdout —— 那条管道属于 MCP 协议，多一行就把解析器打断了。
      console.error(`[loopkanban-gate] 无法解析的一行: ${trimmed.slice(0, 120)}`)
      continue
    }
    const response = await handleMessage(config, message)
    if (response !== null) out(response)
  }
}

// 只在直接执行时才进主循环；被测试 import 时不做任何事。
const isMain = process.argv[1] !== undefined
  && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href
if (isMain) await main()
