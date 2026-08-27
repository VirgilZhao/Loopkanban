/**
 * 子进程环境清洗。
 *
 * 两个动机：
 *
 * 1. **守住「零 API Key」**。如果宿主环境里有 `ANTHROPIC_API_KEY` 之类的
 *    凭证，子 CLI 会直接拿去用，绕过用户自己的登录态 —— 那就不再是
 *    「用你本机的 CLI 身份干活」了。所以凭证形变量一律清掉。
 *
 * 2. **切断父会话的身份**。OpenKanban 很可能本身就跑在某个 Agent 会话里
 *    （开发时就是如此）。父会话会注入 `CLAUDE_CODE_SESSION_ID`、
 *    `CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH`
 *    这类变量，子 CLI 会误以为自己是那个会话的子代、由宿主代管鉴权。
 *    我们不是那个宿主，必须清掉，让子进程按独立进程走自己的登录态。
 *
 * 端点类变量（`ANTHROPIC_BASE_URL` 等）**保留**：它们是配置不是凭证，
 * 企业网关场景需要。但会被如实上报，便于排查。
 */

/** 名字里带这些片段的一律视为凭证。 */
const CREDENTIAL_MARKERS = ['API_KEY', 'AUTH_TOKEN', 'ACCESS_TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL']

/** 这些前缀属于「父 Agent 会话的身份」，必须切断。 */
const SESSION_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_', 'CODEX_SESSION_']

/** 这些精确名字同样属于父会话痕迹。 */
const SESSION_EXACT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_SESSION_ID'])

/** 端点类变量：保留，但值得让用户看见。 */
const ENDPOINT_MARKERS = ['BASE_URL', 'ENDPOINT', 'PROXY']

export interface ScrubbedEnv {
  readonly env: NodeJS.ProcessEnv
  /** 被清掉的变量名，供 UI 如实展示（只报名字，绝不报值）。 */
  readonly removed: readonly string[]
  /** 保留下来的端点类变量名，异常配置时便于排查。 */
  readonly endpoints: readonly string[]
}

function isCredential(name: string): boolean {
  const upper = name.toUpperCase()
  return CREDENTIAL_MARKERS.some((marker) => upper.includes(marker))
}

function isParentSession(name: string): boolean {
  const upper = name.toUpperCase()
  return SESSION_EXACT.has(upper) || SESSION_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

function isEndpoint(name: string): boolean {
  const upper = name.toUpperCase()
  return ENDPOINT_MARKERS.some((marker) => upper.includes(marker))
}

/**
 * 清洗要传给 Agent CLI 的环境。
 * @param source - 源环境，默认当前进程的。
 * @param overrides - 用户显式配置的变量，在清洗之后叠加（因此可以覆盖）。
 * @returns 清洗后的环境，以及被清掉/保留的变量名清单。
 */
export function scrubEnv(
  source: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string>> = {},
): ScrubbedEnv {
  const env: NodeJS.ProcessEnv = {}
  const removed: string[] = []
  const endpoints: string[] = []

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isCredential(name) || isParentSession(name)) {
      removed.push(name)
      continue
    }
    if (isEndpoint(name)) endpoints.push(name)
    env[name] = value
  }

  // 用户显式配置优先：确实要给子进程的东西必须走这里，而不是靠环境泄漏进去。
  for (const [name, value] of Object.entries(overrides)) env[name] = value

  return { env, removed: removed.sort(), endpoints: endpoints.sort() }
}
