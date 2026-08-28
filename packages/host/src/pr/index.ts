/**
 * Pull Request 这一侧：探测 `gh`、开 PR、读 PR 的状态。
 *
 * 沿用整个项目对 CLI 的那条规矩：**不要 API Key，用你本机已经登录好的
 * `gh`**。我们不接受、不存储、不传递 token —— 认证发生在 `gh` 自己那儿，
 * 和 `claude` / `codex` 的处理方式完全一致。
 *
 * 探测不到 `gh`、仓库没有远端、远端不是 GitHub —— 这三种情况一律**明确
 * 拒绝**，不降级成"那就本地合一下吧"。用户按的是"开 PR"，悄悄换成动他的
 * 主工作区是这个工具最不该给的惊喜。
 */

import { capture, findExecutable, type CaptureResult } from '../agents/discover.ts'

/** gh 的调用超时。开 PR 要过一次网，比本地探测宽松些。 */
const GH_TIMEOUT_MS = 60_000

export type PullRequestState = 'open' | 'merged' | 'closed'
/** GitHub 侧的可合并性。`unknown` 是它还在后台算，不是"没冲突"。 */
export type Mergeability = 'mergeable' | 'conflicting' | 'unknown'

export interface PullRequestView {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: PullRequestState
  readonly mergeable: Mergeability
  /** 合并时间；没合上就没有。 */
  readonly mergedAt?: number | undefined
}

export type GitHubRefusal = 'gh-missing' | 'no-remote' | 'not-github' | 'gh-failed'

export interface GitHubFailure {
  readonly ok: false
  readonly reason: GitHubRefusal
  readonly detail: string
}

export type GitHubResult<T> = ({ readonly ok: true } & T) | GitHubFailure

export interface GitHubOptions {
  /** `gh` 的绝对路径；不给则自己找。显式给 `null` 表示"当它没装"（测试用）。 */
  readonly bin?: string | null
  /** 供测试注入假的命令执行器。 */
  readonly capture?: (argv: readonly string[], timeoutMs?: number, cwd?: string) => Promise<CaptureResult>
}

/** 远端地址指向的那个仓库。 */
export interface RepoSlug {
  readonly host: string
  readonly owner: string
  readonly name: string
}

/**
 * 从远端 URL 认出 `owner/repo`。
 *
 * 三种写法都要认：`git@github.com:o/r.git`、`https://github.com/o/r.git`、
 * `ssh://git@github.com/o/r`。认不出来返回 null —— 那多半根本不是 GitHub。
 *
 * @param url - `git remote get-url` 的输出。
 */
export function parseRemote(url: string): RepoSlug | null {
  const text = url.trim()
  if (text.length === 0) return null
  const scp = /^(?:[^@]+@)?([^:/]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(text)
  const uri = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(text)
  const matched = text.includes('://') ? uri : scp
  if (matched === null) return null
  const [, host, owner, name] = matched
  if (host === undefined || owner === undefined || name === undefined) return null
  return { host, owner, name }
}

/**
 * `gh -R` 认的写法。github.com 用裸的 `owner/repo`，企业版要带上主机名。
 * @param slug - 认出来的仓库。
 */
export function repoArg(slug: RepoSlug): string {
  return slug.host === 'github.com'
    ? `${slug.owner}/${slug.name}`
    : `${slug.host}/${slug.owner}/${slug.name}`
}

interface PrJson {
  number?: number
  url?: string
  title?: string
  state?: string
  mergeable?: string
  mergedAt?: string | null
}

function toView(json: PrJson): PullRequestView | null {
  if (typeof json.number !== 'number' || typeof json.url !== 'string') return null
  const state = (json.state ?? '').toUpperCase()
  const mergeable = (json.mergeable ?? '').toUpperCase()
  const mergedAt = typeof json.mergedAt === 'string' ? Date.parse(json.mergedAt) : Number.NaN
  return {
    number: json.number,
    url: json.url,
    title: json.title ?? '',
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    // 只有 CONFLICTING 才算冲突。GitHub 还在后台算的时候给的是 UNKNOWN，
    // 把它当成"能合"会让界面在冲突还没暴露时就催人去合。
    mergeable: mergeable === 'MERGEABLE' ? 'mergeable' : mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    ...(Number.isNaN(mergedAt) ? {} : { mergedAt }),
  }
}

/** `gh pr view` 要的字段。多要一个字段的代价是零，少要一个要多跑一次。 */
const PR_FIELDS = 'number,url,title,state,mergeable,mergedAt'

export class GitHub {
  // 不用参数属性：strip-only 模式不支持（见 worktree/index.ts 同款说明）。
  private readonly options: GitHubOptions

  constructor(options: GitHubOptions = {}) {
    this.options = options
  }

  /**
   * `gh` 的位置，**每次现找**。
   *
   * 不在构造时定死：界面上那句提示写的是"先装上并 `gh auth login`"，而
   * Review 是开机时造一次的 —— 缓存住的话，用户照着做完、刷新页面，看到的
   * 仍然是"本机没找到 gh"，只有重启看板才生效。这和"装了个新的 CLI 不该
   * 逼人重启"是同一条规矩。找一次只是几次 access()，比一次 gh 调用便宜得多。
   */
  private get bin(): string | null {
    return this.options.bin === undefined ? findExecutable('gh') : this.options.bin
  }

  /** 本机有没有 `gh`。没有的话所有 PR 操作都会明确拒绝。 */
  available(): boolean {
    return this.bin !== null
  }

  private get run(): (argv: readonly string[], timeoutMs?: number, cwd?: string) => Promise<CaptureResult> {
    return this.options.capture ?? capture
  }

  /**
   * 这个仓库的默认远端指向哪个 GitHub 仓库。
   *
   * @param repoPath - 仓库路径。
   * @param remote - 远端名。
   */
  async slug(repoPath: string, remote: string): Promise<GitHubResult<{ slug: RepoSlug }>> {
    const { stdout, code } = await this.run(['git', '-C', repoPath, 'remote', 'get-url', remote], GH_TIMEOUT_MS)
    if (code !== 0) {
      return { ok: false, reason: 'no-remote', detail: `读不出远端 ${remote} 的地址` }
    }
    const slug = parseRemote(stdout)
    if (slug === null) {
      return { ok: false, reason: 'not-github', detail: `认不出这个远端地址：${stdout.trim()}` }
    }
    return { ok: true, slug }
  }

  /**
   * 查一条分支对应的 PR。
   *
   * @param repoPath - 仓库路径，`gh` 从这儿认当前仓库。
   * @param slug - 目标仓库。
   * @param head - 分支名，或 PR 号。
   * @returns `pr` 为 null 表示这条分支还没有 PR —— 那不是错误，是"还没开"。
   */
  async view(
    repoPath: string, slug: RepoSlug, head: string,
  ): Promise<GitHubResult<{ pr: PullRequestView | null }>> {
    const bin = this.bin
    if (bin === null) return missing()
    const { stdout, stderr, code } = await this.run(
      [bin, 'pr', 'view', head, '-R', repoArg(slug), '--json', PR_FIELDS],
      GH_TIMEOUT_MS,
      repoPath,
    )
    if (code !== 0) {
      const text = `${stdout}\n${stderr}`.toLowerCase()
      // 「这条分支还没有 PR」和「gh 出错了」必须分开：前者是正常状态，
      // 报成错误的话界面永远显示一条查不出来的红字。
      if (text.includes('no pull requests found') || text.includes('could not find')) {
        return { ok: true, pr: null }
      }
      return { ok: false, reason: 'gh-failed', detail: (stderr.trim() || stdout.trim()).slice(0, 800) }
    }
    try {
      const view = toView(JSON.parse(stdout) as PrJson)
      return view === null
        ? { ok: false, reason: 'gh-failed', detail: `gh 返回的 PR 数据缺字段：${stdout.slice(0, 200)}` }
        : { ok: true, pr: view }
    } catch {
      return { ok: false, reason: 'gh-failed', detail: `gh 的输出不是合法 JSON：${stdout.slice(0, 200)}` }
    }
  }

  /**
   * 开一条 PR；已经开过就把现成的那条查回来。
   *
   * **幂等**：同一张卡按两次"开 PR"、或者上一次开完在别处失败了重试，都不该
   * 造出第二条 PR，也不该报一个"already exists"让人自己去猜发生了什么。
   *
   * @param repoPath - 仓库路径。
   * @param slug - 目标仓库。
   * @param input - head / base 分支与标题正文。
   */
  async create(repoPath: string, slug: RepoSlug, input: {
    head: string; base: string; title: string; body: string
  }): Promise<GitHubResult<{ pr: PullRequestView; created: boolean }>> {
    const bin = this.bin
    if (bin === null) return missing()

    const existing = await this.view(repoPath, slug, input.head)
    if (existing.ok && existing.pr !== null && existing.pr.state === 'open') {
      return { ok: true, pr: existing.pr, created: false }
    }

    const { stdout, stderr, code } = await this.run(
      [
        bin, 'pr', 'create', '-R', repoArg(slug),
        '--head', input.head, '--base', input.base,
        '--title', input.title, '--body', input.body,
      ],
      GH_TIMEOUT_MS,
      repoPath,
    )
    if (code !== 0) {
      const text = `${stdout}\n${stderr}`.toLowerCase()
      // 竞态：两次点击撞在一起，或者上一次开完没记上。已经有了就去查回来。
      if (text.includes('already exists')) {
        const again = await this.view(repoPath, slug, input.head)
        if (again.ok && again.pr !== null) return { ok: true, pr: again.pr, created: false }
      }
      return { ok: false, reason: 'gh-failed', detail: (stderr.trim() || stdout.trim()).slice(0, 800) }
    }

    // create 只吐一行 URL，状态字段还得再查一次 —— 而"这条 PR 能不能合"
    // 正是接下来唯一要判的事。
    const opened = await this.view(repoPath, slug, input.head)
    if (!opened.ok) return opened
    if (opened.pr === null) {
      return { ok: false, reason: 'gh-failed', detail: `PR 已建（${stdout.trim()}）但随即查不到它` }
    }
    return { ok: true, pr: opened.pr, created: true }
  }
}

function missing(): GitHubFailure {
  return {
    ok: false,
    reason: 'gh-missing',
    detail: '本机没找到 gh —— 开 PR 用的是你自己登录好的 GitHub CLI，先装上并 `gh auth login`',
  }
}
