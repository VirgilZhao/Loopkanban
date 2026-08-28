import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveTask, asBoardId, asRunId, asTaskId, type Task } from '@openkanban/core'
import { capture } from '../src/agents/discover.ts'
import { Review } from '../src/review/index.ts'
import { Storage } from '../src/storage/index.ts'
import { createWorktree, branchSlug, currentBranch, isClean } from '../src/worktree/index.ts'

const T0 = 1_700_000_000_000
const BOARD = asBoardId('b1')

let sandbox: string
let repo: string
let store: Storage
let review: Review

const git = (cwd: string, ...args: string[]) => capture(['git', '-C', cwd, ...args])

function task(patch: Omit<Partial<Task>, 'id'> & { id: string }): Task {
  const { id, ...rest } = patch
  return {
    id: asTaskId(id), boardId: BOARD, revision: 1, column: 'review', position: 1,
    subject: '加个 slugify', description: '', acceptance: ['有测试'],
    repoPath: repo, baseBranch: 'main', blockedBy: [], writeScopes: [],
    createdAt: T0, updatedAt: T0, ...rest,
  }
}

/** 建一张已执行过、worktree 里有改动的卡。 */
async function reviewable(id = 't1'): Promise<{ worktreePath: string; branch: string }> {
  store.createTask(task({ id }))
  const branch = branchSlug(id, 'slugify')
  const wt = await createWorktree(repo, join(sandbox, 'worktrees'), id, branch, 'main')
  await writeFile(join(wt.path, 'slugify.js'), 'export const slugify = (s) => s\n', 'utf8')
  store.createRun({
    id: asRunId(`run-${id}`), taskId: asTaskId(id), provider: 'codex', cliVersion: '0.150.1',
    agentSessionId: 'thread-1', worktreePath: wt.path, branch: wt.branch,
    status: 'completed', exitCode: 0, startedAt: T0, endedAt: T0 + 1000,
  })
  return { worktreePath: wt.path, branch: wt.branch }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'openkanban-review-'))
  repo = join(sandbox, 'repo')
  await capture(['git', 'init', '-q', '-b', 'main', repo])
  for (const args of [['config', 'user.email', 't@t'], ['config', 'user.name', 'T']]) await git(repo, ...args)
  await writeFile(join(repo, 'README.md'), '# demo\n', 'utf8')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'init')

  store = Storage.open(':memory:')
  store.createBoard({ id: BOARD, name: '默认', repoPath: repo, baseBranch: 'main', createdAt: T0 })
  review = new Review({ storage: store, worktreeRoot: join(sandbox, 'worktrees'), now: () => T0 + 5000 })
})

afterEach(async () => { store.close(); await rm(sandbox, { recursive: true, force: true }) })

describe('diff', () => {
  it('拆出统计与补丁两部分', async () => {
    await reviewable()
    const view = await review.diff(asTaskId('t1'))
    expect(view?.stat).toContain('slugify.js')
    expect(view?.patch).toContain('diff --git')
    expect(view?.patch).toContain('slugify')
    expect(view?.truncated).toBe(false)
  })

  it('没有执行记录时返回 null', async () => {
    store.createTask(task({ id: 't1' }))
    expect(await review.diff(asTaskId('t1'))).toBeNull()
  })
})

describe('accept', () => {
  it('默认只提交到任务分支并保留它，绝不动主工作区', async () => {
    const { branch } = await reviewable()
    const before = await git(repo, 'rev-parse', 'main')

    const result = await review.accept(asTaskId('t1'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.commit).not.toBeNull()
    expect(result.merged).toBe(false)

    // main 没动，主工作区依然干净。
    expect((await git(repo, 'rev-parse', 'main')).stdout).toBe(before.stdout)
    expect(await isClean(repo)).toBe(true)
    // 分支保留，用户可以自己合并或开 PR。
    expect((await git(repo, 'branch', '--list', branch)).stdout.trim()).not.toBe('')
    expect(store.getTask(asTaskId('t1'))?.column).toBe('done')
  })

  it('显式要求时才合并回基线', async () => {
    await reviewable()
    const result = await review.accept(asTaskId('t1'), true)
    expect(result).toMatchObject({ ok: true, merged: true })
    expect((await git(repo, 'log', '--oneline', 'main')).stdout).toContain('Merge')
    expect((await git(repo, 'show', 'main:slugify.js')).stdout).toContain('slugify')
  })

  it('主工作区不干净时拒绝合并，而不是勉强执行', async () => {
    await reviewable()
    await writeFile(join(repo, 'scratch.txt'), 'wip\n', 'utf8')

    const result = await review.accept(asTaskId('t1'), true)
    expect(result).toMatchObject({ ok: false, reason: 'dirty-worktree' })
    // 拒绝之后卡片仍在 review，用户处理完可以重来。
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })

  it('主工作区停在别的分支时拒绝合并', async () => {
    await reviewable()
    await git(repo, 'checkout', '-q', '-b', 'other')

    const result = await review.accept(asTaskId('t1'), true)
    expect(result).toMatchObject({ ok: false, reason: 'wrong-branch' })
    expect((await currentBranch(repo))).toBe('other')
  })

  it('不在 review 列的卡不能验收', async () => {
    store.createTask(task({ id: 't1', column: 'running' }))
    expect(await review.accept(asTaskId('t1'))).toMatchObject({ ok: false, reason: 'illegal-transition' })
  })
})

describe('requestChanges', () => {
  it('带意见回到 ready，worktree 与分支都保留', async () => {
    const { worktreePath } = await reviewable()
    const result = review.requestChanges(asTaskId('t1'), '中文标题会被吃掉，要保留 Unicode 字母')

    expect(result.ok).toBe(true)
    const task = store.getTask(asTaskId('t1'))
    expect(task?.column).toBe('ready')
    expect(task?.feedback).toContain('Unicode')
    // 下一次执行要接着改，工作区不能被清掉。
    await expect(readFile(join(worktreePath, 'slugify.js'), 'utf8')).resolves.toContain('slugify')
  })

  it('空意见被拒 —— 否则 Agent 只会把上次的活重做一遍', () => {
    store.createTask(task({ id: 't1' }))
    expect(review.requestChanges(asTaskId('t1'), '   ')).toMatchObject({ ok: false, reason: 'feedback-required' })
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })

  it('只有 review 列的卡能打回', () => {
    store.createTask(task({ id: 't1', column: 'done' }))
    expect(review.requestChanges(asTaskId('t1'), '改一下')).toMatchObject({ ok: false, reason: 'illegal-transition' })
  })
})

describe('失败的执行也停在 Review', () => {
  it('起进程就失败、没有 worktree 的卡：明确拒绝验收，而不是在不存在的目录上跑 git', async () => {
    store.createTask(task({ id: 't1' }))
    store.createRun({
      id: asRunId('run-t1'), taskId: asTaskId('t1'), provider: 'codex', cliVersion: '0.150.1',
      worktreePath: join(sandbox, 'worktrees', 'never-created'), branch: 'ok/t1-slugify',
      status: 'failed', exitCode: 1, diagnostic: 'spawn ENOENT', startedAt: T0, endedAt: T0 + 10,
    })
    expect(await review.accept(asTaskId('t1'))).toMatchObject({ ok: false, reason: 'no-worktree' })
    // 拒绝了就不该动卡片 —— 人还要靠它打回重跑。
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })

  it('失败的卡打回后回到队列，接着重新排队执行', () => {
    store.createTask(task({ id: 't1' }))
    expect(review.requestChanges(asTaskId('t1'), '先把依赖装上')).toMatchObject({ ok: true })
    expect(store.getTask(asTaskId('t1'))).toMatchObject({ column: 'ready', feedback: '先把依赖装上' })
  })
})

describe('副作用绝不跑在领域判定之前（回归）', () => {
  it('归档的卡验收被拒时，主干一个提交都不该动', async () => {
    const { branch } = await reviewable()
    const shelved = archiveTask(store.getTask(asTaskId('t1')) as Task, { expectedRevision: 1, now: T0 + 10 })
    if (!shelved.ok) throw new Error(shelved.detail)
    store.commitTask(shelved.value)

    const mainBefore = (await git(repo, 'rev-parse', 'main')).stdout.trim()
    const result = await review.accept(asTaskId('t1'), true)

    // 归档不改 column，所以"只有 review 列能验收"那道检查是放行的；
    // 真正拦住它的是领域层的冻结规则，而那必须在 commitAll / mergeBranch
    // 之前生效 —— 否则用户看到"操作被拒绝"，主干却已经被合过了。
    expect(result).toMatchObject({ ok: false, reason: 'task-archived' })
    expect((await git(repo, 'rev-parse', 'main')).stdout.trim()).toBe(mainBefore)
    // 分支也不该被提交上去。
    expect((await git(repo, 'log', '--oneline', branch)).stdout.trim().split('\n')).toHaveLength(1)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')
  })
})

describe('discard', () => {
  it('删掉分支与 worktree，卡片回想法池', async () => {
    const { branch, worktreePath } = await reviewable()
    expect(await review.discard(asTaskId('t1'))).toMatchObject({ ok: true })

    expect((await git(repo, 'branch', '--list', branch)).stdout.trim()).toBe('')
    await expect(readFile(join(worktreePath, 'slugify.js'), 'utf8')).rejects.toThrow()
    // 没有"记为失败"这个终点了：要么进 Done，要么回想法池重新想需求。
    expect(store.getTask(asTaskId('t1'))?.column).toBe('backlog')
  })
})

describe('purge', () => {
  it('把卡留下的 worktree 与分支一并收拾掉', async () => {
    const { branch, worktreePath } = await reviewable()
    const card = store.getTask(asTaskId('t1'))
    if (card === null) throw new Error('setup')

    // 删卡的顺序是"先落库、再收拾场地"，所以 purge 拿到的是值而不是 id。
    await review.purge(card, store.listRuns(asTaskId('t1')))

    expect((await git(repo, 'branch', '--list', branch)).stdout.trim()).toBe('')
    await expect(readFile(join(worktreePath, 'slugify.js'), 'utf8')).rejects.toThrow()
  })

  it('没留下工作区也不抛 —— 卡都删了，收拾场地失败不该让这次删除变成一半成功', async () => {
    const card = task({ id: 't9', column: 'backlog' })
    store.createTask(card)
    await expect(review.purge(card, [])).resolves.toBeUndefined()
  })
})

describe('CAS 与不可逆操作的顺序（回归）', () => {
  it('accept 的 CAS 冲突时 worktree 还在，重试能成功', async () => {
    const { worktreePath } = await reviewable()

    // 模拟"提交期间别人改了这张卡"：先让存储里的 revision 前进一格。
    const stale = store.getTask(asTaskId('t1'))
    if (stale === null) throw new Error('unreachable')
    store.commitTask({ ...stale, revision: stale.revision + 1, subject: '被人改过' })

    // review 读的是更新前的快照 → CAS 必然失败。
    const conflicting = new Review({
      storage: {
        ...store,
        getTask: () => stale,
        listRuns: store.listRuns.bind(store),
        commitTask: store.commitTask.bind(store),
      } as unknown as Storage,
      worktreeRoot: join(sandbox, 'worktrees'),
      now: () => T0 + 5000,
    })
    const first = await conflicting.accept(asTaskId('t1'))
    expect(first).toMatchObject({ ok: false, reason: 'revision-conflict' })

    // 关键：worktree 没被删掉，所以重试是可行的而不是 500。
    await expect(readFile(join(worktreePath, 'slugify.js'), 'utf8')).resolves.toContain('slugify')
    expect(store.getTask(asTaskId('t1'))?.column).toBe('review')

    const retry = await review.accept(asTaskId('t1'))
    expect(retry.ok).toBe(true)
    expect(store.getTask(asTaskId('t1'))?.column).toBe('done')
  })

  it('accept 成功后才删 worktree，分支与提交都留着', async () => {
    const { worktreePath, branch } = await reviewable()
    const result = await review.accept(asTaskId('t1'))
    expect(result.ok).toBe(true)

    await expect(readFile(join(worktreePath, 'slugify.js'), 'utf8')).rejects.toThrow()
    expect((await git(repo, 'branch', '--list', branch)).stdout.trim()).not.toBe('')
    expect((await git(repo, 'log', '--oneline', branch)).stdout).toContain('slugify')
  })
})
