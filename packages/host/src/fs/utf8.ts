/**
 * 按字节截断文本之后的收尾。
 *
 * 单独一个文件，是因为它的调用方不止一类：读文件的人先拿到完整 Buffer 再切，
 * 排空管道的人是一块一块拼起来的、拼完才知道切在哪。两边要的都只是这一个纯
 * 函数，不该为它拖上 realpath 与围栏那一整套。
 */

/**
 * 去掉结尾那半个多字节字符。
 *
 * 不做的话，中文文档每次截断都会以一个 `�` 收尾 —— 单看是小事，但它出现在
 * 正文最后一个字上，读的人第一反应是「文件坏了」而不是「这里被截断了」。
 */
export function trimPartialUtf8(buffer: Buffer): Buffer {
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
 * 把一段字节解成文本。
 *
 * `truncated` 为真时才削尾。完整读下来的内容即便结尾就是不合法的 UTF-8，
 * 那也是文件本来的样子 —— 替它砍掉几个字节是另一种撒谎，而且看不出来。
 */
export function decodeUtf8(buffer: Buffer, truncated: boolean): string {
  return (truncated ? trimPartialUtf8(buffer) : buffer).toString('utf8')
}
