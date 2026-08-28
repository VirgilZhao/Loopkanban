/**
 * git worktree 生命周期。
 *
 * 每个任务一个 worktree + 一个分支：多个 Agent 可以在同一仓库并行干活而互不
 * 打架，跑飞了直接丢弃分支即可，主工作区永远不受影响。
 *
 * 直接调 `git` CLI 而不是用库：worktree 是相对新的特性，CLI 的行为最权威。
 */

import { access, appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { capture } from '../agents/discover.ts'

/** worktree 在项目里的落点。放进项目自己的目录，跟着项目走，不跟着 agent 走。 */
export const WORKTREE_HOME = '.loopkanban'

export interface Worktree {
  readonly path: string
  readonly branch: string
}

/** 跑一条 git 命令，失败时带上 stderr 抛出。 */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout, stderr, code } = await capture(['git', '-C', cwd, ...args], 60_000)
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} 失败 (code=${String(code)}): ${stderr.trim() || stdout.trim()}`)
  }
  return stdout
}

/** 把任务标题压成适合做分支名的 slug。 */
export function branchSlug(taskId: string, subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length > 0 ? `task/${taskId}-${slug}` : `task/${taskId}`
}

/** 某个任务在某个项目里的 worktree 路径。同一张卡永远是同一个目录。 */
export function worktreeDir(repoPath: string, taskId: string): string {
  return resolve(join(repoPath, WORKTREE_HOME, 'worktrees', taskId))
}

/**
 * 把 `.loopkanban/` 写进仓库的本地排除表。
 *
 * worktree 现在长在项目目录里面，不排除的话主仓库会一直显示一坨未跟踪文件 ——
 * 而"主工作区是否干净"正是合并前的硬前置条件，那样每次合并都会被自己挡下。
 *
 * 写 `.git/info/exclude` 而不是 `.gitignore`：那是用户的文件，不该被我们改。
 */
async function excludeWorktreeHome(repoPath: string): Promise<void> {
  // 仓库本身可能就是个 worktree（`.git` 是文件），排除表在公共 gitdir 里。
  const common = (await git(repoPath, ['rev-parse', '--git-common-dir'])).trim()
  const dir = isAbsolute(common) ? common : resolve(join(repoPath, common))
  const file = join(dir, 'info', 'exclude')
  const line = `/${WORKTREE_HOME}/`
  const existing = await readFile(file, 'utf8').catch(() => '')
  if (existing.split('\n').some((entry) => entry.trim() === line)) return
  await mkdir(join(dir, 'info'), { recursive: true })
  await appendFile(file, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${line}\n`, 'utf8')
}

/** 分支是否已经存在。 */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const { code } = await capture(['git', '-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 60_000)
  return code === 0
}

/**
 * 取得任务的 worktree，没有就建一个。
 *
 * **worktree 属于任务，不属于某次执行、更不属于某个 Agent**：打回重做、
 * 换个 CLI 接着干、跨进程重启，看到的都是同一个工作区里上一次的成果。
 * 所以这个函数必须是幂等的 —— 目录在就直接用，分支在就挂上去。
 *
 * @param repoPath - 项目仓库路径。
 * @param taskId - 任务 id，用作目录名。
 * @param branch - 分支名。
 * @param baseBranch - 目录与分支都不存在时，从哪个提交派生。
 */
export async function ensureWorktree(
  repoPath: string,
  taskId: string,
  branch: string,
  baseBranch: string,
): Promise<Worktree> {
  await excludeWorktreeHome(repoPath).catch(() => undefined)
  const path = worktreeDir(repoPath, taskId)

  const present = await access(path).then(() => true, () => false)
  if (present) {
    // 目录还在就接着用它，分支以目录里的实际状态为准。
    return { path, branch: (await currentBranch(path)) ?? branch }
  }

  await mkdir(join(repoPath, WORKTREE_HOME, 'worktrees'), { recursive: true })
  // 分支已经存在（上一次执行留下的），挂回来而不是重建 —— 重建会丢掉成果。
  await git(repoPath, await branchExists(repoPath, branch)
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, baseBranch])
  return { path, branch }
}

/**
 * 移除 worktree；`keepBranch` 为假时连分支一起删。
 * @param repoPath - 主仓库路径。
 * @param worktree - 要移除的 worktree。
 * @param keepBranch - 保留分支（人类要自己去开 PR 时用）。
 */
export async function removeWorktree(repoPath: string, worktree: Worktree, keepBranch: boolean): Promise<void> {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', worktree.path])
  } catch {
    // worktree 目录可能已被外力删掉，兜底清理，别让残留卡住后续任务。
    await rm(worktree.path, { recursive: true, force: true })
    await git(repoPath, ['worktree', 'prune'])
  }
  if (!keepBranch) {
    try {
      await git(repoPath, ['branch', '-D', worktree.branch])
    } catch {
      // 分支可能已经不在了，不是错误。
    }
  }
}

/** 工作区是否干净（无未提交改动，也无未跟踪文件）。 */
export async function isClean(path: string): Promise<boolean> {
  return (await git(path, ['status', '--porcelain'])).trim().length === 0
}

/** 这个目录是不是一个 git 仓库（工作区，不是裸库）。 */
export async function isGitRepo(path: string): Promise<boolean> {
  const { stdout, code } = await capture(['git', '-C', path, 'rev-parse', '--is-inside-work-tree'], 60_000)
  return code === 0 && stdout.trim() === 'true'
}

/** 派生任务分支时优先认的基线名，按这个顺序找第一个存在的。 */
const PREFERRED_BASE = ['main', 'master'] as const

/**
 * 项目的默认基线分支。
 *
 * **不取"仓库当前在哪个分支"**：那个分支很可能只是你上一次干活留下的落脚点
 * （某个 feature 分支、某次 review 的检出），把它当基线，之后每张卡都会长在
 * 那堆无关改动上面，合回去时才发现带了一车东西。默认应该是仓库的主干。
 *
 * 找不到 main / master（新仓库、或者主干另有其名）时才退回当前分支 ——
 * 那种仓库里，当前分支是唯一比"猜一个不存在的名字"更好的答案。真正的答案
 * 由用户在新增项目时自己选，这里只是个默认值。
 */
export async function detectBaseBranch(repoPath: string): Promise<string> {
  for (const name of PREFERRED_BASE) {
    if (await branchExists(repoPath, name).catch(() => false)) return name
  }
  return (await currentBranch(repoPath).catch(() => null)) ?? 'main'
}

/**
 * 仓库里的本地分支，最近提交的排在前面。
 *
 * 只列本地分支：worktree 只能从本地 ref 派生，列一堆 `origin/*` 只会让人
 * 选中一个建不出来的东西。新仓库（还没有任何提交）返回空数组。
 */
export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads'])
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * 当前分支名；detached HEAD 时返回 null。
 *
 * 用 `symbolic-ref` 而不是 `rev-parse --abbrev-ref`：还没有任何提交的仓库里
 * 后者会直接失败，而此刻 HEAD 明明指着一个分支名 —— 那正是这种仓库唯一能
 * 给出的基线。
 */
export async function currentBranch(path: string): Promise<string | null> {
  const { stdout, code } = await capture(['git', '-C', path, 'symbolic-ref', '--short', 'HEAD'], 60_000)
  const name = stdout.trim()
  return code !== 0 || name.length === 0 ? null : name
}

/** 派活时写进 worktree 根目录的任务规格。它是这次执行的**输入**，不是产出。 */
export const TASK_SPEC = 'TASK.md'

/**
 * 根上那份 TASK.md 是不是我们写的。
 *
 * 判据是"没被跟踪"：仓库自己就有一份 TASK.md 的话，它是用户的文件，
 * 该不该进提交轮不到我们决定。
 *
 * @param path - 工作区路径。
 */
async function ownsTaskSpec(path: string): Promise<boolean> {
  const { stdout, code } = await capture(['git', '-C', path, 'ls-files', '--', TASK_SPEC], 60_000)
  return code === 0 && stdout.trim().length === 0
}

/**
 * `git add -A`，但把我们自己写的那份 TASK.md 挡在外面。
 *
 * 它是交给 Agent 的需求书，不是 Agent 干出来的活。跟着一起提交，它就会
 * 出现在分支上、出现在 PR 的 diff 里，最后连同整条讨论线程一起合进主干 ——
 * 那是这个工具的内部记录，不该落在用户的仓库里。
 *
 * @param path - 工作区路径。
 * @param extra - 额外的 `git add` 参数（例如 `--intent-to-add`）。
 */
async function stageAll(path: string, extra: readonly string[] = []): Promise<void> {
  const args = ['add', '-A', ...extra]
  await git(path, await ownsTaskSpec(path) ? [...args, '--', `:!${TASK_SPEC}`] : args)
}

/**
 * 把 worktree 里的全部改动提交到它自己的分支。
 *
 * Agent 被要求不要提交，所以改动一直躺在工作区。验收通过时由我们来提交，
 * 这样才有一个可以合并、可以开 PR、可以回滚的对象。
 *
 * @param worktree - 目标 worktree。
 * @param message - 提交信息。
 * @returns 新提交的 sha；没有任何改动时返回 null。
 * @throws 工作区里还有没解开的冲突时抛 —— 调用方要么让人去解，要么明确放弃。
 */
export async function commitAll(worktree: Worktree, message: string): Promise<string | null> {
  // 冲突还没解就提交，等于把 `<<<<<<<` 那几行一并提交进分支 —— `git add -A`
  // 会把冲突文件当成"已解决"，git 自己那道"有未合并路径"的拦截就失效了。
  // 这一步必须在 add 之前，而且必须抛：调用方要么让人去解，要么明确放弃。
  const unresolved = await unresolvedConflicts(worktree.path)
  if (unresolved.length > 0) {
    throw new Error(`工作区里还有没解开的冲突：${unresolved.join('、')}`)
  }
  await stageAll(worktree.path)
  // 合并冲突解到一半的工作区里，暂存区可能与 HEAD 一模一样（冲突全被解成了
  // 原样），但那次合并还没落成提交。此时"没有改动"是错的判断：不提交的话
  // MERGE_HEAD 会一直挂着，分支上永远看不到基线那边的东西，PR 也永远显示冲突。
  const staged = (await git(worktree.path, ['diff', '--cached', '--name-only'])).trim().length > 0
  if (!staged && !(await isMerging(worktree.path))) return null
  await git(worktree.path, ['commit', '-m', message])
  return (await git(worktree.path, ['rev-parse', 'HEAD'])).trim()
}

/** 这个工作区是不是停在一次没做完的合并里（有冲突要解，或解完了还没提交）。 */
export async function isMerging(path: string): Promise<boolean> {
  const dir = (await git(path, ['rev-parse', '--git-dir'])).trim()
  const gitDir = isAbsolute(dir) ? dir : resolve(join(path, dir))
  return access(join(gitDir, 'MERGE_HEAD')).then(() => true, () => false)
}

/**
 * 索引里还处于"未合并"状态的文件（相对工作区根）。没有冲突就是空数组。
 *
 * 注意它**不等于"还没解开"**：文件一直挂在这个状态里，直到有人 `git add`
 * 它 —— 而解冲突的人（或 Agent）只被要求改文件，不许提交也不必暂存。
 * 要判"解没解开"看 {@link unresolvedConflicts}。
 */
export async function conflictedFiles(path: string): Promise<string[]> {
  // **必须用 `-z`**：默认输出会把非 ASCII 的文件名整段 C 转义并加上引号
  // （`"\344\270\255\346\226\207.ts"`），拿那串东西去 readFile 只会
  // ENOENT —— 于是"还没解开的冲突"被判成已解决，冲突标记就跟着提交进去了。
  // `-z` 用 NUL 分隔，路径一律原样输出，连带文件名里有换行的也稳。
  const out = await git(path, ['diff', '-z', '--name-only', '--diff-filter=U'])
  return out.split('\0').filter((line) => line.length > 0)
}

/**
 * 真正还没解开的冲突：正文里仍然留着冲突标记的那些文件。
 *
 * 判据落在**内容**而不是索引状态上，因为这个项目里解冲突的分工是"人/Agent
 * 只改文件，提交归看板"—— 改完的文件在索引里照样是未合并的，拿索引当判据
 * 会让每一次收尾都被自己挡下。
 *
 * 三条标记要一起看：只找 `<<<<<<<` 会把一份正在讲解冲突的文档误判成没解开。
 * 文件读不出来（一边删了、二进制）当作已解决 —— `git add -A` 会照实记下
 * 那个决定。
 *
 * @param path - 工作区路径。
 */
export async function unresolvedConflicts(path: string): Promise<string[]> {
  const unmerged = await conflictedFiles(path)
  const left: string[] = []
  for (const file of unmerged) {
    const text = await readFile(join(path, file), 'utf8').catch(() => '')
    if (/^<{7} /m.test(text) && /^={7}$/m.test(text) && /^>{7} /m.test(text)) left.push(file)
  }
  return left
}

/** 仓库配置的远端名字，按 git 自己的顺序。没有远端就是空数组。 */
export async function listRemotes(repoPath: string): Promise<string[]> {
  const { stdout, code } = await capture(['git', '-C', repoPath, 'remote'], 60_000)
  if (code !== 0) return []
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * 推送用的远端：有 `origin` 就是它，否则第一个；一个都没有返回 null。
 *
 * 不猜第二个名字（`upstream` 之类）：多远端的仓库里，推错地方是没法悄悄
 * 撤销的事，而 `origin` 是绝大多数仓库唯一的答案。
 */
export async function defaultRemote(repoPath: string): Promise<string | null> {
  const remotes = await listRemotes(repoPath)
  if (remotes.includes('origin')) return 'origin'
  return remotes[0] ?? null
}

export type GitRefusal = 'push-failed' | 'fetch-failed' | 'merge-conflict' | 'merge-failed'

export interface GitFailure {
  readonly ok: false
  readonly reason: GitRefusal
  readonly detail: string
  /** 冲突未解的文件；只有 `merge-conflict` 有。 */
  readonly files?: readonly string[]
}

/**
 * 把分支推到远端。
 *
 * 从 worktree 里推而不是主仓库：两者共用同一份 ref 与远端配置，但 worktree
 * 一定停在这条任务分支上，不必担心主工作区当时在哪儿。
 *
 * `--force-with-lease` 不用：任务分支只有我们在写，普通推送失败就说明远端
 * 上那条分支被别人动过 —— 那时该让人看见，而不是替他覆盖掉。
 *
 * @param worktree - 任务的工作区。
 * @param remote - 远端名。
 */
export async function pushBranch(
  worktree: Worktree, remote: string,
): Promise<{ ok: true } | GitFailure> {
  const { stdout, stderr, code } = await capture(
    ['git', '-C', worktree.path, 'push', '-u', remote, `${worktree.branch}:${worktree.branch}`],
    120_000,
  )
  if (code !== 0) {
    return { ok: false, reason: 'push-failed', detail: (stderr.trim() || stdout.trim()).slice(0, 800) }
  }
  return { ok: true }
}

/** 拉一条远端分支的最新状态。取不到（网络、权限、分支还不存在）时如实报出来。 */
export async function fetchBranch(
  repoPath: string, remote: string, branch: string,
): Promise<{ ok: true } | GitFailure> {
  const { stdout, stderr, code } = await capture(
    ['git', '-C', repoPath, 'fetch', remote, branch], 120_000,
  )
  if (code !== 0) {
    return { ok: false, reason: 'fetch-failed', detail: (stderr.trim() || stdout.trim()).slice(0, 800) }
  }
  return { ok: true }
}

/**
 * 把基线合进任务分支 —— 也就是「冲突提前在自己的工作区里发生」。
 *
 * 冲突留在工作区里**不 abort**：那正是要解的东西，抹掉它等于让下一轮
 * Agent 从头再撞一次同样的冲突。解冲突的人（或 Agent）只需要改文件，
 * 提交由我们在下一次 {@link commitAll} 里完成 —— 与"Agent 不提交"这条
 * 一贯的规矩一致。
 *
 * @param worktree - 任务的工作区，必须停在任务分支上。
 * @param ref - 要合进来的基线 ref，例如 `origin/main` 或 `main`。
 * @returns 干净合上（`merged` 表示这次真的产生了合并提交），或冲突/失败。
 */
export async function mergeIntoBranch(
  worktree: Worktree, ref: string,
): Promise<{ ok: true; merged: boolean } | GitFailure> {
  const behind = (await git(worktree.path, ['rev-list', '--count', `HEAD..${ref}`])).trim()
  if (behind === '0') return { ok: true, merged: false }

  const { stdout, stderr, code } = await capture(
    ['git', '-C', worktree.path, 'merge', '--no-edit', ref], 120_000,
  )
  if (code === 0) return { ok: true, merged: true }

  const files = await conflictedFiles(worktree.path)
  if (files.length > 0) {
    return {
      ok: false,
      reason: 'merge-conflict',
      detail: `与 ${ref} 有冲突：${files.join('、')}`,
      files,
    }
  }
  // 非冲突的失败（工作区脏、ref 不存在）：把合并状态收干净再报，
  // 否则工作区会停在一个既没冲突、也没合完的半途里。
  await capture(['git', '-C', worktree.path, 'merge', '--abort'], 60_000)
  return { ok: false, reason: 'merge-failed', detail: (stderr.trim() || stdout.trim()).slice(0, 800) }
}

export type MergeRefusal = 'dirty-worktree' | 'wrong-branch'

/**
 * 把任务分支合并回基线。
 *
 * **默认不做这件事**：用户的主工作区可能是脏的、可能停在别的分支上，
 * 自动合并进去正是最该避免的破坏性意外。只有用户显式要求时才调用，
 * 且前置条件不满足就明确拒绝，绝不"尽力而为"。
 *
 * @param repoPath - 主仓库。
 * @param branch - 任务分支。
 * @param baseBranch - 目标基线分支。
 * @returns 成功，或拒绝的原因。
 */
export async function mergeBranch(
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<{ ok: true } | { ok: false; reason: MergeRefusal; detail: string }> {
  if (!(await isClean(repoPath))) {
    return { ok: false, reason: 'dirty-worktree', detail: '主工作区有未提交改动，先处理干净再合并' }
  }
  const branchNow = await currentBranch(repoPath)
  if (branchNow !== baseBranch) {
    return {
      ok: false,
      reason: 'wrong-branch',
      detail: `主工作区当前在 ${branchNow ?? 'detached HEAD'}，不是基线分支 ${baseBranch}`,
    }
  }
  await git(repoPath, ['merge', '--no-ff', '-m', `Merge ${branch}`, branch])
  return { ok: true }
}

/** worktree 相对基线分支的完整 diff（含未提交改动）。 */
export async function worktreeDiff(worktree: Worktree, baseBranch: string): Promise<string> {
  // 与 commitAll 用同一套暂存规则 —— diff 页要显示的是"这次会提交什么"，
  // 把一份根本不会进提交的 TASK.md 摆在里面，人对着它验收就是在看错东西。
  await stageAll(worktree.path, ['--intent-to-add'])
  return git(worktree.path, ['diff', baseBranch, '--stat'])
    .then(async (stat) => `${stat}\n${await git(worktree.path, ['diff', baseBranch])}`)
}

/** 启动时对账：列出仓库当前登记的 worktree 路径。 */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  return out.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
}
