/**
 * 读一个文件的开头，用于在浏览器里看。
 *
 * 「安全地读一个文件」这件事上，两条路径（讨论里的文档预览、文件浏览页）需要
 * 的是同一套判断：读多少、是不是二进制、截断了要不要说、截在半个字上怎么办。
 * 不同的只是围栏画在哪 —— 那在 {@link ../fs/fence.ts} 和各自的调用方那里。
 *
 * 边界写死在这里，不留给调用方：只读、有上限、二进制不解码。
 */

import { open, stat } from 'node:fs/promises'
import { decodeUtf8 } from './utf8.ts'

/**
 * 单个文件最多回多少正文。
 *
 * 这是个看代码的窗口，不是下载通道：几 MB 的日志塞进 JSON 再交给浏览器渲染，
 * 只会把标签页顶住。超过就截断并如实说明。
 *
 * 一个数管两条路径。以前预览是 400 KB、浏览是 512 KB，差别没有任何理由 ——
 * 两边都是「在浏览器里翻一份文本」。
 */
export const MAX_TEXT_BYTES = 512 * 1024

export interface TextHead {
  /** 文件真实大小（字节），不是 `content` 的长度。 */
  readonly size: number
  /** 是否因为过大而只读了前一段。 */
  readonly truncated: boolean
  /** 二进制。此时 `content` 是空串 —— 把 PNG 按 UTF-8 解出来只会是一屏乱码。 */
  readonly binary: boolean
  readonly content: string
}

export type TextFailure =
  /** 不存在，或者根本不是个文件（目录、设备节点……）。 */
  | 'no-such-file'
  /** 确实在那儿、也确实是个文件，但打不开 —— 多半是权限。 */
  | 'unreadable'

export type TextResult =
  | { readonly ok: true; readonly head: TextHead }
  | { readonly ok: false; readonly reason: TextFailure }

/**
 * 读 `path` 开头的至多 `limit` 字节。
 *
 * **先判二进制再解码**：NUL 是判二进制最省事也最准的一条，文本文件里不会有它。
 * 整段都扫（而不是只嗅前几 KB）—— `Buffer.includes` 是 memchr，512 KB 的代价
 * 可以忽略，而只嗅开头会把「前 8 KB 是 ASCII 头、后面是二进制块」的文件当成
 * 文本放出去。
 *
 * 不抛异常：「文件不在」和「读不动」对调用方是两句不同的话，都得回得出来，
 * 而不是一路抛到最外层换一个 500 加一条未处理异常。
 */
export async function readTextHead(path: string, limit = MAX_TEXT_BYTES): Promise<TextResult> {
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isFile()) return { ok: false, reason: 'no-such-file' }

  const take = Math.min(info.size, limit)
  // stat 过得去、open 过不去 —— 权限。这跟「文件不在」不是一回事。
  const handle = await open(path, 'r').catch(() => null)
  if (handle === null) return { ok: false, reason: 'unreadable' }

  try {
    const buffer = Buffer.alloc(take)
    const { bytesRead } = await handle.read(buffer, 0, take, 0)
    const body = buffer.subarray(0, bytesRead)
    const binary = body.includes(0)
    const truncated = info.size > take
    return {
      ok: true,
      head: {
        size: info.size,
        truncated,
        binary,
        content: binary ? '' : decodeUtf8(body, truncated),
      },
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    await handle.close()
  }
}
