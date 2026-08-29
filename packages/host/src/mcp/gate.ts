/**
 * gate 的宿主侧：派活时把"反向通道"的配置落盘、签发凭据。
 *
 * Agent CLI 挂一个 MCP server 的方式各家不同：
 *
 *   - claude   `--mcp-config <file>`，吃一份 JSON 文件；
 *   - opencode `OPENCODE_CONFIG` 环境变量指向一份 JSON 文件（与用户配置
 *     **合并**而非替换，已实测确认），键是 `mcp.<name>`；
 *   - codex    没有 MCP 配置文件，用 `-c mcp_servers.<name>.…=…` 逐键覆盖。
 *
 * 所以这里把两种文件都写好（都很小），codex 需要的散键由它自己的 provider
 * 从 {@link GateConfig} 的字段现拼。文件落在 run 的产物目录里 —— 绝不落进
 * worktree，那会污染 diff，让"Agent 改了什么"多出一份谁也没写过的文件。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunId } from '@loopkanban/core'
import type { GateConfig } from '../agents/types.ts'
import { DEFAULT_DECISION_TIMEOUT_MS } from '../decisions/index.ts'

/** MCP server 名，也是工具名的前缀：`mcp__loopkanban__ask_user`。 */
export const GATE_SERVER_NAME = 'loopkanban'

/** gate 上两个工具的完整名。provider 拼参数时用，别处不该手抄这个形状。 */
export function askUserToolName(serverName = GATE_SERVER_NAME): string {
  return `mcp__${serverName}__ask_user`
}

export function requestPermissionToolName(serverName = GATE_SERVER_NAME): string {
  return `mcp__${serverName}__request_permission`
}

/** shim 脚本的绝对路径。与本模块同目录 —— 开发时在 src，打包后在 dist。 */
export function gateShimPath(): string {
  return new URL('./gate-shim.mjs', import.meta.url).pathname
}

/** 注入给 shim 的环境变量。只带限权 token，不带宿主的全权凭据。 */
function shimEnv(runId: RunId, baseUrl: string, token: string, timeoutMs: number): Record<string, string> {
  return {
    LOOPKANBAN_GATE_URL: baseUrl,
    LOOPKANBAN_RUN_ID: runId,
    LOOPKANBAN_TOKEN: token,
    LOOPKANBAN_TIMEOUT_MS: String(timeoutMs),
  }
}

export interface WriteGateOptions {
  /** run 的产物目录；配置文件写在它的 `gate/` 子目录里。 */
  readonly artifactsDir: string
  readonly runId: RunId
  /** 宿主 HTTP server 的地址（127.0.0.1:port）。 */
  readonly baseUrl: string
  readonly token: string
  /** 宿主自己的可执行文件（node）—— shim 用它启动，不赌 PATH。 */
  readonly execPath: string
  /** 决策超时。opencode 的工具超时按它放宽，否则默认 5 秒就掐断了等人的调用。 */
  readonly timeoutMs?: number
}

/**
 * 落盘 gate 配置并返回 {@link GateConfig}。
 * @throws 写文件失败时抛出 —— caller（runner）会把它当作一次启动失败处理。
 */
export async function writeGateConfig(options: WriteGateOptions): Promise<GateConfig> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS
  const shimPath = gateShimPath()
  const dir = join(options.artifactsDir, 'gate')
  await mkdir(dir, { recursive: true })

  const env = shimEnv(options.runId, options.baseUrl, options.token, timeoutMs)

  const mcpConfigPath = join(dir, 'mcp.json')
  await writeFile(mcpConfigPath, `${JSON.stringify({
    mcpServers: {
      [GATE_SERVER_NAME]: { command: options.execPath, args: [shimPath], env },
    },
  }, null, 2)}\n`, 'utf8')

  // opencode 的工具调用默认 5 秒超时 —— 等人的调用必被掐断，必须放宽到
  // 比决策超时更宽，留出的余量覆盖轮询与网络的小抖动。
  const envConfigPath = join(dir, 'opencode.json')
  await writeFile(envConfigPath, `${JSON.stringify({
    mcp: {
      [GATE_SERVER_NAME]: {
        type: 'local',
        command: [options.execPath, shimPath],
        environment: env,
        enabled: true,
        timeout: timeoutMs + 10 * 60_000,
      },
    },
  }, null, 2)}\n`, 'utf8')

  return {
    serverName: GATE_SERVER_NAME,
    baseUrl: options.baseUrl,
    runId: options.runId,
    token: options.token,
    shimPath,
    mcpConfigPath,
    envConfigPath,
  }
}
