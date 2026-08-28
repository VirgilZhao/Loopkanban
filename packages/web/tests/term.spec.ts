import { describe, expect, it } from 'vitest'
import { append, render } from '@/lib/term.ts'

const ESC = '\u001b'

describe('render', () => {
  it('原样的文本原样出去', () => {
    expect(render('hello\nworld\n')).toBe('hello\nworld\n')
  })

  it('丢掉颜色 —— 这不是终端模拟器，`[32m` 留在屏幕上只会被当成输出坏了', () => {
    expect(render(`${ESC}[32mok${ESC}[0m\n`)).toBe('ok\n')
    expect(render(`${ESC}[1;31;40mred${ESC}[m`)).toBe('red')
  })

  it('丢掉设置窗口标题这类 OSC', () => {
    expect(render(`${ESC}]0;npm run dev\u0007done`)).toBe('done')
  })

  /*
   * 这是 `npm install` / `git clone` 的进度条：同一行被 `\r` 反复重写。
   * 不处理的话，一次安装会在屏幕上留下几十行几乎一样的东西。
   */
  it('\\r 把后写的盖在同一行上，而不是接在后面', () => {
    expect(render('10%\r55%\r100%')).toBe('100%')
    expect(render('第一行\n10%\r99%\n第三行')).toBe('第一行\n99%\n第三行')
  })

  it('盖不满的那一截留着 —— 真实终端上剩下的正是没被盖住的旧字符', () => {
    expect(render('100%\r5%')).toBe('5%0%')
  })

  it('退格吃掉前一个字符，中文也只吃一个', () => {
    expect(render('abc\b\bx')).toBe('ax')
    expect(render('中文\b了')).toBe('中了')
  })

  it('清行之类的控制字符不该在屏幕上留痕', () => {
    expect(render(`装着${ESC}[2K\r好了`)).toBe('好了')
    expect(render('响铃')).toBe('响铃')
  })
})

describe('append', () => {
  it('接上去的结果和整段渲染一致', () => {
    const whole = '第一行\n10%\r99%'
    expect(append(append('', '第一行\n10%'), '\r99%')).toBe(render(whole))
  })

  it('只重算最后一行 —— 前面的行已经定型了', () => {
    // `\r` 的作用范围不跨行，所以这里的 `\r` 不该影响到第一行。
    expect(append('已经定型\n', '10%\r7%')).toBe('已经定型\n7%%')
  })

  it('被切在两块中间的转义序列，下一块到了照样认得出来', () => {
    // 服务端按 40ms 合帧，一个转义序列偶尔会横跨两帧。
    const first = append('', `绿${ESC}[3`)
    expect(append(first, '2m色')).toBe('绿色')
  })
})
