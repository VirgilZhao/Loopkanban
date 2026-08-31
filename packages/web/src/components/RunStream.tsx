import { useEffect, useState } from 'react'
import {
  Bot, Brain, Check, ChevronDown, ChevronRight, Info, TriangleAlert, Wrench, X,
} from 'lucide-react'
import { useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { cn } from '@/lib/utils.ts'
import type { Run, StreamEvent } from '@/types.ts'

/** 工具参数摘要最多显示这么长；全文挂在 title 上。 */
const SUMMARY_MAX = 200

/** 折叠行里最多列几种工具 —— 再多就成了另一份日志。 */
const TOP_TOOLS = 3

/** 这些名字下的"工具调用"其实是模型在想事情，按想法显示，不按动作显示。 */
const THINKING = /reason|think/i

/**
 * 对话里的一个块。事件流是逐条来的，但读的人要的是"它说了什么、做了什么"，
 * 所以连着的几条文本先并成一段再显示。
 */
type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'think'; key: string; text: string }
  | { kind: 'tool'; key: string; name: string; summary: string }
  | { kind: 'note'; key: string; text: string; warn: boolean }

/** 从工具参数里挑一句能代表这次调用的话：跑了什么命令、动了哪个文件。 */
function toolSummary(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'text', 'description']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const first = Object.values(fields).find((value) => typeof value === 'string' && value.trim() !== '')
  return typeof first === 'string' ? first.trim() : ''
}

/**
 * 把一轮执行的事件压成对话里的几个块。
 *
 * 扔掉的是 raw（没被识别的原始输出，是给排查用的，不是给读的）；用量与收场
 * 不进正文，它们是这一轮的脚注，由外面的头尾两行说。
 */
function toBlocks(events: StreamEvent[]): Block[] {
  const blocks: Block[] = []
  for (const event of events) {
    const key = String(event.seq)
    const payload = event.payload
    if (event.kind === 'text') {
      const text = String(payload['text'] ?? '').trim()
      if (text === '') continue
      const last = blocks[blocks.length - 1]
      // 连着的文本并成一段：模型是一块一块吐出来的，读的人看到的该是一段话。
      if (last !== undefined && last.kind === 'text') last.text = `${last.text}\n\n${text}`
      else blocks.push({ kind: 'text', key, text })
      continue
    }
    if (event.kind === 'tool') {
      const name = String(payload['name'] ?? '?')
      const summary = toolSummary(payload['input'])
      if (THINKING.test(name)) {
        if (summary !== '') blocks.push({ kind: 'think', key, text: summary })
        continue
      }
      blocks.push({ kind: 'tool', key, name, summary })
      continue
    }
    if (event.kind === 'notice') {
      const text = String(payload['text'] ?? '').trim()
      if (text === '') continue
      blocks.push({ kind: 'note', key, text, warn: payload['level'] === 'warn' })
    }
  }
  return blocks
}

interface Props {
  run: Run
  events: StreamEvent[]
  /** 这一轮还在跑。跑着的时候摊开，跑完了收成一行。 */
  live: boolean
  /** 第几轮。有好几轮时，光看时间戳分不出这是第几次派活。 */
  round: number
  /** 服务端只回了最新的一段事件，前面还有 —— 摊开时说一声，别假装这就是全部。 */
  truncated?: boolean
  /** 事件还在路上。历史轮次是点开才去拿的。 */
  loading?: boolean
  /** 被摊开了。历史轮次靠它去把事件拉回来。 */
  onOpen?: () => void
}

/**
 * 一轮执行在对话里的样子：它说的话、它动的手，按发生的顺序排下来。
 *
 * 过去这些只在详情弹窗的「事件流」里，是一份给排查用的日志（每条一行、
 * 带类型前缀）。可人想知道的是"它在干什么" —— 那是一段对话：说一段话、
 * 读几个文件、跑一条命令、再说一段。所以这里按对话排：文本是气泡，工具
 * 调用是气泡之间那一行细字，想事情是一段灰的。原始输出留在事件流里，
 * 那儿才是排查该去的地方。
 *
 * 跑完就收成一行 —— 过程只在它正在发生时值得占地方；要回头看，点开还在。
 */
export function RunStream({
  run, events, live, round, truncated = false, loading = false, onOpen,
}: Props): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(live)

  // 一挂上来就是摊开的（正在跑的那一轮），事件也得跟着要。
  useEffect(() => { if (live) onOpen?.() }, [run.id])

  // 换一轮才重设摊开与否：跑着的时候摊开，历史的那轮收着。**跑完不自动收起**
  // —— 正看着的东西在眼前合上，比多占一屏更让人恼火。
  useEffect(() => { setOpen(live) }, [run.id])

  const blocks = toBlocks(events)

  /** 用哪个模型跑的 —— 这件事只有 session 那条事件知道，Run 上没有。 */
  const model = events
    .filter((event) => event.kind === 'session')
    .map((event) => event.payload['model'])
    .find((value): value is string => typeof value === 'string')

  /** 这一轮烧了多少。每一步各报一次，累起来才是这一轮的账。 */
  const usage = events.reduce((sum, event) => {
    if (event.kind !== 'usage') return sum
    const number = (key: string): number => {
      const value = event.payload[key]
      return typeof value === 'number' ? value : 0
    }
    return {
      input: sum.input + number('inputTokens'),
      output: sum.output + number('outputTokens'),
      cost: sum.cost + number('costUsd'),
    }
  }, { input: 0, output: 0, cost: 0 })

  /** 收场：跑成了没有，以及没跑成时那句诊断。 */
  const finished = [...events].reverse().find((event) => event.kind === 'finished')
  const ok = finished === undefined ? null : finished.payload['ok'] === true
  const diagnostic = finished === undefined
    ? ''
    : String(finished.payload['diagnostic'] ?? finished.payload['summary'] ?? '')

  // 这一轮动了多少次手，按工具分类数。折叠着的时候，这行数字就是全部内容。
  const counts = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind !== 'tool') continue
    counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
  }
  const tally = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TOOLS)
    .map(([name, n]) => `${name}×${String(n)}`)
    .join(' ')

  return (
    <div className="space-y-1.5">
      {/* 这一轮的抬头：谁在跑、跑到哪儿了。折叠着的时候它就是那一行。 */}
      <button
        type="button"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) onOpen?.()
        }}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {open ? <ChevronDown className="size-3 flex-none text-ink-faint" />
              : <ChevronRight className="size-3 flex-none text-ink-faint" />}
        <Bot className="size-3.5 flex-none text-sodium" />
        <span className="text-xs font-medium text-sodium">{t('stream.round', { n: round })}</span>
        <span className="mono truncate text-[10px] text-ink-faint" title={model}>
          {run.provider}{model === undefined ? '' : ` · ${model}`}
        </span>
        {live ? (
          <span className="inline-flex flex-none items-center gap-1 text-[10px] text-sodium">
            <span className="lamp" data-state="running" />{t('stream.live')}
          </span>
        ) : ok === null ? null : (
          <span className={cn(
            'inline-flex flex-none items-center gap-0.5 text-[10px]',
            ok ? 'text-lamp-ok' : 'text-lamp-fail',
          )}>
            {ok ? <Check className="size-3" /> : <X className="size-3" />}
            {t(ok ? 'stream.ok' : 'stream.failed')}
          </span>
        )}
        <span className="flex-1" />
        {/* 折叠着的时候把这一轮干了多少活说出来 —— 一个只写着"过程"的
            三角形，等于没告诉人点开会看到什么。 */}
        {!open && tally !== '' ? (
          <span className="mono flex-none truncate text-[10px] text-ink-faint">{tally}</span>
        ) : null}
      </button>

      {!open ? null : blocks.length === 0 ? (
        <p className="cjk-label px-1 py-2">
          {loading ? t('stream.loading') : live ? t('stream.waiting') : t('stream.empty')}
        </p>
      ) : (
        <div className="space-y-1.5">
          {/* 只拿到了最后一段就说清楚 —— 假装这就是全部，人会以为它当时
              什么都没干就直接下了结论。 */}
          {truncated ? <p className="cjk-label px-1">{t('stream.truncated')}</p> : null}
          {blocks.map((block) => {
            if (block.kind === 'text') {
              return (
                <div key={block.key} className="rounded-lg border border-hairline bg-sunken/40 px-3 py-2 text-[13px]">
                  {renderMarkdown(block.text)}
                </div>
              )
            }
            if (block.kind === 'think') {
              return (
                <div key={block.key} className="flex gap-1.5 px-1 text-[11px] italic text-ink-faint">
                  <Brain className="mt-0.5 size-3 flex-none" />
                  <span className="min-w-0 whitespace-pre-wrap">{block.text.slice(0, SUMMARY_MAX)}</span>
                </div>
              )
            }
            if (block.kind === 'tool') {
              return (
                <div key={block.key} className="flex items-center gap-1.5 px-1 text-[11px] text-ink-faint">
                  <Wrench className="size-3 flex-none" />
                  <span className="mono flex-none text-ink-dim">{block.name}</span>
                  {block.summary === '' ? null : (
                    <span className="mono min-w-0 truncate" title={block.summary}>
                      {block.summary.slice(0, SUMMARY_MAX)}
                    </span>
                  )}
                </div>
              )
            }
            return (
              <div
                key={block.key}
                className={cn('flex gap-1.5 px-1 text-[11px]', block.warn ? 'text-lamp-fail' : 'text-ink-faint')}
              >
                {block.warn ? <TriangleAlert className="mt-0.5 size-3 flex-none" />
                            : <Info className="mt-0.5 size-3 flex-none" />}
                <span className="min-w-0 whitespace-pre-wrap">{block.text}</span>
              </div>
            )
          })}

          {/* 这一轮的脚注：没跑成时那句诊断，以及烧了多少。 */}
          {ok === false && diagnostic !== '' ? (
            <p className="px-1 text-[11px] text-lamp-fail">{diagnostic}</p>
          ) : null}
          {usage.input === 0 && usage.output === 0 ? null : (
            <p className="mono px-1 text-[10px] text-ink-faint">
              in={usage.input} out={usage.output}
              {usage.cost === 0 ? '' : ` $${usage.cost.toFixed(4)}`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
