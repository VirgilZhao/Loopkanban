/**
 * 从 models.dev 取模型清单，落盘缓存。
 *
 * 为什么需要它：有的 CLI 自己就有 `models` 子命令（opencode），有的只能从
 * `--help` 的描述里捞几个别名（claude），有的两样都没有（codex）。models.dev
 * 是一份公开的、一直在更新的模型目录（opencode 自己也用它），拿它给后两类
 * 补上可选项。
 *
 * **补给谁不写在这里**：由 provider 自己用 `catalogSource` 声明它在 models.dev
 * 上叫什么，不填就是不需要补。这个模块因此不认识任何一个具体的 CLI。
 *
 * 三条底线：
 *
 * 1. **这是 LoopKanban 唯一的对外请求**。除此之外整个程序只连 127.0.0.1。
 *    所以它可以用 `--no-models` 关掉，关掉之后一切照常，只是少几个建议。
 * 2. **取不到不是错误**。离线、超时、对方改了格式，一律退回已有的缓存或空
 *    清单，界面照旧允许自由输入 —— 建议缺席比建议错误好得多。
 * 3. **建议永远只是建议**。真正认不认这个模型名，由 CLI 自己说了算。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ALL_PROVIDERS } from './index.ts'
import type { AgentProvider } from './types.ts'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 缓存有效期。模型目录以周计地变，一天一次足够，也不至于让人等。 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** provider id → models.dev 里的 provider 键。 */
export type CatalogSources = Readonly<Record<string, string>>

/**
 * 从注册表里收集"谁需要外部目录来补模型"。
 *
 * @param providers - 备选清单，默认全部已注册的 provider。
 */
export function catalogSources(providers: readonly AgentProvider[] = ALL_PROVIDERS): CatalogSources {
  const sources: Record<string, string> = {}
  for (const provider of providers) {
    if (provider.catalogSource !== undefined) sources[provider.id] = provider.catalogSource
  }
  return sources
}

/** provider id → 模型名清单。 */
export type ModelCatalog = Readonly<Record<string, readonly string[]>>

interface CacheFile {
  readonly at: number
  readonly catalog: Record<string, string[]>
}

function str(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

/**
 * 从 models.dev 的整份 JSON 里挑出我们要的那几个 provider 的模型。
 *
 * 过滤掉不能拿来干活的：输出不含文本的（嵌入、画图）、不支持工具调用的 ——
 * Agent CLI 没有工具就寸步难行，把它们列出来只会让人选中之后一头雾水。
 * 按发布日期倒序，新的排在前面。
 *
 * 全程防御式解析：这是第三方的 4MB JSON，任何一处不合预期都只跳过那一条，
 * 不让整次加载失败。
 *
 * @param payload - `https://models.dev/api.json` 的内容。
 * @param sources - provider id → models.dev 的 provider 键，默认从注册表取。
 */
export function parseCatalog(
  payload: unknown, sources: CatalogSources = catalogSources(),
): Record<string, string[]> {
  const catalog: Record<string, string[]> = {}
  if (typeof payload !== 'object' || payload === null) return catalog

  for (const [ours, theirs] of Object.entries(sources)) {
    const provider = (payload as Record<string, unknown>)[theirs]
    const models = typeof provider === 'object' && provider !== null
      ? (provider as Record<string, unknown>)['models']
      : undefined
    if (typeof models !== 'object' || models === null) continue

    const usable: { id: string; releasedAt: string }[] = []
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue
      const model = raw as Record<string, unknown>
      const output = (model['modalities'] as Record<string, unknown> | undefined)?.['output']
      if (!Array.isArray(output) || !output.includes('text')) continue
      if (model['tool_call'] !== true) continue
      usable.push({ id, releasedAt: str(model, 'release_date') ?? '' })
    }
    usable.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt))
    if (usable.length > 0) catalog[ours] = usable.map((model) => model.id)
  }
  return catalog
}

export interface LoadOptions {
  /** 缓存文件路径。 */
  readonly cachePath: string
  readonly now?: () => number
  readonly timeoutMs?: number
  /** provider id → models.dev 的 provider 键，默认从注册表取。 */
  readonly sources?: CatalogSources
  /** 供测试注入。 */
  readonly fetchImpl?: typeof fetch
}

/** 读缓存；读不出或坏掉都当作没有。 */
async function readCache(path: string): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheFile
    return typeof parsed.at === 'number' && typeof parsed.catalog === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 取模型清单：缓存没过期就用缓存，否则去网上取一次再存下来。
 *
 * @param options - 缓存位置与注入点。
 * @returns provider id → 模型清单。取不到就是空的。
 */
export async function loadModelCatalog(options: LoadOptions): Promise<ModelCatalog> {
  const now = options.now?.() ?? Date.now()
  const cached = await readCache(options.cachePath)
  if (cached !== null && now - cached.at < CACHE_TTL_MS) return cached.catalog

  try {
    const get = options.fetchImpl ?? fetch
    const res = await get(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
    const catalog = parseCatalog(await res.json(), options.sources ?? catalogSources())
    await mkdir(dirname(options.cachePath), { recursive: true })
    await writeFile(options.cachePath, JSON.stringify({ at: now, catalog } satisfies CacheFile), 'utf8')
    return catalog
  } catch {
    // 取不到就用手上的：过期的缓存也比空清单强，模型名不会一夜之间全变。
    return cached?.catalog ?? {}
  }
}

/**
 * 把 CLI 自己报的清单和 models.dev 的合起来。
 *
 * **CLI 报的排在前面**：那是它当前版本自己认的写法（claude 的 opus/sonnet
 * 这些别名尤其好用），models.dev 补的是完整型号，排在后面。
 */
export function mergeModels(fromCli: readonly string[], fromCatalog: readonly string[]): string[] {
  return [...new Set([...fromCli, ...fromCatalog])]
}
