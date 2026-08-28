/**
 * 把终端控制字符渲染成屏幕上该有的样子。
 *
 * 这一头不是伪终端，可命令的输出里照样带着终端的那套控制字符：`npm install`
 * 的进度条靠 `\r` 反复重写同一行，彩色输出留下 `ESC[32m` 这类转义。原样塞进
 * `<pre>` 的结果是几十行首尾相接的进度条，中间夹着 `[32m` 的碎片 —— 用户会
 * 以为是输出坏了。
 *
 * 做的是**最小可信**的一套：
 *
 * - 颜色与其他 SGR **丢掉**，不渲染成 span。一个看日志的窗口不值得为此背上
 *   一个终端模拟器；何况输出走的是管道，多数工具本来就不上色。
 * - 光标移动只认 `\r`（回到行首，后写的盖住先写的）与 `\b`（退格）。不带 tty
 *   的输出里常见的就这两个，别的（光标定位、清屏）在这儿没有意义。
 *
 * 拆成独立模块是为了能被测试钉死：这段逻辑全是字符串，没有 IO、没有 React。
 */

/** OSC：`ESC ] … BEL` 或 `ESC ] … ESC \`。设置窗口标题之类，屏幕上不该留痕。 */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** CSI：`ESC [ … 终止符`。颜色、清行、光标定位都在这儿。 */
const CSI = /\u001b\[[0-?]*[ -\/]*[@-~]/g

/** 其余单字符转义。刻意**不含** `ESC [` —— 那是被切在两块中间的半个 CSI。 */
const ESCAPE = /\u001b[@-Z\\-_]/g

/** 剩下的控制字符。`\t` `\n` 留着，它们是内容的一部分。 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * 结尾处半个转义序列。
 *
 * 服务端按帧合并输出，一个 `ESC [ 3 2 m` 偶尔会被切在两帧中间。把这半截当
 * 普通控制字符抹掉的话，下一帧到达时剩下的 `2m` 就成了屏幕上的可见文本 ——
 * 留着它，{@link append} 重算最后一行时自然会把整条序列认出来。
 */
const PENDING = /\u001b(?:\[[0-?]*[ -\/]*)?$/

/** 退格：把前一个字符吃掉。 */
function backspace(text: string): string {
  if (!text.includes('\b')) return text
  let out = ''
  // 按码点迭代，别把一个中文字或 emoji 劈成两半。
  for (const ch of text) {
    if (ch === '\b') out = [...out].slice(0, -1).join('')
    else out += ch
  }
  return out
}

/** 渲染一行：`\r` 之后写的内容盖在同一行的开头，而不是接在后面。 */
function line(text: string): string {
  let out = ''
  for (const segment of text.split('\r')) {
    const written = backspace(segment)
    // 盖住前面等长的一段，更长的尾巴留着 —— 进度条从 100% 退到 5% 时，
    // 真实终端上剩下的正是那截没被盖住的旧字符。
    out = written + out.slice(written.length)
  }
  // 半截转义序列留到下一块，别让它变成屏幕上的可见文本。
  const at = PENDING.exec(out)?.index ?? out.length
  return out.slice(0, at).replace(CONTROL, '') + out.slice(at)
}

/** 渲染一整段输出。 */
export function render(raw: string): string {
  return raw
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESCAPE, '')
    .split('\n')
    .map(line)
    .join('\n')
}

/**
 * 把新到的一段输出接到已渲染的文本后面。
 *
 * 只重算**最后一行**：`\r` 的作用范围不跨行，所以前面的行已经定型了。一个
 * 跑了半小时的 `npm run dev` 攒下几十万字符，每来一小块就整段重渲染的话，
 * 页面会先卡住，而它本该是这个终端最常见的用法。
 *
 * @param existing - 已经渲染过的文本。
 * @param incoming - 刚到的原始输出。
 */
export function append(existing: string, incoming: string): string {
  const cut = existing.lastIndexOf('\n') + 1
  return existing.slice(0, cut) + render(existing.slice(cut) + incoming)
}
