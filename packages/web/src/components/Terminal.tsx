import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CornerDownLeft, Eraser, Terminal as TerminalIcon } from 'lucide-react'
import { api, ApiError } from '@/api.ts'
import { maybe, useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { ExecResult } from '@/types.ts'

/** 屏上最多留多少条。再往上翻的价值抵不过把一页 DOM 撑到几万个节点。 */
const MAX_LINES = 200

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
  const screenRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const nextId = useRef(0)
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

  const submit = useCallback(() => {
    const command = input.trim()
    if (command.length === 0 || busy) return
    const id = nextId.current++
    // 跑了一条新命令，人显然是想看它的输出 —— 哪怕刚才正翻着旧的。
    follow.current = true
    setInput('')
    setCursor(null)
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
      .finally(() => { setBusy(false) })
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
          onChange={(event) => { setInput(event.target.value) }}
          onKeyDown={(event) => {
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
