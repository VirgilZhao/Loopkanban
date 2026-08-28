/**
 * Provider 注册表：探测本机装了哪些 Agent CLI，有哪个用哪个。
 *
 * 不绑定版本 —— 一个 CLI 没装就不注册，任务在 UI 上选不到它；
 * 一个都没装则明确报错，而不是让任务卡在 Running。
 */

import { claudeCliProvider } from './providers/claude-cli.ts'
import { codexCliProvider } from './providers/codex-cli.ts'
import { opencodeCliProvider } from './providers/opencode-cli.ts'
import type { AgentCaps, AgentProvider } from './types.ts'

export const ALL_PROVIDERS: readonly AgentProvider[] = [claudeCliProvider, codexCliProvider, opencodeCliProvider]

export interface DetectedAgent {
  readonly provider: AgentProvider
  readonly caps: AgentCaps
}

/**
 * 并行探测所有已知 provider。
 * @param explicitPaths - provider id → 用户指定的可执行文件绝对路径。
 * @returns 本机可用的 provider 列表，按 {@link ALL_PROVIDERS} 顺序。
 */
export async function detectAgents(
  explicitPaths: Readonly<Record<string, string>> = {},
): Promise<DetectedAgent[]> {
  const results = await Promise.all(
    ALL_PROVIDERS.map(async (provider) => {
      try {
        const caps = await provider.probe(explicitPaths[provider.id])
        return caps === null ? null : { provider, caps }
      } catch {
        // 探测失败等同于没装：不能让一个坏掉的 CLI 拖垮整个启动。
        return null
      }
    }),
  )
  return results.filter((r): r is DetectedAgent => r !== null)
}

export { claudeCliProvider, codexCliProvider, opencodeCliProvider }
export * from './types.ts'
