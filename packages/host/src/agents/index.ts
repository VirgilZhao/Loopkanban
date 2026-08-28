/**
 * Provider 注册表：探测本机装了哪些 Agent CLI，有哪个用哪个。
 *
 * 不绑定版本 —— 一个 CLI 没装就不注册，任务在 UI 上选不到它；
 * 一个都没装则明确报错，而不是让任务卡在 Running。
 *
 * ## 接入一个新 CLI
 *
 * 写一个 `providers/<name>-cli.ts`，实现 {@link AgentProvider}，然后在
 * {@link ALL_PROVIDERS} 里加一行 —— **这两处就是全部**。宿主侧不该再出现
 * 第三处提到它名字的地方：
 *
 *   - 可执行文件叫什么、装在哪些非 `PATH` 目录 → `command` / `extraDirs`
 *   - 支持哪些权限档、能不能续跑、能不能钉会话 id → `probe` 探测出来，不写死
 *   - 模型清单从哪来 → 自己能列就在 `probe` 里列，列不出就填 `catalogSource`
 *   - 输出格式千奇百怪 → `parseLine` 归一化成 {@link AgentEvent}
 *
 * 判断标准很简单：新加的那个 CLI 的名字，除了它自己那个文件和下面这个数组，
 * 不该在别处被 `grep` 到。凡是要在宿主里写 `provider.id === 'xxx'` 的，
 * 都说明这层抽象少了一个字段 —— 补字段，而不是加分支。
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
 * @param providers - 备选清单，默认全部；供测试收窄。
 * @returns 本机可用的 provider 列表，按 {@link ALL_PROVIDERS} 顺序。
 */
export async function detectAgents(
  explicitPaths: Readonly<Record<string, string>> = {},
  providers: readonly AgentProvider[] = ALL_PROVIDERS,
): Promise<DetectedAgent[]> {
  const results = await Promise.all(
    providers.map(async (provider) => {
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

/**
 * 我们找过的可执行文件名，例如 `claude / codex / opencode`。
 *
 * 一个都没探测到时要向用户交代"我找的是这几个"，而那句话必须从注册表里
 * 长出来 —— 手抄一份的话，接了新 CLI 之后它就开始撒谎。
 */
export function knownCommands(providers: readonly AgentProvider[] = ALL_PROVIDERS): string[] {
  return providers.map((provider) => provider.command)
}

/** 一次探测：跑一遍 detectAgents，也可以再加工（补模型清单之类）。 */
export type Detect = () => Promise<readonly DetectedAgent[]>

/**
 * 本机可用执行器的**活视图**。
 *
 * server、runner、scheduler 共用同一个实例，这样刷新一次三边都看得见新结果 ——
 * 各自捧着一份开机时的快照的话，界面上刚探测到的 CLI 会派不出活，而刚卸载的
 * 那个还会被继续派活，且两种错都要重启才好。
 */
export class AgentPool {
  private agents: readonly DetectedAgent[]
  private readonly detect: Detect
  /**
   * 正在进行的那次探测。
   *
   * 探测要为每个 CLI 起 `--version` 与 `--help` 子进程，连点几下刷新按钮
   * 不该变成几倍的进程。第二次调用直接搭上第一次的车。
   */
  private inFlight: Promise<readonly DetectedAgent[]> | null = null

  constructor(detect: Detect, initial: readonly DetectedAgent[] = []) {
    this.detect = detect
    this.agents = initial
  }

  /** 一池固定不变的执行器，用于测试和"这里不需要刷新"的场景。 */
  static of(agents: readonly DetectedAgent[]): AgentPool {
    return new AgentPool(() => Promise.resolve(agents), agents)
  }

  /** 当前可用的执行器。**每次都重新读** —— 刷新之后不能还拿着旧的。 */
  list(): readonly DetectedAgent[] {
    return this.agents
  }

  /**
   * 重新探测一遍本机，把结果换上。
   *
   * 探测**整个**炸了（不是某个 CLI 没装）就留着原来那份：一次临时的文件系统
   * 错误不该让所有卡片突然无处可派。反过来，探测成功但结果是空的，那就如实
   * 换成空 —— 那说明 CLI 真的被卸载了。
   *
   * 已经在跑的 Run 不受影响：Runner 在启动时就攥住了那个 provider 与 caps。
   *
   * @returns 刷新后的清单。
   */
  async refresh(): Promise<readonly DetectedAgent[]> {
    this.inFlight ??= (async () => {
      try {
        this.agents = await this.detect()
      } finally {
        this.inFlight = null
      }
      return this.agents
    })()
    return this.inFlight
  }
}

export { claudeCliProvider, codexCliProvider, opencodeCliProvider }
export * from './types.ts'
