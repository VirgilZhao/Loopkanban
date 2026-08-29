/** gate-shim.mjs 的类型面 —— 实现是纯 JS（被 CLI 独立 spawn），这里只声明导出。 */
export interface GateRuntimeConfig {
  baseUrl: string
  runId: string
  token: string
  timeoutMs: number
}

/** 处理一条 JSON-RPC 消息；通知与坏行返回 null。 */
export function handleMessage(
  config: GateRuntimeConfig,
  message: unknown,
): Promise<Record<string, unknown> | null>

/** 主入口：从 stdin 逐行读、逐行回；缺环境变量时写 stderr 并置退出码。 */
export function main(config?: GateRuntimeConfig | null): Promise<void>
