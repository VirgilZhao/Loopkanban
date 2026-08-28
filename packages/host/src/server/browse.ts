/**
 * 本机目录浏览，只为「新增项目」时选一个文件夹。
 *
 * 为什么要服务端做这件事：浏览器的 `showDirectoryPicker()` 只给一个句柄，
 * 拿不到绝对路径，而服务端要的正是路径。原生文件对话框（osascript / zenity）
 * 会弹在**跑 host 的那台机器**上，SSH 端口转发的场景里用户根本看不见。
 * 所以选择框做在界面里，由这个接口喂数据。
 *
 * 只返回目录名，不读任何文件内容 —— 比起这个 API 已经能做的事（在本机起
 * Agent 改代码），列目录严格地更弱。它同样受 token 与回环地址的保护。
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isGitRepo } from '../worktree/index.ts'

export interface DirEntry {
  readonly name: string
  readonly path: string
  /** 是不是 git 仓库 —— 能直接选来当项目的就是它们。 */
  readonly isRepo: boolean
}

export interface Listing {
  readonly path: string
  /** 上一级；已经在根上时为 null。 */
  readonly parent: string | null
  readonly isRepo: boolean
  readonly entries: readonly DirEntry[]
}

/** 默认落脚点：用户的家目录。 */
export function defaultBrowseRoot(): string {
  return homedir()
}

/**
 * 列出一个目录下的子目录。
 *
 * 隐藏目录（`.` 开头）不列：一屏 `.cache` / `.npm` 会把真正要找的东西淹掉，
 * 而项目目录几乎不会以点开头 —— 真要选它，路径框里还能手打。
 *
 * @param path - 绝对路径。
 * @throws 路径不存在或不是目录时抛出。
 */
export async function browseDirectory(path: string): Promise<Listing> {
  const here = resolve(path)
  const info = await stat(here)
  if (!info.isDirectory()) throw new Error(`${here} 不是目录`)

  const found = await readdir(here, { withFileTypes: true })
  const dirs = found
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(here, entry.name))
    .sort((a, b) => a.localeCompare(b))

  const entries = await Promise.all(dirs.map(async (full) => ({
    name: full.slice(here.length).replace(/^[/\\]/, ''),
    path: full,
    // 读不动的目录（权限不够）当成不是仓库，别让整次列目录失败。
    isRepo: await isGitRepo(full).catch(() => false),
  })))

  const up = dirname(here)
  return {
    path: here,
    parent: up === here ? null : up,
    isRepo: await isGitRepo(here).catch(() => false),
    entries,
  }
}
