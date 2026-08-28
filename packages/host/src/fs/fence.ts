/**
 * 围栏：把一条请求里来的路径，限制在给定的一组根里面。
 *
 * 为什么要有它：localhost + token 已经挡住了外人，但挡不住我们自己写错的路径
 * 拼接。一个 `..` 的疏漏在「只列目录名」时是噪音，在「读任意文件正文」或
 * 「在任意目录跑命令」时就是把整台机器摊开。围栏让这类 bug 的最坏后果止步于
 * 用户自己的仓库。
 *
 * 围栏画在**真实路径**上（`realpath`）：不然一条指向 `/etc` 的符号链接就能把
 * 请求带出去，而字符串前缀比较看不出来。
 *
 * 这里只管「在不在里面」。根是哪些、越界之后回什么话，都是上层的策略 ——
 * 预览按「这张卡够得着的 worktree 与仓库」，浏览按「已登记项目的仓库」，
 * 那个差别是真的，不该在这一层抹平。
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
 * @param roots - 允许的根。
 * @param asked - 请求里给的绝对路径。
 * @returns 解析后的路径；不是绝对路径、或不在任何根里面时返回 null。
 *   路径存不存在**不在这里判** —— 那由随后的 `stat` 说了算，两种失败对
 *   调用方是不同的话。
 */
export async function confine(roots: readonly string[], asked: string): Promise<string | null> {
  if (!isAbsolute(asked)) return null
  const target = await realResolve(resolve(asked))
  for (const root of roots) {
    // 根自己也可能挂在符号链接下（macOS 的 /tmp 就是），两边都要取真实路径。
    const real = await realpath(root).catch(() => null)
    if (real !== null && contains(real, target)) return target
  }
  return null
}

/**
 * 围栏没放行时，到底是哪一种。
 *
 * `root-missing` 说的是根自己不见了，不是请求越了界 —— 上层要把这两句话分开
 * 说，措辞见 {@link refusalFor}。
 */
export type Refusal = 'outside' | 'root-missing'

/**
 * 围栏拒绝的原因。
 *
 * 「路径在围栏外」和「根整个不见了」对用户是两件完全不同的事：后者说成前者，
 * 等于告诉他「你逛的不是你自己的项目」，而他逛的恰恰就是那个项目登记的路径 ——
 * 只是目录被移走或删掉了。这句话会把人往完全错误的方向带。
 *
 * 只在拒绝之后才调用，happy path 不为它多做一次 IO。
 *
 * @param roots - 允许的根，与 {@link confine} 拿到的是同一份。
 * @param asked - 被拒的那个路径。
 */
export async function refusalFor(roots: readonly string[], asked: string): Promise<Refusal> {
  if (!isAbsolute(asked)) return 'outside'
  const target = resolve(asked)
  for (const root of roots) {
    // 字面上属于这个根，却 realpath 不出来 —— 那就是根自己没了。
    if (!contains(resolve(root), target)) continue
    if (await realpath(root).then(() => false, () => true)) return 'root-missing'
  }
  return 'outside'
}
