/**
 * 预览工作区里的一个文件。
 *
 * 为什么要有它：Agent 干完一轮常常在讨论里留一句
 * `[方案.md](/…/.loopkanban/worktrees/t-x/docs/plans/方案.md)` —— 那条路径指
 * 向的是**它自己的 worktree**，浏览器打不开（`file://` 链接在页面里是死的），
 * 人得另开一个终端 `cat` 一遍才知道它到底写了什么。它写的东西看不见，讨论
 * 就没法接着往下走。
 *
 * 「安全地读出一个文件」那一层在 `../fs/`，与文件浏览页共用。这里只剩这个
 * 功能自己的策略，也正是与浏览页真正不同的地方：
 *
 * - **围栏范围**：这张卡历次执行的 worktree，加上项目仓库。浏览页画的是
 *   「已登记项目的仓库」—— 两者是不同的问题，不该合。
 * - **路径怎么猜**：讨论里的链接是绝对路径，人手打的是相对路径，worktree
 *   还可能已经被删掉，都要接得住（见 {@link candidates}）。
 * - **二进制是拒绝，不是标注**：这是个文档预览器，不是文件管理器。
 */

import { basename, isAbsolute, relative, resolve } from 'node:path'
import { confine, contains, readTextHead } from '../fs/index.ts'

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

/**
 * 把用户点的那条路径翻成一串「值得一试」的绝对路径，逐个落在某个根里面。
 *
 * 两种输入都要接：讨论里的链接多半是绝对路径（Agent 写的是它自己的
 * worktree），人手打的则常是相对路径。
 */
function candidates(asked: string, roots: readonly string[]): { root: string; path: string }[] {
  const out: { root: string; path: string }[] = []
  // 根自己不算候选 —— 要预览的是文件，不是目录。
  const add = (root: string, path: string): void => {
    if (path !== root && contains(root, path) && !out.some((c) => c.path === path)) {
      out.push({ root, path })
    }
  }

  if (isAbsolute(asked)) {
    const target = resolve(asked)
    for (const root of roots) add(root, target)
    // 验收通过之后 worktree 会被删掉，链接里那条绝对路径就落空了。把它相对
    // worktree 的那一段接到别的根上再试一次 —— 已经合进主仓库的同一份文档
    // 还看得见，而不是给一句「文件不存在」让人以为东西丢了。
    for (const root of roots) {
      if (target === root || !contains(root, target)) continue
      const rel = relative(root, target)
      for (const other of roots) if (other !== root) add(other, resolve(other, rel))
    }
  } else {
    for (const root of roots) add(root, resolve(root, asked))
  }
  return out
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
    // 放行之后仍然拿 path（而不是 confine 回的真实路径）去读，见 FilePreview.path。
    if (await confine([root], path) === null) continue

    const read = await readTextHead(path)
    if (!read.ok) {
      // 读不动就到此为止，不再试别的根：换个根也是同一个用户、同一份权限，
      // 接着试只会把一句准确的话（权限不够）磨成「文件不在」。
      if (read.reason === 'unreadable') return { ok: false, reason: 'unreadable', detail: path }
      continue
    }
    if (read.head.binary) return { ok: false, reason: 'not-text', detail: path }

    return {
      ok: true,
      file: {
        // 一律用候选路径表述，真实路径只用来判边界，不外传（见 FilePreview.path）。
        path,
        name: basename(path),
        relative: relative(root, path),
        size: read.head.size,
        truncated: read.head.truncated,
        content: read.head.content,
      },
    }
  }

  return { ok: false, reason: 'no-such-file', detail: raw }
}
