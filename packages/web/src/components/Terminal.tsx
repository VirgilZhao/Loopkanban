import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp, CircleStop, CornerDownLeft, Eraser, FolderInput, Plug,
  Terminal as TerminalIcon,
} from 'lucide-react'
import { api, ApiError, subscribeShell } from '@/api.ts'
import {
  commonPrefix, completable, literal, matching, splitPath, tokenAt, type Quote,
} from '@/lib/complete.ts'
import { maybe, useT } from '@/lib/i18n.tsx'
import { append as glue } from '@/lib/term.ts'
import { cn } from '@/lib/utils.ts'
import type { ShellEvent, ShellSession } from '@/types.ts'

/** 屏上最多留几条命令。再往上翻的价值抵不过把一页 DOM 撑到几万个节点。 */
const MAX_BLOCKS = 60

/**
 * 一条命令最多留多少字符的输出。
 *
 * `npm run dev` 会跑一下午，输出没有上限。留最近的一段就够了 —— 真要翻全部
 * 日志，那本来就该去看它自己的日志文件，而不是让浏览器扛着几十兆文本。
 */
const MAX_BLOCK_CHARS = 120_000

/**
 * 候选最多摆出来多少个。
 *
 * 再多就不是「看一眼挑一个」而是「找一遍」了 —— 那件事上面的文件列表做得
 * 比一条挤满名字的横条好。摆不下的会照实说还剩几个。
 */
const MAX_CANDIDATES = 120

/**
 * 修饰键自己也会发一个 keydown。
 *
 * 把它们当成「这一轮补全结束了」的话，Shift+Tab 里的那个 Shift 会先把候选
 * 收掉，等 Tab 到达时菜单已经没了 —— 于是往回轮换永远走不通，每次都变成
 * 重新补一次。
 */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'])

/**
 * 连着按 ctrl+c 时依次发的信号。
 *
 * 停在 SIGKILL 上：再按也没有更狠的了，而把这一列越拉越长只会让人以为
 * 还有别的办法。
 */
const ESCALATION = ['SIGINT', 'SIGTERM', 'SIGKILL'] as const

/** 记住会话的地方。按项目分，切走再回来还接得上同一个终端。 */
const REMEMBERED = 'loopkanban.shell.'

/**
 * 页面这一侧记着的会话。
 *
 * `floor` 是「已经清掉到第几号事件」。它必须跟着会话一起存下来，不能只放在
 * 组件里：组件被拆掉重建（换语言、切走再回来）之后重新订阅，服务端会从头
 * 回放，用户刚按下的"清空"就会自己长回来。
 */
interface Remembered {
  readonly id: string
  readonly floor: number
}

function recall(projectId: string): Remembered | null {
  try {
    const raw = sessionStorage.getItem(REMEMBERED + projectId)
    if (raw === null) return null
    const kept = JSON.parse(raw) as Partial<Remembered>
    if (typeof kept.id !== 'string') return null
    return { id: kept.id, floor: typeof kept.floor === 'number' ? kept.floor : 0 }
  } catch {
    // 隐私模式下 sessionStorage 会抛，坏掉的 JSON 也一样。当作没记过。
    return null
  }
}

function remember(projectId: string, kept: Remembered): void {
  try {
    sessionStorage.setItem(REMEMBERED + projectId, JSON.stringify(kept))
  } catch {
    // 存不下只是"下次接不上上一个会话"，不该让终端本身用不了。
  }
}

/** 一个补全候选。补全只关心名字，以及它是不是目录（目录后面要接斜杠）。 */
interface Candidate {
  readonly name: string
  readonly kind: 'dir' | 'file'
}

/**
 * 摊开的候选。
 *
 * 记着 `head` / `tail` 而不是每次重新分词：轮换候选时，输入框里那个词已经
 * 被上一次轮换改写过了，再分一次词就会把补进去的内容当成用户自己敲的，
 * 于是第二个 Tab 只能在第一个候选里打转。
 */
interface Menu {
  /** 被补的那个词左边的原文。 */
  readonly head: string
  /** 光标右边原样留着的部分。 */
  readonly tail: string
  /** 词里目录那一截（带结尾斜杠），拼回去时要带上。 */
  readonly dir: string
  readonly quote: Quote
  /** 摆出来的候选，最多 {@link MAX_CANDIDATES} 个。 */
  readonly items: readonly Candidate[]
  /** 匹配上的总数；比 `items` 多说明截断了。 */
  readonly total: number
  /** 选到第几个；-1 表示只是摆出来、还没选。 */
  readonly index: number
}

/**
 * 屏幕上的一段输出。
 *
 * `echo` 是我们自己回显的东西（用户敲给 stdin 的那一行、`^C`）—— 没有 tty
 * 就没有回显，不自己画出来的话，用户会觉得自己敲的字掉进了黑洞。
 */
interface Part {
  readonly stream: 'out' | 'err' | 'echo'
  readonly text: string
}

/** 一条命令的结局。 */
interface Outcome {
  readonly code: number | null
  readonly signal: string | null
  readonly interrupted: boolean
  readonly durationMs: number
  /** 命令根本没起来（目录没了这类）。它自己失败不算。 */
  readonly error?: string
}

/** 屏幕上的一段：一条命令，加上它到此为止的输出。 */
interface Block {
  readonly id: number
  readonly command: string
  /** 在哪儿跑的 —— 中途换过目录时，光看命令分不出它是在哪儿跑的。 */
  readonly where: string
  readonly parts: readonly Part[]
  /** 还在跑时为 null。 */
  readonly done: Outcome | null
}

interface Props {
  /** 哪个项目的终端。会话按项目记住，切走再回来还是同一个。 */
  projectId: string
  /** 工作区根。**只用来开会话**：开完之后 cd 去哪儿是会话自己的事。 */
  root: string
  /** 文件浏览器此刻停在哪个目录。只为那颗「跟过去」的按钮。 */
  browsing: string
  open: boolean
  onToggle: () => void
}

/**
 * 命令行。
 *
 * 为什么要有它：人正盯着某个 worktree 里的改动，想 `git log` 一下、想跑一次
 * 测试 —— 为此切出去开终端、再 cd 到那个七层深的 worktree 路径，是这个界面上
 * 最没道理的一段路。
 *
 * 它是个**真会话**，不是「一条命令一次请求」：
 *
 * - `cd` 留得住，目录**不跟着上面的文件浏览器走**。想去哪儿 `cd` 过去就是了，
 *   要回到正在浏览的目录，按标题栏那颗按钮。
 * - 输出边跑边出。`npm install` 要跑一分钟、`npm run dev` 根本不打算结束 ——
 *   等它退出再显示结果，等于把这两类命令整个排除在外。
 * - **ctrl+c 能打断**，而且收的是整棵进程树。命令跑着的时候敲字加回车，
 *   那一行会送进它的 stdin（`npm init` 的提问答得上来）。
 *
 * 一件它做不到的事说在明处：这**不是伪终端**。`vim`、`top` 这类要求终端的
 * 程序在这儿跑不起来。
 */
export function Terminal({ projectId, root, browsing, open, onToggle }: Props): React.JSX.Element {
  const t = useT()
  const [session, setSession] = useState<ShellSession | null>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  /** 正在跑的命令；空闲时为 null。输入框据此决定这一行是命令还是 stdin。 */
  const [running, setRunning] = useState<string | null>(null)
  const [cwd, setCwd] = useState<{ path: string; label: string } | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** 流断了（多半是会话被回收了）。这时候只剩一件事能做：重开。 */
  const [lost, setLost] = useState(false)
  /**
   * 重连按下了几次。
   *
   * 用它来重跑接会话那个 effect，而不是把 `lost` 放进依赖里：那样的话，
   * 一断线就会自动重连，而自动重连接不上时会一秒一轮地打服务端 —— 断开
   * 之后停在那儿等人按一下，是这里唯一说得清的行为。
   */
  const [attempt, setAttempt] = useState(0)
  // 敲过的命令，最近的在后面。翻历史时 cursor 指向其中一条。
  const [history, setHistory] = useState<string[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  // Tab 补出来的候选。null = 此刻没在补全。
  const [menu, setMenu] = useState<Menu | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)
  /**
   * 这条命令已经被按过几次 ctrl+c。
   *
   * 第二下的意思和第一下不一样：它是"你没理我"。没有作业控制的终端里，
   * 一个吞掉 SIGINT 的命令会把整个会话卡死，而用户手上没有别的办法 ——
   * 输入框已经归它了，跑不了 `kill`。所以逐级升到 SIGTERM、SIGKILL。
   */
  const insisted = useRef(0)
  /**
   * 已经画到第几号事件。
   *
   * 重新订阅时把它交给服务端，让它只补这之后的 —— 每次都从头回放的话，
   * 用户刚按下的"清空"会在下一次重订阅时自己长回来（切个语言就够了）。
   * 同一条事件被送来两遍时，它也是那道闸：宁可漏画一条，不能画两遍。
   */
  const seen = useRef(0)
  /** 上一次接的是哪个会话。换了一个，游标就得从头数。 */
  const attached = useRef<string | null>(null)
  /**
   * 已经清掉到第几号事件。
   *
   * 与 {@link seen} 的分工：`seen` 说的是"画过了"，重连时用它去重；`floor`
   * 说的是"用户不要了"。刷新页面时前者归零而后者留着 —— 于是重新挂上来
   * 能接回滚动历史，却不会把清掉的那一段也接回来。
   */
  const floor = useRef(0)

  /**
   * 会话只在**第一次展开**时才开。
   *
   * 收起来之后订阅照旧留着：断开订阅会让会话开始计闲，十分钟后连人带
   * `npm run dev` 一起被收掉 —— 而用户只是把面板折起来看了眼代码。
   */
  const [wanted, setWanted] = useState(open)
  useEffect(() => { if (open) setWanted(true) }, [open])

  /**
   * 开会话用哪个根。
   *
   * 放在 ref 里而不是依赖里：换工作区不该把终端重开一遍 —— 那正是「和文件
   * 浏览器解绑」的意思。它只在会话还没开的时候被读一次。
   */
  const rootRef = useRef(root)
  rootRef.current = root

  /**
   * 列过的目录，键是相对会话 cwd 的那一段。
   *
   * 补一次全要列一次目录，而 Tab 是连着按的 —— 每层都发一趟请求的话，补到
   * 第三层时输入框已经在等网络了。命令跑完就作废：`mkdir` 之后补不出刚建的
   * 目录，比慢一点更让人以为坏了。
   */
  const listings = useRef(new Map<string, Candidate[]>())
  /** 上一次补全还在飞的时候忽略新的 Tab —— 两次插入叠在一起是没法解释的。 */
  const completing = useRef(false)
  /**
   * 下一次渲染后把光标放到哪儿。
   *
   * 受控 input 被改写之后光标会掉到末尾，而补全经常发生在词中间
   * （`cat pack<光标>ages/x`），掉到末尾就等于把后面那截送给了下一次输入。
   */
  const caretTo = useRef<number | null>(null)
  /**
   * 新输出到了要不要贴底。
   *
   * 判据是**用户有没有往回翻**，而不是"此刻离底部多远"：一条命令会一口气
   * 吐出几十行，落地的瞬间离底部就已经很远了 —— 按距离判，第一条命令的输出
   * 就永远不会被跟上，屏幕停在开头一动不动。
   */
  const follow = useRef(true)

  useEffect(() => {
    const node = screenRef.current
    if (node === null || !follow.current) return
    node.scrollTop = node.scrollHeight
  }, [blocks, open])

  useEffect(() => {
    const at = caretTo.current
    if (at === null) return
    caretTo.current = null
    inputRef.current?.setSelectionRange(at, at)
  }, [input])

  /** 改写输入框，并把光标停在补进去的那一段之后。 */
  const put = useCallback((text: string, caret: number) => {
    setInput(text)
    caretTo.current = caret
  }, [])

  /**
   * 往最后一段里追加输出。
   *
   * 没有任何一段时（命令留下的后台进程还在往外吐，而屏幕刚被清过）就新开
   * 一段无名的 —— 把输出扔掉比留着更难解释。
   */
  const write = useCallback((stream: Part['stream'], text: string) => {
    if (text.length === 0) return
    setBlocks((prev) => {
      const last = prev.at(-1) ?? { id: nextId.current++, command: '', where: '', parts: [], done: null }
      const rest = prev.at(-1) === undefined ? prev : prev.slice(0, -1)
      const parts = [...last.parts]
      const tail = parts.at(-1)
      // 同一路的相邻输出并成一段：`\r` 的重写要看得见同一行的上文，
      // 而每来一小块就新开一段的话，进度条会碎成几十个独立的片段。
      if (tail !== undefined && tail.stream === stream) {
        parts[parts.length - 1] = { stream, text: glue(tail.text, text) }
      } else {
        parts.push({ stream, text: glue('', text) })
      }
      return [...rest, { ...last, parts: trim(parts) }]
    })
  }, [])

  /**
   * 事件流过来的一条。
   *
   * 刻意保持"无依赖"：它被交给了 EventSource，重建一次就要重连一次流，
   * 而重连意味着屏幕上出现一段空白。
   */
  const apply = useCallback((event: ShellEvent) => {
    // 快照没有序号（它不是历史里的一条），别拿它去动游标。
    if (event.kind !== 'state') {
      if (event.seq <= seen.current) return
      seen.current = event.seq
    }
    switch (event.kind) {
      case 'began': {
        insisted.current = 0
        setRunning(event.command)
        setCwd({ path: event.cwd, label: event.label })
        setBlocks((prev) => {
          const last = prev.at(-1)
          // 敲下回车的那一刻页面就已经把这一段画出来了（不等一趟往返）。
          // 这条 `began` 说的多半正是它 —— 认领它，而不是再画一段一模一样的。
          if (last !== undefined && last.done === null && last.command === event.command) {
            return [...prev.slice(0, -1), { ...last, where: event.label }]
          }
          return [
            ...prev,
            { id: nextId.current++, command: event.command, where: event.label, parts: [], done: null },
          ].slice(-MAX_BLOCKS)
        })
        return
      }
      case 'out':
      case 'err': {
        write(event.kind, event.text)
        return
      }
      case 'ended': {
        insisted.current = 0
        setRunning(null)
        setCwd({ path: event.cwd, label: event.label })
        // 这条命令可能刚 mkdir 出一个目录 —— 补不出刚建的东西比慢一点更难解释。
        listings.current.clear()
        setBlocks((prev) => {
          const last = prev.at(-1)
          if (last === undefined || last.done !== null) return prev
          return [...prev.slice(0, -1), {
            ...last,
            done: {
              code: event.code,
              signal: event.signal,
              interrupted: event.interrupted,
              durationMs: event.durationMs,
              ...(event.error === undefined ? {} : { error: event.error }),
            },
          }]
        })
        return
      }
      case 'closed': {
        // 会话整个没了（被回收、被关掉）。流到此为止，剩下能做的只有重开。
        setRunning(null)
        setLost(true)
        return
      }
      case 'state': {
        // 断线期间命令可能已经跑完了。以快照为准，别对着一条早就结束的命令
        // 一直显示"执行中"。
        setRunning(event.running)
        setCwd({ path: event.cwd, label: event.label })
        // 回放缓冲装不下全部历史，那条 `began` 也许早被挤掉了 —— 补一段，
        // 好让还在跑的命令有地方落输出。
        const command = event.running
        if (command !== null) {
          setBlocks((prev) => (prev.at(-1)?.done === null
            ? prev
            : [...prev, {
              id: nextId.current++, command, where: event.label, parts: [], done: null,
            }].slice(-MAX_BLOCKS)))
        }
        return
      }
    }
  }, [write])

  /** 开会话（或接上上次那个），并订阅它的输出。 */
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    let stop: (() => void) | null = null
    const attach = async (): Promise<void> => {
      const kept = recall(projectId)
      // 记着的那个可能已经被回收了（离开超过十分钟）。那不是故障，重开一个
      // 就是了 —— 为此弹一句错误只会让人以为出了事。
      const back = kept === null ? null : await api.shell(kept.id).then((found) => found.session, () => null)
      const found = back ?? (await api.openShell(rootRef.current)).session
      // 新会话从头数；接回旧的就把它清到哪儿一并接回来。
      floor.current = back === null ? 0 : kept?.floor ?? 0
      // 记在**判 cancelled 之前**：这一轮可能已经被取消了（React 严格模式
      // 下每次挂载都会先跑一遍再收回），而会话已经在服务端建出来了 ——
      // 不记下来，下一轮就会再建一个，头一个没人认领，白占一个名额。
      remember(projectId, { id: found.id, floor: floor.current })
      if (cancelled) return
      // 换了一个会话，序号从头开始数。
      if (attached.current !== found.id) { attached.current = found.id; seen.current = 0 }
      setSession(found)
      setLost(false)
      setError(null)
      // 从"画过的"与"清掉的"里靠后的那个接着要 —— 两件事都不该被重放。
      stop = subscribeShell(found.id, apply, () => { setLost(true) }, Math.max(seen.current, floor.current))
    }

    void attach().catch((failure: unknown) => {
      if (cancelled) return
      setError(failure instanceof ApiError
        ? maybe(t, `err.${failure.code}`, `${failure.code} · ${failure.message}`)
        : String(failure))
    })

    return () => {
      cancelled = true
      stop?.()
    }
  }, [wanted, projectId, apply, t, attempt])

  /**
   * 列一个目录，给补全用。
   *
   * 走的是会话自己的那条接口，所以列的是**会话当前目录**下的东西 ——
   * `cd` 出了工作区之后照样补得动。目录不存在时回 null：那是「没得补」，
   * 不是故障，不该在屏幕上留一行红字。
   */
  const listOf = useCallback(async (dir: string): Promise<Candidate[] | null> => {
    if (session === null) return null
    const cached = listings.current.get(dir)
    if (cached !== undefined) return cached
    const listing = await api.shellList(session.id, dir).catch(() => null)
    if (listing === null) return null
    const items = listing.entries.map((entry) => ({ name: entry.name, kind: entry.kind }))
    listings.current.set(dir, items)
    return items
  }, [session])

  /** 把第 `index` 个候选填进输入框。菜单留着 —— 下一个 Tab 接着往后轮。 */
  const take = useCallback((list: Menu, index: number) => {
    const item = list.items[index]
    if (item === undefined) return
    // 目录接一个斜杠而不是空格：多半还要继续往里走，下一个 Tab 就接着补。
    const text = literal(list.dir + item.name + (item.kind === 'dir' ? '/' : ''), list.quote)
    put(list.head + text + list.tail, list.head.length + text.length)
    setMenu({ ...list, index })
  }, [put])

  /**
   * Tab 补全。
   *
   * 三种结局，对应 shell 里那套人人都已经会了的手感：
   *
   * - **只有一个候选**：直接补完。目录接斜杠（还要往里走），文件接空格
   *   （下一个参数接着敲）。
   * - **多个候选**：先补到**无歧义**的那一段（最长公共前缀），再把分歧
   *   摆出来。只补公共前缀是关键 —— 直接塞第一个候选，等于替用户做了他
   *   还没做的选择。
   * - **一个都没有**：把「没有匹配」说出来。Tab 按下去什么都不动，最像的
   *   解释是这个功能坏了。
   *
   * 菜单已经开着时，这一按的意思是「换一个」：往后轮换候选，Shift 往前。
   */
  const complete = useCallback(async (step: 1 | -1) => {
    // 命令跑着的时候这一行是给 stdin 的，那里没有路径可补。
    if (running !== null || completing.current) return
    if (menu !== null && menu.items.length > 0) {
      const count = menu.items.length
      take(menu, menu.index < 0
        ? (step === 1 ? 0 : count - 1)
        : (menu.index + step + count) % count)
      return
    }
    const node = inputRef.current
    if (node === null) return
    const caret = node.selectionStart ?? input.length
    const token = tokenAt(input, caret)
    if (!completable(token)) { setMenu(null); return }
    const { dir, prefix } = splitPath(token.value)

    completing.current = true
    const entries = await listOf(dir).finally(() => { completing.current = false })
    // 列目录要等一趟请求，而人不会停下来等 —— 这会儿他可能又敲了几个字。
    // 下面整行都是拿 await 之前那份快照重建的，照着写回去等于把新敲的悄悄
    // 吞掉。宁可这次不补：Tab 再按一次就是了，敲进去的字找不回来。
    if (node.value !== input) { setMenu(null); return }
    if (entries === null) { setMenu(null); return }

    const hits = matching(entries, prefix)
    const head = input.slice(0, token.start)
    // 闭引号已经敲上了就把它吃掉 —— literal() 补出来的那对引号是完整的，
    // 留着只会得到 "packages/"" 这种谁也没打算要的东西。
    const closed = token.quote !== null && input[caret] === token.quote
    const tail = input.slice(caret + (closed ? 1 : 0))
    const list: Menu = {
      head,
      tail,
      dir,
      quote: token.quote,
      items: hits.slice(0, MAX_CANDIDATES),
      total: hits.length,
      index: -1,
    }

    // 空菜单就是那句「没有匹配」—— 让它占着屏幕上的位置，而不是悄无声息。
    if (hits.length === 0) { setMenu(list); return }
    const [only] = hits
    if (hits.length === 1 && only !== undefined) {
      const text = literal(dir + only.name + (only.kind === 'dir' ? '/' : ''), list.quote)
      const insert = only.kind === 'dir' || tail.startsWith(' ') ? text : `${text} `
      setMenu(null)
      put(head + insert + tail, head.length + insert.length)
      return
    }

    const common = commonPrefix(hits.map((hit) => hit.name))
    // 补出来比已经敲的还短就别动它：大小写不敏感那条退路会同时挑出 README
    // 与 ReadMe，它们的公共前缀是 'Read'，照着补等于把用户敲的削掉一截。
    if (common.length > prefix.length) {
      const text = literal(dir + common, list.quote)
      put(head + text + tail, head.length + text.length)
    }
    setMenu(list)
  }, [running, menu, input, listOf, put, take])

  /** 让选中的候选滚进视野 —— 轮到第三行上的那个时，看不见就等于没选。 */
  const chosen = useCallback((node: HTMLLIElement | null) => {
    node?.scrollIntoView({ block: 'nearest' })
  }, [])

  /**
   * 发一条命令。
   *
   * 屏幕上那一段**在这里就画出来**，不等服务端的 `began` 回来：那一趟往返
   * 里敲下的下一行会被当成"发给正在跑的命令"，而此刻还没有它的那一段 ——
   * 回显只能落到上一条命令的输出里，看起来像是凭空多出来一行。
   * `began` 到达时会认领这一段，不会再画一遍。
   */
  const send = useCallback((command: string) => {
    if (session === null || running !== null) return
    const id = nextId.current++
    follow.current = true
    setRunning(command)
    setBlocks((prev) => [
      ...prev,
      { id, command, where: cwd?.label ?? '', parts: [], done: null },
    ].slice(-MAX_BLOCKS))
    void api.shellExec(session.id, command).catch((failure: unknown) => {
      setRunning(null)
      const detail = failure instanceof ApiError
        ? maybe(t, `err.${failure.code}`, `${failure.code} · ${failure.message}`)
        : t('term.failed')
      // 报在那一段自己身上，而不是顶上的横幅：横幅说的是"这个终端出了事"，
      // 而这里出事的只是这一条命令。
      setBlocks((prev) => prev.map((block) => (block.id === id
        ? { ...block, done: { code: null, signal: null, interrupted: false, durationMs: 0, error: detail } }
        : block)))
    })
  }, [session, running, cwd, t])

  const submit = useCallback(() => {
    if (session === null) return
    // 命令跑着的时候，这一行是敲给它的 —— `npm init` 的提问就是这么答的。
    // 没有 tty 就没有回显，我们自己把它画出来。
    if (running !== null) {
      setInput('')
      write('echo', `${input}\n`)
      void api.shellInput(session.id, `${input}\n`)
      return
    }
    const command = input.trim()
    if (command.length === 0) return
    setInput('')
    setCursor(null)
    setMenu(null)
    setHistory((prev) => (prev.at(-1) === command ? prev : [...prev, command]))
    send(command)
  }, [session, running, input, write, send])

  /**
   * ctrl+c。屏幕上留一个 `^C` —— 终端就是这么让你知道信号发出去了的。
   *
   * 连按会**逐级加码**：SIGINT → SIGTERM → SIGKILL。真实终端不这么干，但
   * 那里你还能开一个新窗口去 `kill`；这里输入框已经归正在跑的那条命令了，
   * 一个吞掉 SIGINT 的进程会让人只剩下"等十分钟被回收"这一条路。
   */
  const interrupt = useCallback(() => {
    if (session === null || running === null) return
    const step = Math.min(insisted.current, ESCALATION.length - 1)
    const signal = ESCALATION[step] ?? 'SIGINT'
    insisted.current += 1
    write('echo', step === 0 ? '^C\n' : `^C (${signal})\n`)
    void api.shellSignal(session.id, signal)
  }, [session, running, write])

  /** 翻历史。到头了就停在那儿，往下翻到底则回到空行（还没敲的那条）。 */
  const stepHistory = useCallback((delta: number) => {
    if (history.length === 0) return
    const at = cursor === null ? history.length : cursor
    const next = Math.min(Math.max(at + delta, 0), history.length)
    setCursor(next === history.length ? null : next)
    setInput(next === history.length ? '' : history[next] ?? '')
  }, [history, cursor])

  const where = cwd?.label ?? (wanted ? t('term.connecting') : '')
  /** 文件浏览器逛到了别处，一键跟过去。已经在同一个目录就没必要出现。 */
  const canFollow = session !== null && running === null && cwd !== null && cwd.path !== browsing

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={t('term.expand')}
        className={cn(
          'flex h-8 flex-none items-center gap-2 border-t border-hairline px-3 text-left',
          'transition-colors hover:bg-raised/60',
        )}
      >
        <TerminalIcon className="size-3.5 flex-none text-ink-faint" />
        <span className="chrome-label">{t('term.title')}</span>
        <span className="mono min-w-0 flex-1 truncate text-[10px] text-ink-faint">{where}</span>
        {running === null ? null : (
          // 折起来的时候也得看得出「里面还有东西在跑」—— 否则一个还在跑的
          // dev server 会在收起面板之后彻底消失在视野里。
          <span className="chrome-label !text-sodium flex-none">{t('term.running')}</span>
        )}
        <ChevronUp className="size-3.5 flex-none text-ink-faint" />
      </button>
    )
  }

  return (
    <section className="flex h-[38%] min-h-40 flex-none flex-col border-t border-hairline">
      <header className="flex h-8 flex-none items-center gap-2 border-b border-hairline px-3">
        <TerminalIcon className="size-3.5 flex-none text-sodium" />
        <span className="chrome-label">{t('term.title')}</span>
        <span className="mono min-w-0 flex-1 truncate text-[10px] text-ink-faint" title={cwd?.path ?? ''}>
          {t('term.cwd', { path: where })}
        </span>

        {running === null ? null : (
          <button
            type="button"
            onClick={interrupt}
            title={t('term.interruptHint')}
            aria-label={t('term.interrupt')}
            className={cn(
              'flex size-6 items-center justify-center rounded-md border border-lamp-fail/50 text-lamp-fail',
              'transition-colors hover:bg-lamp-fail/10',
            )}
          >
            <CircleStop className="size-3" />
          </button>
        )}

        <button
          type="button"
          disabled={!canFollow}
          onClick={() => { send(`cd ${literal(browsing, null)}`) }}
          title={t('term.followHint')}
          aria-label={t('term.follow')}
          className={cn(
            'flex size-6 items-center justify-center rounded-md border border-hairline text-ink-faint',
            'transition-colors hover:border-sodium hover:text-sodium',
            'disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-faint',
          )}
        >
          <FolderInput className="size-3" />
        </button>

        <button
          type="button"
          onClick={() => {
            setBlocks([])
            // 记下清到哪儿：不然下一次重新订阅（换语言、切走再回来、刷新）
            // 会把这一屏从服务端的回放缓冲里原样搬回来。
            floor.current = Math.max(floor.current, seen.current)
            if (session !== null) remember(projectId, { id: session.id, floor: floor.current })
          }}
          title={t('term.clearHint')}
          aria-label={t('term.clear')}
          className="flex size-6 items-center justify-center rounded-md border border-hairline text-ink-faint transition-colors hover:border-sodium hover:text-sodium"
        >
          <Eraser className="size-3" />
        </button>
        <button
          type="button"
          onClick={onToggle}
          title={t('term.collapse')}
          aria-label={t('term.collapse')}
          className="flex size-6 items-center justify-center rounded-md border border-hairline text-ink-faint transition-colors hover:border-sodium hover:text-sodium"
        >
          <ChevronDown className="size-3" />
        </button>
      </header>

      {error === null ? null : (
        <p className="flex-none border-b border-lamp-fail/40 bg-lamp-fail/[0.07] px-3 py-1 text-[11px] text-lamp-fail">
          {error}
        </p>
      )}

      {!lost ? null : (
        <div className="flex flex-none items-center gap-2 border-b border-lamp-fail/40 bg-lamp-fail/[0.07] px-3 py-1">
          <Plug className="size-3 flex-none text-lamp-fail" />
          <span className="cjk-label min-w-0 flex-1 !text-lamp-fail">{t('term.lost')}</span>
          <button
            type="button"
            onClick={() => { setLost(false); setAttempt((n) => n + 1) }}
            className="chrome-label flex-none rounded-md border border-lamp-fail/50 px-2 py-0.5 !text-lamp-fail transition-colors hover:bg-lamp-fail/10"
          >
            {t('term.reconnect')}
          </button>
        </div>
      )}

      <div
        ref={screenRef}
        onScroll={(event) => {
          const node = event.currentTarget
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-void/40 px-3 py-2"
      >
        {blocks.length === 0 ? (
          <p className="cjk-label">{t('term.empty')} {t('term.hint')}</p>
        ) : blocks.map((block) => (
          <article key={block.id} className="mb-2 last:mb-0">
            {block.command.length === 0 ? null : (
              <p className="mono flex gap-2 text-[11px]">
                <span className="flex-none text-sodium" title={block.where}>{short(block.where)} $</span>
                <span className="min-w-0 flex-1 break-all text-ink">{block.command}</span>
              </p>
            )}
            {block.parts.length === 0 ? null : (
              <pre className="mono mt-0.5 break-all whitespace-pre-wrap text-[11px] leading-[1.5] text-ink-dim">
                {block.parts.map((part, at) => (
                  <span
                    key={at}
                    className={cn(
                      part.stream === 'err' && 'text-lamp-fail/90',
                      part.stream === 'echo' && 'text-sodium/80',
                    )}
                  >
                    {part.text}
                  </span>
                ))}
              </pre>
            )}
            {block.done === null
              ? <p className="cjk-label mt-0.5 !text-sodium">{t('term.running')}</p>
              : <Status done={block.done} />}
          </article>
        ))}
      </div>

      {menu === null ? null : (
        <div className="flex-none border-t border-hairline px-3 py-1">
          {menu.items.length === 0 ? (
            <p className="cjk-label">{t('term.noMatch')}</p>
          ) : (
            <>
              <ul className="flex max-h-14 flex-wrap gap-x-3 gap-y-0.5 overflow-y-auto">
                {menu.items.map((item, at) => (
                  <li
                    key={item.name}
                    ref={at === menu.index ? chosen : null}
                    className={cn(
                      'mono text-[11px]',
                      at === menu.index ? 'rounded-sm bg-sodium/15 px-1 text-sodium' : 'text-ink-dim',
                    )}
                  >
                    {item.name}{item.kind === 'dir' ? '/' : ''}
                  </li>
                ))}
              </ul>
              {menu.total > menu.items.length ? (
                <p className="cjk-label mt-0.5">
                  {t('term.moreMatches', { n: menu.total - menu.items.length })}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}

      <form
        className="flex flex-none items-center gap-2 border-t border-hairline px-3 py-1.5"
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <span className="mono flex-none text-[11px] text-sodium" title={cwd?.path ?? ''}>
          {running === null ? `${short(where)} $` : '›'}
        </span>
        <input
          autoFocus
          ref={inputRef}
          value={input}
          disabled={session === null}
          spellCheck={false}
          autoComplete="off"
          placeholder={running === null ? t('term.placeholder') : t('term.stdinPlaceholder')}
          aria-label={running === null ? t('term.placeholder') : t('term.stdinPlaceholder')}
          onChange={(event) => { setInput(event.target.value); setMenu(null) }}
          // 焦点走了这一轮补全就结束了 —— 候选说的是"你正在敲的那个词"。
          onBlur={() => { setMenu(null) }}
          onKeyDown={(event) => {
            /*
             * ctrl+c：跑着的时候是中断，空闲时是「这一行不要了」——
             * 和终端里一模一样。选中了文本就让它去当复制，别抢。
             */
            if (event.key === 'c' && event.ctrlKey && !event.metaKey) {
              const selection = window.getSelection()?.toString() ?? ''
              if (selection.length > 0) return
              event.preventDefault()
              if (running !== null) interrupt()
              else { setInput(''); setMenu(null) }
              return
            }
            // ctrl+d：把 stdin 关掉。`cat`、`sort` 这类要读到结尾才会动的
            // 命令，不给它这一下就永远不会结束。
            if (event.key === 'd' && event.ctrlKey && running !== null && input.length === 0) {
              event.preventDefault()
              write('echo', '^D\n')
              if (session !== null) void api.shellInput(session.id, '', true)
              return
            }
            // Tab 在浏览器里默认是「跳到下一个控件」。这是个终端，Tab 是补全。
            if (event.key === 'Tab') {
              event.preventDefault()
              void complete(event.shiftKey ? -1 : 1)
              return
            }
            // 摊开的候选先用 esc 收掉，别让这一下顺手关掉整个面板。
            if (event.key === 'Escape' && menu !== null) {
              event.preventDefault()
              event.stopPropagation()
              setMenu(null)
              return
            }
            // 按下修饰键还不算动作，Shift+Tab 的前半下就是它。
            if (MODIFIERS.has(event.key)) return
            // 别的键都意味着这一轮补全结束了 —— 候选是对着刚才那个词说的。
            setMenu(null)
            if (event.key === 'ArrowUp') { event.preventDefault(); stepHistory(-1) }
            if (event.key === 'ArrowDown') { event.preventDefault(); stepHistory(1) }
            // 回车自己提交，并挡掉表单的隐式提交（不挡就会跑两遍）。表单的
            // 隐式提交在个别环境里不触发，而"敲回车跑命令"不能有环境依赖。
            if (event.key === 'Enter') { event.preventDefault(); submit() }
          }}
          className={cn(
            'mono min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none',
            'placeholder:text-ink-faint disabled:opacity-50',
          )}
        />
        <span className="chrome-label !text-[8px] flex-none">
          {running === null ? t('term.tabHint') : t('term.interruptHint')}
        </span>
        <span className="chrome-label !text-[8px] flex-none">{t('term.historyHint')}</span>
        <button
          type="submit"
          disabled={session === null || (running === null && input.trim().length === 0)}
          title={running === null ? t('term.run') : t('term.send')}
          aria-label={running === null ? t('term.run') : t('term.send')}
          className={cn(
            'flex size-6 flex-none items-center justify-center rounded-md border border-hairline text-ink-faint',
            'transition-colors hover:border-sodium hover:text-sodium',
            'disabled:opacity-40 disabled:hover:border-hairline disabled:hover:text-ink-faint',
          )}
        >
          <CornerDownLeft className="size-3" />
        </button>
      </form>
    </section>
  )
}

/**
 * 提示符上写哪一截路径。
 *
 * 完整路径动辄七八层（worktree 尤其深），整条摆在提示符上会把输入框挤出
 * 屏幕 —— 而输入框正是这一行上唯一要用的东西。留最后两段，完整的挂在
 * `title` 上，标题栏里也照旧写着。
 */
function short(label: string): string {
  const parts = label.split('/').filter((part) => part.length > 0)
  return parts.length <= 2 ? label : `…/${parts.slice(-2).join('/')}`
}

/**
 * 把一段输出封在 {@link MAX_BLOCK_CHARS} 以内，从**前面**丢。
 *
 * 终端里有价值的永远是最新的那几屏。从后面丢等于把刚出来的东西扔掉，
 * 那正是此刻用户盯着的。
 */
function trim(parts: Part[]): Part[] {
  let total = 0
  for (const part of parts) total += part.text.length
  if (total <= MAX_BLOCK_CHARS) return parts
  let over = total - MAX_BLOCK_CHARS
  const kept: Part[] = []
  for (const part of parts) {
    if (over <= 0) { kept.push(part); continue }
    if (part.text.length <= over) { over -= part.text.length; continue }
    kept.push({ stream: part.stream, text: part.text.slice(over) })
    over = 0
  }
  return kept
}

/**
 * 一条命令的结局。
 *
 * 「被 ctrl+c 打断」要和「它自己失败了」分开说：前者是用户刚做的事，把它
 * 报成 `退出码 130` 等于让人去查一个自己按出来的数字。
 */
function Status({ done }: { done: Outcome }): React.JSX.Element {
  const t = useT()
  const ms = String(done.durationMs)
  const failed = done.code !== 0 || done.error !== undefined
  const text = done.error !== undefined
    ? t('term.failed')
    : done.interrupted
      ? t('term.interrupted', { ms })
      : done.signal !== null
        ? t('term.signal', { signal: done.signal, ms })
        : done.code === 0
          ? t('term.ok', { ms })
          : t('term.exit', { code: String(done.code ?? '?'), ms })

  return (
    <>
      <p className={cn('chrome-label mt-0.5', failed && '!text-lamp-fail')}>{text}</p>
      {done.error === undefined ? null : <p className="cjk-label !text-lamp-fail">{done.error}</p>}
    </>
  )
}
