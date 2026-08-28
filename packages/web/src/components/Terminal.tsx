import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CornerDownLeft, Eraser, Terminal as TerminalIcon } from 'lucide-react'
import { api, ApiError } from '@/api.ts'
import {
  commonPrefix, completable, literal, matching, splitPath, tokenAt, type Quote,
} from '@/lib/complete.ts'
import { maybe, useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { ExecResult } from '@/types.ts'

/** 屏上最多留多少条。再往上翻的价值抵不过把一页 DOM 撑到几万个节点。 */
const MAX_LINES = 200

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

interface Line {
  id: number
  command: string
  /** 跑在哪个目录 —— 中途换过目录时，光看命令分不出它是在哪儿跑的。 */
  where: string
  /** 还在跑时为 null。 */
  result: ExecResult | null
  /** 连起都没起来（不是命令自己失败）。 */
  error: string | null
}

interface Props {
  /** 工作区根，服务端据此校验围栏。 */
  root: string
  /** 命令跑在哪个目录，跟着上面浏览到的位置走。 */
  cwd: string
  /** 提示符上显示的相对路径。绝对路径太长，一行放不下。 */
  where: string
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
 * **每条命令跑在新的 shell 里**，所以 `cd` 不会留到下一条。这不是偷懒：
 * 维持一个长活的 shell 会话要处理伪终端、并发写入、进程重启后的状态丢失，
 * 而这里真正要解决的是「在正确的目录里跑一条命令」。换目录在上面点就是了 ——
 * 提示符和 `term.hint` 都把这件事说在明处，免得有人对着不动的 cwd 犯嘀咕。
 */
export function Terminal({ root, cwd, where, open, onToggle }: Props): React.JSX.Element {
  const t = useT()
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 敲过的命令，最近的在后面。翻历史时 cursor 指向其中一条。
  const [history, setHistory] = useState<string[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  // Tab 补出来的候选。null = 此刻没在补全。
  const [menu, setMenu] = useState<Menu | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)
  /**
   * 列过的目录，键是绝对路径。
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
  }, [lines, open])

  /**
   * 命令跑完把光标还给输入框。
   *
   * `disabled` 会把焦点顶到 body 上，而这是个终端 —— 敲一条、看一眼、再敲一条
   * 才是它的用法。少了这一步，每条命令之后都要先用鼠标点回输入框。
   *
   * 只在焦点确实是被我们顶掉的时候才还（此刻焦点落在 body 上）：用户在等结果
   * 的时候点去了文件列表，就不该把他拽回来。
   */
  useEffect(() => {
    if (busy) return
    const node = inputRef.current
    const active = document.activeElement
    if (node === null || (active !== null && active !== document.body)) return
    node.focus()
  }, [busy])

  useEffect(() => {
    const at = caretTo.current
    if (at === null) return
    caretTo.current = null
    inputRef.current?.setSelectionRange(at, at)
  }, [input])

  /** 换了工作区，之前列过的目录跟这儿没关系了。 */
  useEffect(() => {
    listings.current.clear()
    setMenu(null)
  }, [root, cwd])

  /** 改写输入框，并把光标停在补进去的那一段之后。 */
  const put = useCallback((text: string, caret: number) => {
    setInput(text)
    caretTo.current = caret
  }, [])

  /**
   * 列一个目录，给补全用。
   *
   * 走的是文件浏览那条接口，所以围栏是同一道：补不出工作区外面的路径。
   * 目录不存在、或在围栏外时回 null —— 那是「没得补」，不是故障，不该在
   * 屏幕上留一行红字。
   */
  const listOf = useCallback(async (dir: string): Promise<Candidate[] | null> => {
    const at = dir.startsWith('/') ? dir : dir.length === 0 ? cwd : `${cwd}/${dir}`
    const cached = listings.current.get(at)
    if (cached !== undefined) return cached
    const listing = await api.files(root, at).catch(() => null)
    if (listing === null) return null
    const items = listing.entries.map((entry) => ({ name: entry.name, kind: entry.kind }))
    listings.current.set(at, items)
    return items
  }, [root, cwd])

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
    if (busy || completing.current) return
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
  }, [busy, menu, input, listOf, put, take])

  /** 让选中的候选滚进视野 —— 轮到第三行上的那个时，看不见就等于没选。 */
  const chosen = useCallback((node: HTMLLIElement | null) => {
    node?.scrollIntoView({ block: 'nearest' })
  }, [])

  const submit = useCallback(() => {
    const command = input.trim()
    if (command.length === 0 || busy) return
    const id = nextId.current++
    // 跑了一条新命令，人显然是想看它的输出 —— 哪怕刚才正翻着旧的。
    follow.current = true
    setInput('')
    setCursor(null)
    setMenu(null)
    setHistory((prev) => (prev.at(-1) === command ? prev : [...prev, command]))
    setLines((prev) => [...prev, { id, command, where, result: null, error: null }].slice(-MAX_LINES))
    setBusy(true)
    void api.exec(root, cwd, command)
      .then((result) => {
        setLines((prev) => prev.map((line) => (line.id === id ? { ...line, result } : line)))
      })
      .catch((failure: unknown) => {
        // 命令自己失败（非零退出）不会走到这儿 —— 那是 200，是它的输出。
        // 到这儿的是围栏拒绝、命令起不来这类，要说清楚是哪一种。
        const detail = failure instanceof ApiError
          ? maybe(t, `err.${failure.code}`, `${failure.code} · ${failure.message}`)
          : t('term.failed')
        setLines((prev) => prev.map((line) => (line.id === id ? { ...line, error: detail } : line)))
      })
      .finally(() => {
        setBusy(false)
        // 这条命令可能刚 mkdir 出一个目录 —— 补不出刚建的东西比慢一点更难解释。
        listings.current.clear()
      })
  }, [input, busy, root, cwd, where, t])

  /** 翻历史。到头了就停在那儿，往下翻到底则回到空行（还没敲的那条）。 */
  const stepHistory = useCallback((delta: number) => {
    if (history.length === 0) return
    const at = cursor === null ? history.length : cursor
    const next = Math.min(Math.max(at + delta, 0), history.length)
    setCursor(next === history.length ? null : next)
    setInput(next === history.length ? '' : history[next] ?? '')
  }, [history, cursor])

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
        <ChevronUp className="size-3.5 flex-none text-ink-faint" />
      </button>
    )
  }

  return (
    <section className="flex h-[38%] min-h-40 flex-none flex-col border-t border-hairline">
      <header className="flex h-8 flex-none items-center gap-2 border-b border-hairline px-3">
        <TerminalIcon className="size-3.5 flex-none text-sodium" />
        <span className="chrome-label">{t('term.title')}</span>
        <span className="mono min-w-0 flex-1 truncate text-[10px] text-ink-faint" title={cwd}>
          {t('term.cwd', { path: where })}
        </span>
        <button
          type="button"
          onClick={() => { setLines([]) }}
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

      <div
        ref={screenRef}
        onScroll={(event) => {
          const node = event.currentTarget
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-void/40 px-3 py-2"
      >
        {lines.length === 0 ? (
          <p className="cjk-label">{t('term.empty')} {t('term.hint')}</p>
        ) : lines.map((line) => (
          <article key={line.id} className="mb-2 last:mb-0">
            <p className="mono flex gap-2 text-[11px]">
              <span className="flex-none text-sodium">{line.where} $</span>
              <span className="min-w-0 flex-1 break-all text-ink">{line.command}</span>
            </p>
            {line.result === null && line.error === null ? (
              <p className="cjk-label mt-0.5 !text-sodium">{t('term.running')}</p>
            ) : null}
            {line.error === null ? null : (
              <p className="cjk-label mt-0.5 !text-lamp-fail">{line.error}</p>
            )}
            {line.result === null ? null : <Outcome result={line.result} />}
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
        <span className="mono flex-none text-[11px] text-sodium">{where} $</span>
        <input
          autoFocus
          ref={inputRef}
          value={input}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('term.placeholder')}
          aria-label={t('term.placeholder')}
          onChange={(event) => { setInput(event.target.value); setMenu(null) }}
          // 焦点走了这一轮补全就结束了 —— 候选说的是"你正在敲的那个词"。
          onBlur={() => { setMenu(null) }}
          onKeyDown={(event) => {
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
        <span className="chrome-label !text-[8px] flex-none">{t('term.tabHint')}</span>
        <span className="chrome-label !text-[8px] flex-none">{t('term.historyHint')}</span>
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          title={t('term.run')}
          aria-label={t('term.run')}
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
 * 一条命令的结果。
 *
 * stdout 与 stderr 分开显示且都保留 —— 很多工具（git、npm）把进度和告警写在
 * stderr 上，把两路揉成一股，「它到底有没有出错」就再也分不出来了。
 */
function Outcome({ result }: { result: ExecResult }): React.JSX.Element {
  const t = useT()
  const ms = String(result.durationMs)
  const failed = result.code !== 0
  const status = result.signal !== null
    ? t('term.signal', { signal: result.signal, ms })
    : result.code === 0
      ? t('term.ok', { ms })
      : t('term.exit', { code: String(result.code ?? '?'), ms })

  return (
    <>
      {result.stdout.length === 0 ? null : (
        <pre className="mono mt-0.5 break-all whitespace-pre-wrap text-[11px] leading-[1.5] text-ink-dim">
          {result.stdout}
        </pre>
      )}
      {result.stderr.length === 0 ? null : (
        <pre className="mono mt-0.5 break-all border-l-2 border-lamp-fail/50 pl-2 whitespace-pre-wrap text-[11px] leading-[1.5] text-lamp-fail/90">
          {result.stderr}
        </pre>
      )}
      <p className={cn('chrome-label mt-0.5', failed && '!text-lamp-fail')}>{status}</p>
      {result.timedOut ? <p className="cjk-label !text-lamp-fail">{t('term.timedOut')}</p> : null}
      {result.truncated ? <p className="cjk-label !text-lamp-fail">{t('term.truncated')}</p> : null}
    </>
  )
}
