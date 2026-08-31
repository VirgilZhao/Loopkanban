import { useEffect, useRef, useState } from 'react'
import { ArrowRight, AtSign, Bot, Eraser, Inbox, Send, User } from 'lucide-react'
import { api, ApiError } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { explain, useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { mentioned } from '@/lib/mention.ts'
import { cn } from '@/lib/utils.ts'
import type { ChatMessage, ChatState, Executor, Project, Task } from '@/types.ts'

/** 执行器在想的时候盯紧一点，闲着时就不必了 —— 与看板那套节奏同一个道理。 */
const POLL_BUSY_MS = 1_500
const POLL_IDLE_MS = 8_000

interface Props {
  /** 聊的是哪个仓库里的事。对话挂在项目上。 */
  project: Project
  executors: Executor[]
  /** 草案被采纳、卡建出来了。外面把它选中。 */
  onCreated: (task: Task) => void
  /** 看板得重新拉一遍。 */
  onChanged: () => void
}

/**
 * 建卡之前的那段对话。
 *
 * 这块地方从前是个「写一句话就是一张卡」的输入框：一句话直接变成需求，中间
 * 没有任何人帮你想清楚。现在它是真的聊天 —— 默认执行器跟人来回问，谈拢了
 * 提一份草案，**人点头才落成卡**。
 *
 * 回复不走 SSE 而是轮询：一轮 CLI 要跑几十秒，而这块面板本来就跟着看板一起
 * 在轮询。多开一条长连接，换来的只是几百毫秒的提前量。
 */
export function ChatThread({ project, executors, onCreated, onChanged }: Props): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<ChatState | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  /** 眼下排着的那次轮询。发完话要把它提前 —— 见下面的 `hurry`。 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * 把下一次轮询提到"盯紧"那一档。
   *
   * 刚发完话时非提不可：那一刻排着的多半是**空闲档**的那个定时器（8 秒），
   * 而执行器三秒就答完了 —— 不动它的话，界面要对着一句已经写好的回复
   * 干等五秒。挂在 ref 上是因为定时器归那个 effect 管，而发送在它外面。
   */
  const hurryRef = useRef<() => void>(() => {})

  const pending = state?.pending === true
  /** 眼下这句话交给谁：话里 @ 到谁就是谁，否则默认那位。 */
  const speaker = mentioned(draft, executors)
    ?? executors.find((executor) => executor.id === state?.executor?.id)

  // 换项目就换一段对话：上一个仓库聊到哪儿，跟这个仓库没关系。
  useEffect(() => {
    setState(null)
    setDraft('')
    setFailure(null)
  }, [project.id])

  // 拉对话，并在执行器还在想的时候盯紧一点。
  useEffect(() => {
    let cancelled = false
    // 排下一拍之前先撤掉上一拍：`hurry` 会在一次请求还在路上的时候插进来，
    // 不撤的话两个定时器会同时活着，此后每一拍都翻倍。
    const schedule = (delay: number): void => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      timerRef.current = cancelled ? undefined : setTimeout(pull, delay)
    }
    const pull = (): void => {
      void api.chat(project.id)
        .then((loaded) => {
          if (cancelled) return
          setState(loaded)
          schedule(loaded.pending ? POLL_BUSY_MS : POLL_IDLE_MS)
        })
        // 拉失败就留着手上这份，下一拍再试 —— 一次网络抖动不是"这段对话没了"。
        .catch(() => { schedule(POLL_IDLE_MS) })
    }
    hurryRef.current = () => { schedule(POLL_BUSY_MS) }
    pull()
    return () => {
      cancelled = true
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      hurryRef.current = () => {}
    }
  }, [project.id])

  // 新消息到了就滚到底 —— 活的那部分总该在屏幕里。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state?.messages.length, pending])

  const report = (error: unknown, fallback: string): void => {
    setFailure(error instanceof ApiError ? explain(t, error.code, error.message) : fallback)
  }

  const sendable = !busy && draft.trim().length > 0 && executors.length > 0

  const send = (): void => {
    if (!sendable) return
    const body = draft.trim()
    setBusy(true)
    setFailure(null)
    void api.say(project.id, body)
      .then((next) => {
        // 发出去了才清输入框：被拒的那句话得留在框里，人不该重打一遍。
        setDraft('')
        setState(next)
        // 它这就开始想了，把轮询提到盯紧那一档 —— 否则回复要等空闲档那一拍。
        hurryRef.current()
      })
      .catch((error: unknown) => { report(error, t('chat.sendFailed')) })
      .finally(() => { setBusy(false) })
  }

  /** 把 `@名字 ` 插到光标处。点一下比打字快，也顺带教会了这个写法。 */
  const insertMention = (name: string): void => {
    const box = boxRef.current
    const at = box?.selectionStart ?? draft.length
    const before = draft.slice(0, at)
    const lead = before.length === 0 || before.endsWith(' ') || before.endsWith('\n') ? '' : ' '
    setDraft(`${before}${lead}@${name} ${draft.slice(at)}`)
    const cursor = before.length + lead.length + name.length + 2
    requestAnimationFrame(() => {
      box?.focus()
      box?.setSelectionRange(cursor, cursor)
    })
  }

  /** 采纳一份草案：落成一张卡，放想法池或直接排队。 */
  const adopt = (messageId: string, column: 'backlog' | 'ready'): void => {
    setBusy(true)
    setFailure(null)
    void api.adopt(messageId, column)
      .then(({ task, chat }) => {
        if (chat !== null) setState(chat)
        onCreated(task)
        onChanged()
      })
      .catch((error: unknown) => { report(error, t('chat.adoptFailed')) })
      .finally(() => { setBusy(false) })
  }

  const messages = state?.messages ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <p className="cjk-label mx-auto max-w-64 pt-10 text-center leading-relaxed">
            {executors.length === 0 ? t('chat.noExecutor') : t('chat.createHint')}
          </p>
        ) : null}

        {messages.map((message) => (
          message.role === 'proposal'
            ? (
              <Proposal
                key={message.id}
                message={message}
                busy={busy}
                onAdopt={(column) => { adopt(message.id, column) }}
              />
            )
            : (
              <Bubble
                key={message.id}
                message={message}
                name={executors.find((executor) => executor.id === message.executorId)?.name}
              />
            )
        ))}

        {/* 它在想。摆一行会呼吸的字，而不是让人对着一片安静猜自己那句话发出去没有。 */}
        {pending ? (
          <p className="flex items-center gap-1.5 text-xs text-sodium">
            <Bot className="size-3.5 animate-pulse" />
            {t('chat.thinking', { name: state?.executor?.name ?? '' })}
          </p>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {/* 上一轮跑挂了。**不混进对话** —— 那是这一次的事故，不是聊天的一部分。 */}
      {state?.failure === undefined ? null : (
        <p className="flex-none border-t border-lamp-fail/40 bg-lamp-fail/[0.07] px-4 py-2 text-[11px] text-lamp-fail">
          {state.failure === 'no-executor'
            ? t('chat.noExecutor')
            : t('chat.turnFailed', { name: state.executor?.name ?? '', detail: state.failure })}
        </p>
      )}
      {failure === null ? null : (
        <p className="flex-none border-t border-lamp-fail/40 bg-lamp-fail/[0.07] px-4 py-2 text-[11px] text-lamp-fail">
          {failure}
        </p>
      )}

      <div className="flex-none space-y-2 border-t border-hairline px-3 py-3">
        <Textarea
          ref={boxRef}
          value={draft}
          disabled={busy || executors.length === 0}
          placeholder={t('chat.createPlaceholder')}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            // 一句话的东西，回车就发；写长了用 shift 换行。这儿是聊天，不是写规格。
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          className="field-sizing-fixed h-20"
        />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {executors.length === 0 ? null : (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              <AtSign className="size-3 flex-none text-ink-faint" />
              {executors.map((executor) => (
                <button
                  key={executor.id}
                  type="button"
                  disabled={busy}
                  title={t('talk.mentionHint', { name: executor.name })}
                  onClick={() => { insertMention(executor.name) }}
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    speaker?.id === executor.id
                      ? 'border-sodium-deep/50 bg-sodium/[0.10] text-ink'
                      : 'border-hairline text-ink-faint hover:border-hairline-bright hover:text-ink',
                  )}
                >
                  {executor.name}
                </button>
              ))}
            </span>
          )}
          <span className="flex-1" />
          {messages.length === 0 ? null : (
            <button
              type="button"
              disabled={busy}
              title={t('chat.clear')}
              aria-label={t('chat.clear')}
              onClick={() => {
                setBusy(true)
                void api.clearChat(project.id)
                  .then((next) => { setState(next) })
                  .catch((error: unknown) => { report(error, t('chat.clearFailed')) })
                  .finally(() => { setBusy(false) })
              }}
              className="rounded-md p-1 text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
            >
              <Eraser className="size-3.5" />
            </button>
          )}
          <Button size="xs" className="flex-none" disabled={!sendable} onClick={send}>
            <Send />{t('chat.send')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 一条普通消息：人说的，或执行器答的。 */
function Bubble({ message, name }: { message: ChatMessage; name?: string }): React.JSX.Element {
  const t = useT()
  const agent = message.role === 'agent'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {agent ? <Bot className="size-3.5 text-sodium" /> : <User className="size-3.5 text-ink-faint" />}
        <span className={cn('text-xs font-medium', agent ? 'text-sodium' : 'text-ink')}>
          {agent ? name ?? 'Agent' : t('chat.you')}
        </span>
        <span className="mono text-[10px] text-ink-faint">
          {new Date(message.at).toLocaleTimeString()}
        </span>
      </div>
      <div className={cn(
        'rounded-lg border px-3 py-2 text-[13px]',
        agent ? 'border-hairline bg-sunken/40' : 'border-sodium-deep/30 bg-sodium/[0.05]',
      )}>
        {renderMarkdown(message.body, { onOpenFile: () => {} })}
      </div>
    </div>
  )
}

/**
 * 一份任务草案。
 *
 * 摆成一张**看得见全部内容**的卡：人要点头的是这些字，折叠起来只会让他
 * 在没读的情况下点"建"。落在哪一列当场决定 —— 那正是这一刻他最清楚的事。
 */
function Proposal({ message, busy, onAdopt }: {
  message: ChatMessage
  busy: boolean
  onAdopt: (column: 'backlog' | 'ready') => void
}): React.JSX.Element {
  const t = useT()
  const proposal = message.proposal
  if (proposal === undefined) return <></>
  const adopted = message.taskId !== undefined

  return (
    <div className={cn(
      'rounded-xl border border-sodium-deep/50 bg-sodium/[0.05] px-3 py-2.5',
      adopted && 'opacity-60',
    )}>
      <div className="flex items-center gap-1.5">
        <span className="chrome-label !text-[9px] text-sodium">{t('chat.proposal')}</span>
        <span className="flex-1" />
        {adopted ? (
          <span className="mono text-[10px] text-lamp-ok">{t('chat.adopted', { id: message.taskId ?? '' })}</span>
        ) : null}
      </div>

      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
        {proposal.description}
      </p>

      {proposal.acceptance.length === 0 ? null : (
        <>
          <p className="chrome-label mt-2.5 !text-[9px]">{t('chat.acceptance')}</p>
          <ul className="mt-1 space-y-0.5">
            {proposal.acceptance.map((item, index) => (
              <li key={index} className="flex gap-1.5 text-[12px] leading-snug text-ink-faint">
                <span className="text-sodium">·</span>{item}
              </li>
            ))}
          </ul>
        </>
      )}

      {adopted ? null : (
        <div className="mt-3 flex items-center gap-2 border-t border-hairline/60 pt-2.5">
          <p className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{t('chat.proposalHint')}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            title={t('chat.adoptBacklogHint')}
            onClick={() => { onAdopt('backlog') }}
          >
            <Inbox />{t('chat.adoptBacklog')}
          </Button>
          <Button
            size="xs"
            disabled={busy}
            title={t('chat.adoptReadyHint')}
            onClick={() => { onAdopt('ready') }}
          >
            <ArrowRight />{t('chat.adoptReady')}
          </Button>
        </div>
      )}
    </div>
  )
}
