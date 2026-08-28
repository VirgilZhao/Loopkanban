/** 取路径最后一段。前端只用来给项目名一个默认值，不做路径运算。 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * 把文档里的一条相对链接接到这份文档旁边。
 *
 * 文档里的 `./other.md` 是相对**它自己**说的，不是相对仓库根 —— 原样发给
 * 服务端会落到根目录上，找不到。`..` 这类留给服务端去规范化，它本来就要
 * 按根目录判一次边界。
 */
export function resolveFrom(file: string, href: string): string {
  if (href.startsWith('/')) return href
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut < 0 ? href : `${file.slice(0, cut)}/${href}`
}
