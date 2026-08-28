import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '../src/agents/discover.ts'
import {
  WORKTREE_HOME, currentBranch, detectBaseBranch, ensureWorktree, isClean, isGitRepo, listBranches,
  worktreeDir,
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
