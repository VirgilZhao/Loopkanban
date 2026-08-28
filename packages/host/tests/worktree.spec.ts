import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '../src/agents/discover.ts'
import {
  WORKTREE_HOME, commitAll, conflictedFiles, currentBranch, defaultRemote, detectBaseBranch,
  ensureWorktree, isClean, isGitRepo, isMerging, listBranches, mergeIntoBranch, pushBranch,
  TASK_SPEC, unresolvedConflicts, worktreeDiff, worktreeDir,
} from '../src/worktree/index.ts'

let sandbox: string
let repo: string

const git = (cwd: string, ...args: string[]) => capture(['git', '-C', cwd, ...args])

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'loopkanban-worktree-'))
  repo = join(sandbox, 'repo')
  await capture(['git', 'init', '-q', '-b', 'main', repo])
  for (const args of [['config', 'user.email', 't@t'], ['config', 'user.name', 'T']]) await git(repo, ...args)
  await writeFile(join(repo, 'README.md'), '# demo\n', 'utf8')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'init')
})

afterEach(async () => { await rm(sandbox, { recursive: true, force: true }) })

describe('ensureWorktree', () => {
  it('落在项目目录里的 .loopkanban/worktrees/<taskId>', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    expect(wt.path).toBe(worktreeDir(repo, 't1'))
    expect(wt.path.startsWith(join(repo, WORKTREE_HOME, 'worktrees'))).toBe(true)
    expect(await currentBranch(wt.path)).toBe('task/t1')
  })

  it('把 .loopkanban 写进本地排除表 —— 否则主仓库永远是脏的，合并会被自己挡下', async () => {
    await ensureWorktree(repo, 't1', 'task/t1', 'main')
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain(`/${WORKTREE_HOME}/`)
    // 这条才是真正要的结论：worktree 长在仓库里，但主工作区依然干净。
    expect(await isClean(repo)).toBe(true)
  })

  it('幂等：同一张卡再要一次，还是那个工作区，成果不丢', async () => {
    const first = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(first.path, 'work.txt'), '干到一半\n', 'utf8')

    const again = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    expect(again.path).toBe(first.path)
    await expect(access(join(again.path, 'work.txt'))).resolves.toBeUndefined()
  })

  it('目录被删、分支还在：挂回原分支而不是从基线重开', async () => {
    const first = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(first.path, 'done.txt'), '上一轮的成果\n', 'utf8')
    await git(first.path, 'add', '-A')
    await git(first.path, 'commit', '-qm', 'wip')
    await git(repo, 'worktree', 'remove', '--force', first.path)

    const again = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    expect(again.branch).toBe('task/t1')
    // 从 main 重开的话这个文件不会在 —— 它只存在于任务分支上。
    await expect(access(join(again.path, 'done.txt'))).resolves.toBeUndefined()
  })

  it('换个 Agent 接着干也是同一个工作区 —— worktree 属于任务，不属于谁在跑', async () => {
    const claude = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(claude.path, 'half.txt'), '半成品\n', 'utf8')
    const codex = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    expect(codex.path).toBe(claude.path)
    await expect(access(join(codex.path, 'half.txt'))).resolves.toBeUndefined()
  })
})

describe('项目探测', () => {
  it('认得出 git 仓库，也认得出不是', async () => {
    expect(await isGitRepo(repo)).toBe(true)
    expect(await isGitRepo(sandbox)).toBe(false)
  })

  it('基线默认取 main，不跟着仓库当前停在哪条分支走', async () => {
    expect(await detectBaseBranch(repo)).toBe('main')
    // 这正是要防的那一幕：人正停在某条 feature 分支上就去建项目，
    // 基线跟着走的话，之后每张卡都长在那条分支的改动上面。
    await git(repo, 'checkout', '-q', '-b', 'codex/some-feature')
    expect(await detectBaseBranch(repo)).toBe('main')
  })

  it('没有 main / master 才退回当前分支', async () => {
    await git(repo, 'branch', '-m', 'main', 'trunk')
    expect(await detectBaseBranch(repo)).toBe('trunk')
  })

  it('还没有提交的仓库：分支清单是空的，基线退回 HEAD 指着的名字', async () => {
    const fresh = join(sandbox, 'fresh')
    await capture(['git', 'init', '-q', '-b', 'main', fresh])
    expect(await listBranches(fresh)).toEqual([])
    expect(await detectBaseBranch(fresh)).toBe('main')
  })

  it('列出本地分支，最近提交的在前', async () => {
    await git(repo, 'checkout', '-q', '-b', 'later')
    await writeFile(join(repo, 'x.txt'), 'x\n', 'utf8')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'later')
    expect(await listBranches(repo)).toEqual(['later', 'main'])
  })
})

/** 在基线上再提交一笔，制造"任务分支落后于主干"的局面。 */
async function advanceBase(file: string, body: string): Promise<void> {
  await writeFile(join(repo, file), body, 'utf8')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', `base: ${file}`)
}

describe('mergeIntoBranch', () => {
  it('基线没动过就什么都不做 —— 不该平白造一个空的合并提交', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    expect(await mergeIntoBranch(wt, 'main')).toEqual({ ok: true, merged: false })
  })

  it('改的是不同的地方就干净合上，基线那边的东西一并到位', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, 'mine.txt'), '我的\n', 'utf8')
    await commitAll(wt, 'mine')
    await advanceBase('theirs.txt', '别人的\n')

    expect(await mergeIntoBranch(wt, 'main')).toEqual({ ok: true, merged: true })
    expect(await readFile(join(wt.path, 'theirs.txt'), 'utf8')).toBe('别人的\n')
    expect(await isMerging(wt.path)).toBe(false)
  })

  it('冲突**原样留在工作区**：那正是下一轮要解的东西，abort 掉等于让它再撞一次', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, 'README.md'), '# 我改的\n', 'utf8')
    await commitAll(wt, 'mine')
    await advanceBase('README.md', '# 他改的\n')

    const merged = await mergeIntoBranch(wt, 'main')
    expect(merged).toMatchObject({ ok: false, reason: 'merge-conflict', files: ['README.md'] })
    // 合并状态还挂着，冲突标记也还在 —— 解完由 commitAll 收尾。
    expect(await isMerging(wt.path)).toBe(true)
    expect(await readFile(join(wt.path, 'README.md'), 'utf8')).toContain('<<<<<<<')
  })
})

describe('commitAll 与合并', () => {
  it('冲突没解就拒绝提交 —— 否则 `<<<<<<<` 会被 add -A 一起提交进去', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, 'README.md'), '# 我改的\n', 'utf8')
    await commitAll(wt, 'mine')
    await advanceBase('README.md', '# 他改的\n')
    await mergeIntoBranch(wt, 'main')

    await expect(commitAll(wt, 'x')).rejects.toThrow(/冲突/)
  })

  it('冲突解完就把那次合并收尾 —— 哪怕解出来和原来一模一样', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, 'README.md'), '# 我改的\n', 'utf8')
    await commitAll(wt, 'mine')
    await advanceBase('README.md', '# 他改的\n')
    await mergeIntoBranch(wt, 'main')

    // 解冲突：留下自己那一版（内容与合并前的 HEAD 一致，暂存区因此看着没变）。
    // **不 `git add`** —— 解冲突的人只被要求改文件，暂存与提交归看板。
    await writeFile(join(wt.path, 'README.md'), '# 我改的\n', 'utf8')
    // 索引里它仍是"未合并"，但标记已经没了 —— 后者才是"解没解开"的判据。
    expect(await conflictedFiles(wt.path)).toEqual(['README.md'])
    expect(await unresolvedConflicts(wt.path)).toEqual([])

    expect(await commitAll(wt, 'resolve')).not.toBeNull()
    expect(await isMerging(wt.path)).toBe(false)
    expect(await isClean(wt.path)).toBe(true)
    // 合上了才算数：基线那条提交现在是这条分支的祖先。
    const { code } = await git(wt.path, 'merge-base', '--is-ancestor', 'main', 'HEAD')
    expect(code).toBe(0)
  })
})

describe('远端', () => {
  it('没有远端就是 null —— 不猜一个名字出来', async () => {
    expect(await defaultRemote(repo)).toBeNull()
  })

  it('origin 优先，且推的是任务分支本身', async () => {
    const bare = join(sandbox, 'origin.git')
    await capture(['git', 'init', '-q', '--bare', bare])
    await git(repo, 'remote', 'add', 'upstream', bare)
    await git(repo, 'remote', 'add', 'origin', bare)
    expect(await defaultRemote(repo)).toBe('origin')

    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, 'mine.txt'), '我的\n', 'utf8')
    await commitAll(wt, 'mine')

    expect(await pushBranch(wt, 'origin')).toEqual({ ok: true })
    const { stdout } = await capture(['git', '-C', bare, 'branch', '--list', 'task/t1'])
    expect(stdout.trim()).toContain('task/t1')
  })

  it('推不上去时如实报出来，不当作成功', async () => {
    await git(repo, 'remote', 'add', 'origin', join(sandbox, 'nowhere.git'))
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    expect(await pushBranch(wt, 'origin')).toMatchObject({ ok: false, reason: 'push-failed' })
  })
})

describe('冲突文件名带引号（回归）', () => {
  /** git 默认会把非 ASCII 路径整段 C 转义并加引号 —— 那串东西 readFile 打不开。 */
  it('非 ASCII 的冲突文件照样认得出来，标记不会被偷偷提交进去', async () => {
    const name = '中文文件.txt'
    await writeFile(join(repo, name), '原始\n', 'utf8')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'add cjk')

    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, name), '我改的\n', 'utf8')
    await commitAll(wt, 'mine')
    await writeFile(join(repo, name), '他改的\n', 'utf8')
    await git(repo, 'commit', '-qam', 'base moved')

    const merged = await mergeIntoBranch(wt, 'main')
    // 文件名要是原样的，不能是 "\344\270\255..." —— 那串东西给 Agent 看也没用。
    expect(merged).toMatchObject({ ok: false, reason: 'merge-conflict', files: [name] })
    expect(await conflictedFiles(wt.path)).toEqual([name])
    // 关键的一条：没解开就是没解开，别被引号骗过去把标记提交了。
    expect(await unresolvedConflicts(wt.path)).toEqual([name])
    await expect(commitAll(wt, 'x')).rejects.toThrow(/冲突/)
  })
})

describe('TASK.md 不进提交', () => {
  it('我们写的那份是需求书，不是产出 —— 不提交，也不摆进 diff', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, TASK_SPEC), '# 需求\n\n整条讨论线程\n', 'utf8')
    await writeFile(join(wt.path, 'work.js', ), 'export const x = 1\n', 'utf8')

    expect(await commitAll(wt, 'work')).not.toBeNull()
    const { stdout } = await git(wt.path, 'show', '--name-only', '--format=', 'HEAD')
    expect(stdout.trim().split('\n')).toEqual(['work.js'])
    // 文件本身还在工作区里 —— Agent 下一轮还要读它。
    expect(await readFile(join(wt.path, TASK_SPEC), 'utf8')).toContain('整条讨论线程')
    // diff 页显示的就该是"这次会提交什么"。
    expect(await worktreeDiff(wt, 'main')).not.toContain(TASK_SPEC)
  })

  it('只有一份 TASK.md 可改时不算改动 —— 那一轮什么都没干出来', async () => {
    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, TASK_SPEC), '# 需求\n', 'utf8')
    expect(await commitAll(wt, 'nothing')).toBeNull()
  })

  it('仓库自己就跟踪着 TASK.md 的话，它是用户的文件，照常提交', async () => {
    await writeFile(join(repo, TASK_SPEC), '这是仓库自己的\n', 'utf8')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', 'repo owns TASK.md')

    const wt = await ensureWorktree(repo, 't1', 'task/t1', 'main')
    await writeFile(join(wt.path, TASK_SPEC), '改过的\n', 'utf8')

    expect(await commitAll(wt, 'edit')).not.toBeNull()
    const { stdout } = await git(wt.path, 'show', '--name-only', '--format=', 'HEAD')
    expect(stdout.trim().split('\n')).toEqual([TASK_SPEC])
  })
})
