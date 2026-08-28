/**
 * 一个只读的 ZIP 取件器。
 *
 * 为什么要自己写：`.docx` / `.xlsx` / `.pptx` 都是 ZIP，而我们只想从里面取出
 * 一两个 XML 文件。Node 自带 `zlib.inflateRawSync`，缺的只是外面那层目录结构 ——
 * 为这点事引一个解压库，换来的是一个能读任意压缩输入的攻击面。
 *
 * 只实现真正会遇到的两种存法：不压缩（0）与 deflate（8）。加密、ZIP64、
 * 分卷一律拒绝，而不是"尽力而为"地读出半份垃圾。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** EOCD 之后最多还能跟 64KB 注释，往前找这么多就够。 */
const EOCD_SCAN = 0xffff + 22

export interface ZipEntry {
  readonly name: string
  /** 本地文件头在整个 buffer 里的偏移。 */
  readonly offset: number
  /** 0 = 原样存放，8 = deflate。别的都不认。 */
  readonly method: number
  readonly compressedSize: number
  readonly size: number
  /** 通用位标志第 0 位：内容加密。加密的条目我们不碰。 */
  readonly encrypted: boolean
}

/** 从尾部往前找中央目录结束记录。 */
function findEocd(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - EOCD_SCAN)
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIG) return at
  }
  return -1
}

/**
 * 读中央目录，列出里面有哪些条目。
 *
 * @param buffer - 整个 ZIP 的字节。
 * @returns 条目清单；不是一个 ZIP（或结构读不通）时为 null。
 */
export function readZipIndex(buffer: Buffer): ZipEntry[] | null {
  if (buffer.length < 22) return null
  const eocd = findEocd(buffer)
  if (eocd === -1) return null

  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  // ZIP64 会把这两个字段写成全 1 占位，真值在另一处记录里。我们不支持 ——
  // 一份 4GB 以上的 Word 文档不是预览该操心的东西。
  if (at === 0xffffffff || count === 0xffff) return null

  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIG) return null
    const nameLen = buffer.readUInt16LE(at + 28)
    const extraLen = buffer.readUInt16LE(at + 30)
    const commentLen = buffer.readUInt16LE(at + 32)
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    entries.push({
      name,
      offset: buffer.readUInt32LE(at + 42),
      method: buffer.readUInt16LE(at + 10),
      compressedSize: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      encrypted: (buffer.readUInt16LE(at + 8) & 0x1) !== 0,
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 取出一个条目的内容。
 *
 * 解压上限是**必须的**，不是保险：一份几十 KB 的 zip 能解出几个 GB（deflate
 * 对重复字节的压缩比高得离谱），没有上限就是把内存交给了输入文件。
 *
 * @param buffer - 整个 ZIP 的字节。
 * @param entry - 要取的条目，来自 {@link readZipIndex}。
 * @param maxBytes - 解压后允许的最大字节数。
 * @returns 解出来的字节；加密、压缩方式不认、超限或结构不对时为 null。
 */
export function extractZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer | null {
  if (entry.encrypted || entry.size > maxBytes) return null
  if (entry.method !== 0 && entry.method !== 8) return null

  const head = entry.offset
  if (head + 30 > buffer.length || buffer.readUInt32LE(head) !== LOCAL_SIG) return null
  // 本地头自己的名字/扩展字段长度可能与中央目录的不同（扩展字段常常不一样），
  // 数据起点必须按本地头算。
  const start = head + 30 + buffer.readUInt16LE(head + 26) + buffer.readUInt16LE(head + 28)
  const end = start + entry.compressedSize
  if (end > buffer.length) return null

  const raw = buffer.subarray(start, end)
  if (entry.method === 0) return Buffer.from(raw)
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes })
  } catch {
    // 坏数据，或者解出来超了上限。两种都是"这个条目取不出来"。
    return null
  }
}

/**
 * 按名字取一个条目的内容，一步到位。
 *
 * @param buffer - 整个 ZIP 的字节。
 * @param name - 条目名，ZIP 里一律用 `/` 分隔。
 * @param maxBytes - 解压后允许的最大字节数。
 */
export function readZipFile(buffer: Buffer, name: string, maxBytes: number): Buffer | null {
  const index = readZipIndex(buffer)
  const entry = index?.find((candidate) => candidate.name === name)
  return entry === undefined ? null : extractZipEntry(buffer, entry, maxBytes)
}
