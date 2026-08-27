/**
 * git worktree 生命周期。
 *
 * 每个任务一个 worktree + 一个分支：多个 Agent 可以在同一仓库并行干活而互不
 * 打架，跑飞了直接丢弃分支即可，主工作区永远不受影响。
 *
 * 直接调 `git` CLI 而不是用库：worktree 是相对新的特性，CLI 的行为最权威。
 */

import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capture } from '../agents/discover.ts'

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

/**
 * 为一个任务创建隔离的 worktree 与分支。
 * @param repoPath - 主仓库路径。
 * @param rootDir - 存放所有 worktree 的根目录（放在仓库外，避免污染主工作区）。
 * @param taskId - 任务 id，用作目录名。
 * @param branch - 分支名。
 * @param baseBranch - 从哪个提交派生。
 */
export async function createWorktree(
  repoPath: string,
  rootDir: string,
  taskId: string,
  branch: string,
  baseBranch: string,
): Promise<Worktree> {
  await mkdir(rootDir, { recursive: true })
  const path = resolve(join(rootDir, taskId))
  await git(repoPath, ['worktree', 'add', '-b', branch, path, baseBranch])
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

/** worktree 相对基线分支的完整 diff（含未提交改动）。 */
export async function worktreeDiff(worktree: Worktree, baseBranch: string): Promise<string> {
  await git(worktree.path, ['add', '-A', '--intent-to-add'])
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
