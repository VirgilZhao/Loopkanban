/**
 * 项目里的文件浏览：工作区清单、目录内容、单个文件的正文。
 *
 * 与 `browse.ts` 的分工：那个只列**目录名**，服务于「新增项目时挑一个文件夹」，
 * 所以它可以从家目录起步、逛遍整台机器。这个要列文件、还要把正文吐回浏览器，
 * 强得多，因此反过来 —— **只在已登记的项目仓库里逛**。
 *
 * 围栏与「安全地读出一个文件」都在 `../fs/`，与讨论里的文档预览共用。这里剩下
 * 的是浏览页自己的策略：围栏的根是**已登记项目的仓库**（预览画的是另一圈 ——
 * 那张卡历次执行的 worktree），以及二进制**如实标注而不是拒绝** —— 文件管理器
 * 该让人看见 `logo.png` 在那儿，而不是假装它不存在。
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { contains, readTextHead } from '../fs/index.ts'
import type { TextFailure } from '../fs/index.ts'
import { WORKTREE_HOME, currentBranch, listWorktrees } from '../worktree/index.ts'

/** 一个可浏览的工作区：项目主仓库，或某张卡派生出来的 worktree。 */
export interface Workspace {
  readonly path: string
  /** 当前分支；detached HEAD 或读不出来时为 null。 */
  readonly branch: string | null
  readonly kind: 'repo' | 'worktree'
  /** worktree 属于哪张卡。主仓库没有。 */
  readonly taskId?: string
}

export interface FileEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'dir' | 'file'
  /** 目录恒为 0 —— 算目录大小要递归整棵树，代价与用处不成比例。 */
  readonly size: number
  readonly modifiedAt: number
}

export interface FileListing {
  /** 这次浏览的根（工作区）。前端拿它回传，服务端据此重新校验围栏。 */
  readonly root: string
  readonly path: string
  /** 相对根的路径，根本身是空串。面包屑用它。 */
  readonly relative: string
  /** 上一级；已经在根上时为 null —— 根就是不能再往上的地方。 */
  readonly parent: string | null
  readonly entries: readonly FileEntry[]
}

export interface FileContent {
  readonly path: string
  readonly relative: string
  readonly size: number
  /** 超过 {@link MAX_TEXT_BYTES} 时只回前一段。 */
  readonly truncated: boolean
  /** 二进制文件不回正文 —— 把它当 UTF-8 解出来只会是一屏乱码。 */
  readonly binary: boolean
  readonly content: string
}

export type FileContentResult =
  | { readonly ok: true; readonly file: FileContent }
  | { readonly ok: false; readonly reason: TextFailure }

/**
 * 一个项目下所有能逛的工作区：主仓库，加上卡片留下的 worktree。
 *
 * worktree 才是 Agent 真正干活的地方 —— 只能看主仓库的话，「它到底改了什么」
 * 就只能靠 diff 猜。所以这两者一视同仁地列出来，由用户自己切。
 *
 * 读不出 worktree 清单（仓库被移走、git 不在）时只回主仓库：那也是实话，
 * 此刻确实只有这一个地方可以逛。
 */
export async function listWorkspaces(repoPath: string): Promise<Workspace[]> {
  // 一律取真实路径再比较：`git worktree list` 报的是解开符号链接之后的路径
  // （macOS 的 /tmp → /private/tmp 就是），拿它跟未解开的仓库路径比前缀，
  // 会把每一个 worktree 都判成「不在项目里」而悄悄漏掉。
  const root = await realpath(resolve(repoPath)).catch(() => resolve(repoPath))
  const home = join(root, WORKTREE_HOME, 'worktrees')
  const registered = await listWorktrees(root).catch(() => [] as string[])

  const derived = await Promise.all(
    (await Promise.all(registered.map(async (path) => realpath(path).catch(() => resolve(path)))))
      // 只认长在项目自己那棵 worktree 目录下的。用户手工建的 worktree 可能
      // 在机器上任何地方，把它们列进来等于在围栏上开洞。
      .filter((path) => path !== root && contains(home, path))
      .map(async (path) => ({
        path,
        branch: await currentBranch(path).catch(() => null),
        kind: 'worktree' as const,
        taskId: basename(path),
      })),
  )

  return [
    { path: root, branch: await currentBranch(root).catch(() => null), kind: 'repo' },
    ...derived.sort((a, b) => a.taskId.localeCompare(b.taskId)),
  ]
}

/**
 * 列一个目录：子目录在前，文件在后。
 *
 * 隐藏文件**照列**（和 `browse.ts` 相反）：`.gitignore`、`.github/`、`.env.example`
 * 正是看代码时要找的东西，藏起来只会逼人去开终端。唯独 `.git/` 不列 ——
 * 几百个对象文件对读代码毫无帮助，只会把真正的内容挤出屏幕。
 *
 * @param root - 工作区根，已经过 `confine` 校验。
 * @param path - 要列的目录，必须在根里面。
 */
export async function listFiles(root: string, path: string): Promise<FileListing> {
  const here = resolve(path)
  const info = await stat(here)
  if (!info.isDirectory()) throw new Error(`${here} 不是目录`)

  const found = await readdir(here, { withFileTypes: true })
  const entries = await Promise.all(
    found
      .filter((entry) => entry.name !== '.git')
      .map(async (entry) => {
        const full = join(here, entry.name)
        // 符号链接按它指向的东西归类；指到围栏外面时，点进去那一次会被
        // confine 拦下 —— 判定放在访问那一刻，而不是靠这里提前猜。
        const target = await stat(full).catch(() => null)
        return {
          name: entry.name,
          path: full,
          kind: (target?.isDirectory() ?? entry.isDirectory()) ? 'dir' as const : 'file' as const,
          size: target?.isFile() === true ? target.size : 0,
          modifiedAt: target?.mtimeMs ?? 0,
        }
      }),
  )

  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))

  const rel = relative(root, here)
  return {
    root,
    path: here,
    relative: rel,
    // 根就是不能再往上的地方 —— 围栏在界面上也要看得见。
    parent: rel === '' ? null : dirname(here),
    entries,
  }
}

/**
 * 读一个文件的正文。
 *
 * 读取本身在 `../fs/text.ts`（上限、二进制判定、截断收尾都在那儿）；这里只添
 * 界面要的那点上下文 —— 相对工作区根的路径。
 *
 * @param root - 工作区根，用来算相对路径。
 * @param path - 文件绝对路径，已经过 `confine` 校验。
 */
export async function readFileText(root: string, path: string): Promise<FileContentResult> {
  const here = resolve(path)
  const read = await readTextHead(here)
  if (!read.ok) return read
  return {
    ok: true,
    file: {
      path: here,
      relative: relative(root, here),
      size: read.head.size,
      truncated: read.head.truncated,
      binary: read.head.binary,
      content: read.head.content,
    },
  }
}
