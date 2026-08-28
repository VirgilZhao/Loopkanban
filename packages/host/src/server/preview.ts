/**
 * 预览工作区里的一个文件。
 *
 * 为什么要有它：Agent 干完一轮常常在讨论里留一句
 * `[方案.md](/…/.loopkanban/worktrees/t-x/docs/plans/方案.md)` —— 那条路径指
 * 向的是**它自己的 worktree**，浏览器打不开（`file://` 链接在页面里是死的），
 * 人得另开一个终端 `cat` 一遍才知道它到底写了什么。它写的东西看不见，讨论
 * 就没法接着往下走。
 *
 * 边界写死在这里，不留给调用方：只读、只在这张卡够得着的目录里、只给文本、
 * 且有大小上限。比这个 API 已经能做的事（在本机起 Agent 改代码）严格地更弱。
 */

import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

/** 预览上限。再大就不该在浏览器里翻了 —— 产物就在本机磁盘上。 */
export const PREVIEW_MAX_BYTES = 400_000

export interface FilePreview {
  /**
   * 这份文档的绝对路径，**用登记的根表述**（不是解完符号链接的那条）。
   *
   * 调用方会拿它接文档里的相对链接再问一次，而边界是按登记的根判的。
   * 给出 realpath 就等于给了一条自己都认不出来的路径 —— 根里只要有一层
   * 软链（macOS 上 `/tmp → /private/tmp` 就是），下一跳必然被判成越界。
   */
  readonly path: string
  readonly name: string
  /** 相对它所属根目录的路径，界面上显示这个 —— 绝对路径太长，读不出重点。 */
  readonly relative: string
  /** 文件真实大小（字节），不是 `content` 的长度。 */
  readonly size: number
  /** 是否因为过大而只给了前一段。 */
  readonly truncated: boolean
  readonly content: string
}

export type PreviewFailure =
  /** 路径不在这张卡够得着的目录里。 */
  | 'path-outside-workspace'
  | 'no-such-file'
  /** 二进制。文本预览器展示它只会是一屏乱码。 */
  | 'not-text'
  /** 在工作区里、也确实是个文件，但打不开（多半是权限）。 */
  | 'unreadable'

export type PreviewResult =
  | { readonly ok: true; readonly file: FilePreview }
  | { readonly ok: false; readonly reason: PreviewFailure; readonly detail: string }

/** target 是否落在 root 里面。root 自身不算 —— 要预览的是文件，不是目录。 */
function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 截断处可能砍在一个多字节字符中间；把尾巴上不完整的那几字节去掉。
 *
 * 不做的话中文文档每次截断都会以一个 `�` 收尾 —— 小事，但看着像文件坏了。
 */
function trimPartialUtf8(buffer: Buffer): Buffer {
  // UTF-8 一个字符最长 4 字节，所以最多往回找 3 个续字节就能碰到起始字节。
  for (let back = 0; back < 4 && back < buffer.length; back += 1) {
    const at = buffer.length - 1 - back
    const byte = buffer[at] ?? 0
    if ((byte & 0xc0) === 0x80) continue
    const need = byte < 0x80 ? 1
      : (byte & 0xe0) === 0xc0 ? 2
      : (byte & 0xf0) === 0xe0 ? 3
      : (byte & 0xf8) === 0xf0 ? 4
      : 1
    return need === back + 1 ? buffer : buffer.subarray(0, at)
  }
  return buffer
}

/**
 * 把用户点的那条路径翻成一串「值得一试」的绝对路径，逐个落在某个根里面。
 *
 * 两种输入都要接：讨论里的链接多半是绝对路径（Agent 写的是它自己的
 * worktree），人手打的则常是相对路径。
 */
function candidates(asked: string, roots: readonly string[]): { root: string; path: string }[] {
  const out: { root: string; path: string }[] = []
  const add = (root: string, path: string): void => {
    if (within(root, path) && !out.some((c) => c.path === path)) out.push({ root, path })
  }

  if (isAbsolute(asked)) {
    const target = resolve(asked)
    for (const root of roots) add(root, target)
    // 验收通过之后 worktree 会被删掉，链接里那条绝对路径就落空了。把它相对
    // worktree 的那一段接到别的根上再试一次 —— 已经合进主仓库的同一份文档
    // 还看得见，而不是给一句「文件不存在」让人以为东西丢了。
    for (const root of roots) {
      if (!within(root, target)) continue
      const rel = relative(root, target)
      for (const other of roots) if (other !== root) add(other, resolve(other, rel))
    }
  } else {
    for (const root of roots) add(root, resolve(root, asked))
  }
  return out
}

/** 读文件开头的若干字节。句柄一定收掉，读不动就往上抛。 */
async function readHead(path: string, take: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(take)
    const { bytesRead } = await handle.read(buffer, 0, take, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * 读一个文件用于预览。
 *
 * @param asked - 要看的路径，绝对或相对于某个根。
 * @param roots - 这张卡够得着的目录：它历次执行的 worktree，以及项目仓库。
 */
export async function readFilePreview(asked: string, roots: readonly string[]): Promise<PreviewResult> {
  const raw = asked.trim()
  if (raw.length === 0) return { ok: false, reason: 'no-such-file', detail: '没给路径' }

  const tried = candidates(raw, roots.map((root) => resolve(root)))
  // 一个都落不进来，说明这条路径根本不属于这张卡 —— 与「文件不在」是两回事。
  if (tried.length === 0) return { ok: false, reason: 'path-outside-workspace', detail: raw }

  for (const { root, path } of tried) {
    // 解完符号链接再判一次：`docs → /etc` 这种链接，只看字面路径是查不出来的。
    const real = await realpath(path).catch(() => null)
    const realRoot = await realpath(root).catch(() => null)
    if (real === null || realRoot === null || !within(realRoot, real)) continue

    const info = await stat(real).catch(() => null)
    if (info === null || !info.isFile()) continue

    const take = Math.min(info.size, PREVIEW_MAX_BYTES)
    // stat 过得去、open 过不去 —— 权限。这跟「文件不在」不是一回事，也不该
    // 一路抛到最外层：那只会给调用方一个 500，日志里多一条未处理异常。
    const head = await readHead(real, take).catch(() => null)
    if (head === null) return { ok: false, reason: 'unreadable', detail: path }

    // NUL 是判二进制最省事也最准的一条：文本文件里不会有它。
    if (head.includes(0)) return { ok: false, reason: 'not-text', detail: path }

    const truncated = info.size > take
    return {
      ok: true,
      file: {
        // 一律用候选路径表述，realpath 只用来判边界，不外传（见 FilePreview.path）。
        path,
        name: basename(path),
        relative: relative(root, path),
        size: info.size,
        truncated,
        content: (truncated ? trimPartialUtf8(head) : head).toString('utf8'),
      },
    }
  }

  return { ok: false, reason: 'no-such-file', detail: raw }
}
