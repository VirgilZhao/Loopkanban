/**
 * 一个文件该按什么方式预览。
 *
 * 判定**只看扩展名**，不看内容。听着草率，其实是有意的：这个值决定的是
 * 「浏览器拿到它时按什么渲染」，而那正是一份允许清单该管的事 —— 按魔数
 * 认出一个文件"其实是 HTML"，只会让它以我们没打算给的方式跑起来。
 *
 * 扩展名认不出来时不给结论（返回 null），交给调用方按内容判文本还是二进制 ——
 * 仓库里大量文件根本没有扩展名（`Makefile`、`LICENSE`、`.gitignore`）。
 */

import { extname } from 'node:path'

/**
 * 预览的呈现方式。
 *
 * - `text` 正文按代码/纯文本显示（高亮在前端做）
 * - `markdown` 正文可在渲染结果与原文之间切
 * - `pdf` 不走 JSON，前端拿 raw 口子交给浏览器自带的阅读器
 * - `docx` 服务端翻成文档树再给（见 `docx.ts`）
 * - `image` 同 pdf，走 raw 口子
 * - `binary` 看不了，如实说
 */
export type FileKind = 'text' | 'markdown' | 'pdf' | 'docx' | 'image' | 'binary'

const MARKDOWN = new Set(['.md', '.markdown', '.mdx'])

/** 浏览器自己认得、且不会执行脚本的图片格式。**svg 刻意不在**：它是能跑脚本的。 */
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'])

/**
 * 一眼就知道看不了的二进制。
 *
 * 单独列出来是为了不让它们走到"按内容判定"那一步 —— 那条路会把一份 `.doc`
 * 判成二进制（对的），但也可能把一份恰好没有 NUL 字节的压缩包判成文本，
 * 于是界面上是一屏乱码。
 */
const BINARY = new Set([
  '.doc', '.xls', '.ppt', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.pages',
  '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.wasm', '.node',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.svgz',
  '.db', '.sqlite', '.sqlite3', '.pack', '.idx', '.psd', '.sketch', '.heic', '.tiff',
])

/**
 * 按扩展名给出预览方式。
 *
 * @param name - 文件名或路径。
 * @returns 预览方式；扩展名认不出来时为 null，由调用方按内容定。
 */
export function kindByName(name: string): FileKind | null {
  const ext = extname(name).toLowerCase()
  if (ext === '') return null
  if (MARKDOWN.has(ext)) return 'markdown'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (IMAGES.has(ext)) return 'image'
  if (BINARY.has(ext)) return 'binary'
  return null
}

/** 这种预览方式要不要正文字节走 JSON。pdf / 图片走 raw 口子，不塞进 JSON。 */
export function needsText(kind: FileKind): boolean {
  return kind === 'text' || kind === 'markdown'
}
