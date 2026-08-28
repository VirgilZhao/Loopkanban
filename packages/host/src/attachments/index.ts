/**
 * 附件：卡片带着的图片、PDF、Word 文档这些东西。
 *
 * 分两处存：**元数据进库、字节进磁盘**。把几十 MB 的 PDF 塞进 SQLite 会让
 * 每一次 `listTasks` 都拖着它走，而 Agent 要的本来就是一个能 `open` 的文件
 * 路径 —— 存成文件，交给 CLI 时直接拷进 worktree 即可，不必先落一次盘。
 *
 * 目录形状：`<root>/<taskId>/<attachmentId>-<安全文件名>`。带上 id 是因为
 * 同一张卡完全可能传两个都叫 `截图.png` 的文件，而人不该为了传第二个先去
 * 改名字。
 */

import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

/**
 * 单个附件的大小上限。
 *
 * 25 MB 装得下扫描版 PDF 与截图，又不至于让一次误拖整个视频目录把磁盘写满。
 * 上传是整块读进内存再落盘的（本地工具，没必要为流式多写一套），所以这个
 * 数字同时也是单次请求的内存峰值。
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** 一张卡最多挂多少个附件。挡的是"把整个文件夹拖进来"这类手滑。 */
export const MAX_ATTACHMENTS_PER_TASK = 20

/**
 * 附件在 worktree 里的落点，相对于 worktree 根目录。
 *
 * 放在 `.loopkanban/` 下面是**为了不进 diff**：`ensureWorktree` 已经把
 * `/.loopkanban/` 写进了仓库的 `.git/info/exclude`，而那条规则在每个
 * worktree 的根上同样生效。附件是输入不是产出，混进 patch 里只会让人在
 * 一堆 base64 噪音中找真正的改动，验收通过时也会被一并提交进仓库。
 */
export const ATTACHMENTS_IN_WORKTREE = join('.loopkanban', 'attachments')

/**
 * 认得出的类型。**决定的是「浏览器拿到它时按什么渲染」**，所以是一份
 * 允许清单而不是猜测：客户端报的 content-type 不可信，扩展名才是我们
 * 自己能核对的东西。不在清单里的一律 `application/octet-stream` 下载，
 * 绝不让一个 `.html` 附件在本地源上跑起来。
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
}

/**
 * 可以直接在浏览器里预览的类型。
 *
 * 只有图片和 PDF —— 它们不会执行脚本。`text/html`、`image/svg+xml` 这些
 * **刻意不在**：附件和看板同源，一个内联渲染的 HTML 附件就能拿着 cookie
 * 调本机的执行接口。要看内容就下载下来看。
 */
const INLINE = new Set(['application/pdf'])

/** 这个类型能不能内联展示（`Content-Disposition: inline`）。 */
export function canInline(mime: string): boolean {
  return mime.startsWith('image/') || INLINE.has(mime)
}

/**
 * 按扩展名定类型。
 *
 * 客户端报的 content-type 只在扩展名认不出来时作参考，而且仅限它本来就
 * 是个图片：浏览器对 `.docx` 之流常常报 `application/octet-stream`，
 * 而对随手改了扩展名的文件又会报得过于自信。
 *
 * @param filename - 原始文件名。
 * @param declared - 客户端声明的 content-type。
 */
export function mimeOf(filename: string, declared?: string): string {
  const known = MIME_BY_EXT[extname(filename).toLowerCase()]
  if (known !== undefined) return known
  const clean = declared?.split(';')[0]?.trim().toLowerCase() ?? ''
  // 扩展名认不出来时只肯认图片：它是唯一一类我们会内联渲染的东西，
  // 而渲染一个不是图片的"图片"最多是显示不出来，不会执行任何东西。
  if (clean.startsWith('image/') && !clean.includes('svg')) return clean
  return 'application/octet-stream'
}

/**
 * 把用户给的文件名压成一个能安全落盘的名字。
 *
 * 目录穿越（`../`）、路径分隔符、控制字符、Windows 的保留字符全部出局；
 * 中文与空格保留 —— 那是人认得出这个文件的依据，换成一串 hash 等于让
 * 附件列表变成密码本。
 *
 * @param name - 原始文件名。
 * @returns 安全的文件名；一个可用字符都不剩时退回 `file`。
 */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    // 控制字符（含换行）与 Windows 的保留字符。前者能把日志和响应头拆成
    // 两行，后者在 Windows 上根本落不了盘。
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    // **先 trim 再剥点**：顺序反过来的话 `" .."` 会带着前导空格躲过剥点、
    // trim 之后原样变回 `..` —— 而 stageAttachments 拿这个返回值直接当路径
    // 末段用，`join(dir, '..')` 就指到上一级去了。
    .trim()
    // 开头的点会造出隐藏文件，`..` 更是目录穿越的入口。
    .replace(/^\.+/, '')
    // 剥完点可能又露出空格（`" . a.txt"`），再收一次尾。
    .trim()
  if (cleaned.length === 0) return 'file'
  // 文件名有长度上限（多数文件系统 255 字节），中文一个字三字节，压到 120
  // 字符足够安全，也仍然读得出是什么。扩展名要留住 —— 类型判定靠它。
  if (cleaned.length <= 120) return cleaned
  const ext = extname(cleaned).slice(0, 16)
  return cleaned.slice(0, 120 - ext.length) + ext
}

/** 落盘之后的附件字节。元数据由 storage 记，这里只管文件本身。 */
export interface StoredFile {
  readonly path: string
  readonly size: number
}

/**
 * 附件的磁盘侧。
 *
 * 与 storage 分开是因为两者的失败方式完全不同：库写不进去要回滚事务，
 * 文件写不进去（磁盘满、权限）只需要报错让人重传。硬凑在一起会让
 * "库里有记录、磁盘上没文件"这种半截状态更容易出现，而不是更少。
 */
export class AttachmentStore {
  private readonly root: string

  /**
   * @param root - 附件根目录，通常是数据目录下的 `attachments/`。
   */
  constructor(root: string) {
    this.root = resolve(root)
  }

  /** 某张卡的附件目录。 */
  private dirOf(taskId: string): string {
    return join(this.root, safeFilename(taskId))
  }

  /**
   * 落一个附件的字节。
   * @param taskId - 所属任务。
   * @param attachmentId - 附件 id，用作文件名前缀，避免同名互相覆盖。
   * @param filename - 已经过 `safeFilename` 的文件名。
   * @param bytes - 文件内容。
   */
  async save(taskId: string, attachmentId: string, filename: string, bytes: Buffer): Promise<StoredFile> {
    const dir = this.dirOf(taskId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${attachmentId}-${filename}`)
    await writeFile(path, bytes)
    return { path, size: bytes.length }
  }

  /**
   * 删掉一个附件的字节。
   *
   * **只删 root 之下的东西**：库里的 path 理论上不会指向别处，但删除是
   * 不可逆的，多一道边界检查换来的是"库被人改坏也不会删到用户的文件"。
   */
  async remove(path: string): Promise<void> {
    if (!this.inside(path)) return
    await rm(path, { force: true }).catch(() => undefined)
  }

  /** 删掉一张卡的整个附件目录。删卡、删项目时用。 */
  async removeTask(taskId: string): Promise<void> {
    await rm(this.dirOf(taskId), { recursive: true, force: true }).catch(() => undefined)
  }

  private inside(path: string): boolean {
    const target = resolve(path)
    return target === this.root || target.startsWith(this.root + '/') || target.startsWith(this.root + '\\')
  }
}

/** 交给 Agent 时，一个附件在 worktree 里的样子。 */
export interface StagedAttachment {
  readonly filename: string
  readonly mime: string
  readonly size: number
  /** 相对于 worktree 根目录的路径，用正斜杠 —— 它要写进 TASK.md 给人和 Agent 看。 */
  readonly relPath: string
}

/** 需要拷进 worktree 的一个附件。 */
export interface StageInput {
  readonly filename: string
  readonly mime: string
  readonly path: string
}

/**
 * 把附件拷进 worktree，让 Agent 能直接读到它们。
 *
 * **每次执行前先清空再拷**：worktree 属于任务而不是某次执行，删掉的附件
 * 若留在那儿，Agent 下一轮还会照着一个人已经撤回的文件干活。
 *
 * 同名文件加数字后缀而不是相互覆盖 —— 两个都叫 `设计稿.png` 的附件在
 * 界面上是两条，到了 worktree 里只剩一个的话，TASK.md 里的清单就在说谎。
 *
 * @param worktreePath - 目标 worktree 根目录。
 * @param inputs - 要拷过去的附件。
 * @returns 拷过去之后各自的相对路径；拷不动的那些不在其中。
 */
export async function stageAttachments(
  worktreePath: string,
  inputs: readonly StageInput[],
): Promise<StagedAttachment[]> {
  const dir = join(worktreePath, ATTACHMENTS_IN_WORKTREE)
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  if (inputs.length === 0) return []
  await mkdir(dir, { recursive: true })

  const used = new Set<string>()
  const staged: StagedAttachment[] = []
  for (const input of inputs) {
    const name = uniqueName(safeFilename(input.filename), used)
    const target = join(dir, name)
    try {
      await copyFile(input.path, target)
      const info = await stat(target)
      staged.push({
        filename: input.filename,
        mime: input.mime,
        size: info.size,
        // 正斜杠是给人和 Agent 看的路径，Windows 上也认。
        relPath: `${ATTACHMENTS_IN_WORKTREE.split(/[/\\]/).join('/')}/${name}`,
      })
    } catch {
      // 单个附件拷不过去（文件被外力删了、磁盘满了）不该让整次执行起不来。
      // 它不出现在 TASK.md 的清单里，Agent 也就不会去找一个不存在的文件。
    }
  }
  return staged
}

/** worktree 里现有的附件文件名，测试与排查用。 */
export async function listStaged(worktreePath: string): Promise<string[]> {
  return readdir(join(worktreePath, ATTACHMENTS_IN_WORKTREE)).catch(() => [])
}

/** 同名时加 `-2`、`-3`，扩展名留在末尾。 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name }
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${String(n)}${ext}`
    if (!used.has(candidate)) { used.add(candidate); return candidate }
  }
}

/** 人看得懂的大小。TASK.md 里给 Agent 一个"这文件多大"的直觉。 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
