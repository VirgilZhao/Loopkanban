/**
 * 项目里的文件浏览：工作区清单、目录内容、单个文件的正文。
 *
 * 与 `browse.ts` 的分工：那个只列**目录名**，服务于「新增项目时挑一个文件夹」，
 * 所以它可以从家目录起步、逛遍整台机器。这个要列文件、还要把正文吐回浏览器，
 * 强得多，因此反过来 —— **只在已登记的项目仓库里逛**。
 *
 * 为什么要这层围栏：localhost + token 已经挡住了外人，但挡不住自己写错的
 * 路径拼接。一个 `..` 的疏漏在「只列目录名」时是噪音，在「读任意文件正文」
 * 时就是把整台机器的内容摊开。围栏让这种 bug 的最坏后果止步于用户自己的仓库。
 *
 * 围栏画在**真实路径**上（`realpath`）：不然一条指向 `/etc` 的符号链接就能
 * 把请求带出去，而字符串前缀比较看不出来。
 */

import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { WORKTREE_HOME, currentBranch, listWorktrees } from '../worktree/index.ts'

/**
 * 单个文件最多回多少正文。
 *
 * 这是个看代码的窗口，不是下载通道：几 MB 的日志塞进 JSON 再交给浏览器渲染，
 * 只会把标签页顶住。超过就截断并如实说明。
 */
export const MAX_FILE_BYTES = 512 * 1024

/** 判定二进制时看头部多少字节。文本文件的 NUL 几乎总在开头就能撞见。 */
const SNIFF_BYTES = 8 * 1024

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
  /** 超过 {@link MAX_FILE_BYTES} 时只回前一段。 */
  readonly truncated: boolean
  /** 二进制文件不回正文 —— 把它当 UTF-8 解出来只会是一屏乱码。 */
  readonly binary: boolean
  readonly content: string
}

/**
 * 目标是否落在根里面（含根本身）。
 *
 * 用 `relative` 而不是 `startsWith`：字符串前缀会把 `/repo-old` 当成 `/repo`
 * 的子目录。
 */
export function contains(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 尽最大努力解出真实路径。
 *
 * 路径不存在时 `realpath` 直接失败，可界面上的清单总是慢一拍 —— 文件刚被
 * 删掉、目录刚被改名都会走到这里，而那该是一句「打不开」而不是「越界了」。
 * 于是退到**最近一个存在的祖先**上解析：那一截已经吃掉了路径里所有符号链接，
 * 剩下的部分是纯字面量，接回去不会把请求带到别处。
 */
async function realResolve(target: string): Promise<string> {
  const rest: string[] = []
  let here = target
  for (;;) {
    const real = await realpath(here).catch(() => null)
    if (real !== null) return rest.length === 0 ? real : join(real, ...rest.reverse())
    const up = dirname(here)
    // 一路走到文件系统根都解不出来（几乎不可能），原样返回，交给 containment 判。
    if (up === here) return target
    rest.push(basename(here))
    here = up
  }
}

/**
 * 把请求里的路径校验进围栏。
 *
 * 先 `resolve` 做字面归一（吃掉 `..`），再解真实路径 —— 顺序不能反：真正会
 * 被 `stat` / `readdir` 打开的正是归一之后的那个路径，所以判定必须针对它。
 *
 * @param roots - 允许的根，通常是所有已登记项目的仓库路径。
 * @param asked - 请求里给的绝对路径。
 * @returns 解析后的路径；不是绝对路径、或不在任何根里面时返回 null。
 *   路径存不存在**不在这里判** —— 那由随后的 `stat` 说了算，两种失败对
 *   调用方是不同的话。
 */
export async function confine(roots: readonly string[], asked: string): Promise<string | null> {
  if (!isAbsolute(asked)) return null
  const target = await realResolve(resolve(asked))
  for (const root of roots) {
    // 仓库自己也可能挂在符号链接下（macOS 的 /tmp 就是），两边都要取真实路径。
    const real = await realpath(root).catch(() => null)
    if (real !== null && contains(real, target)) return target
  }
  return null
}

/** 围栏没放行时，到底是哪一种。 */
export type Refusal = 'outside-project' | 'repo-missing'

/**
 * 围栏拒绝的原因。
 *
 * 「路径在围栏外」和「仓库整个不见了」对用户是两件完全不同的事：后者说成前者，
 * 等于告诉他「你逛的不是你自己的项目」，而他逛的恰恰就是那个项目登记的路径 ——
 * 只是目录被移走或删掉了。这句话会把人往完全错误的方向带。
 *
 * 只在拒绝之后才调用，happy path 不为它多做一次 IO。
 *
 * @param roots - 允许的根，与 {@link confine} 拿到的是同一份。
 * @param asked - 被拒的那个路径。
 */
export async function refusalFor(roots: readonly string[], asked: string): Promise<Refusal> {
  if (!isAbsolute(asked)) return 'outside-project'
  const target = resolve(asked)
  for (const root of roots) {
    // 字面上属于这个仓库，却 realpath 不出来 —— 那就是仓库自己没了。
    if (!contains(resolve(root), target)) continue
    if (await realpath(root).then(() => false, () => true)) return 'repo-missing'
  }
  return 'outside-project'
}

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
 * @param root - 工作区根，已经过 {@link confine} 校验。
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
 * 只读前 {@link MAX_FILE_BYTES} 字节，且**先判二进制再解码**：把 PNG 按
 * UTF-8 解出来是一屏替换字符，既没用又很慢。
 *
 * @param root - 工作区根，用来算相对路径。
 * @param path - 文件绝对路径，已经过 {@link confine} 校验。
 */
export async function readFileText(root: string, path: string): Promise<FileContent> {
  const here = resolve(path)
  const info = await stat(here)
  if (!info.isFile()) throw new Error(`${here} 不是文件`)

  const handle = await open(here, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, Math.min(bytesRead, SNIFF_BYTES))
    const binary = head.includes(0)
    return {
      path: here,
      relative: relative(root, here),
      size: info.size,
      truncated: info.size > MAX_FILE_BYTES,
      binary,
      content: binary ? '' : buffer.subarray(0, bytesRead).toString('utf8'),
    }
  } finally {
    await handle.close()
  }
}
