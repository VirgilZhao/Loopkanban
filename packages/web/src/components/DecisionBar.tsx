import { useState } from 'react'
import { Check, Hand, KeyRound, Send, X } from 'lucide-react'
import { api } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useT } from '@/lib/i18n.tsx'
import type { RunDecision } from '@/types.ts'

/**
 * 等人拍板的决策卡：Agent 的权限请求与提问都摆在这里。
 *
 * 放在所有分页之上，是因为它的时间敏感性压倒一切 —— Agent 此刻什么都没
 * 干，就在等这一眼。权限卡把要跑的工具与参数原样摆出来（人拍板看的是
 * 事实，不是转述）；提问卡给候选按钮加一个自由输入框 —— 候选是模型猜的
 * 答案，不是人只能选的选项。
 */
export function DecisionBar({ runId, decisions, onReport }: {
  runId: string
  decisions: RunDecision[]
  onReport: (error: unknown) => void
}): React.JSX.Element {
  const t = useT()
  /** 正在提交的是哪条。同一时刻每条都该可点，但提交中的那条要按住。 */
  const [resolving, setResolving] = useState<string | null>(null)
  /** 提问的草稿按决策 id 分开存 —— 多条提问并存时互不串台。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const send = (id: string, input: { decision?: 'allow' | 'deny'; scope?: 'once' | 'run'; answer?: string }): void => {
    setResolving(id)
    void api.resolveDecision(runId, id, input)
      .catch(onReport)
      .finally(() => { setResolving(null) })
  }

  return (
    <div className="flex-none divide-y divide-hairline border-b border-hairline bg-sodium/[0.04]">
      {decisions.map((decision) => {
        if (decision.kind === 'permission') {
          const tool = String(decision.payload['tool'] ?? '?')
          const input = decision.payload['input']
          return (
            <div key={decision.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <KeyRound className="size-3.5 flex-none text-sodium" />
                <span className="chrome-label">{t('decision.permissionTag')}</span>
                <span className="mono min-w-0 truncate text-xs font-medium text-ink" title={tool}>{tool}</span>
                <span className="flex-1" />
                <span className="mono flex-none text-[10px] text-ink-faint">{t('decision.timeoutHint')}</span>
              </div>
              {input === undefined || (typeof input === 'object' && Object.keys(input as object).length === 0) ? null : (
                <pre className="mono mt-2 max-h-32 overflow-y-auto rounded-md border border-hairline bg-sunken/60 p-2 text-[11px] leading-relaxed text-ink-faint">
                  {JSON.stringify(input, null, 2)}
                </pre>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Button
                  size="xs"
                  disabled={resolving !== null}
                  onClick={() => { send(decision.id, { decision: 'allow' }) }}
                >
                  <Check />{t('decision.allow')}
                </Button>
                <Button
                  variant="outline" size="xs"
                  disabled={resolving !== null}
                  title={t('decision.allowRunHint')}
                  onClick={() => { send(decision.id, { decision: 'allow', scope: 'run' }) }}
                >
                  {t('decision.allowRun')}
                </Button>
                <Button
                  variant="outline" size="xs"
                  disabled={resolving !== null}
                  className="border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail"
                  onClick={() => { send(decision.id, { decision: 'deny' }) }}
                >
                  <X />{t('decision.deny')}
                </Button>
              </div>
            </div>
          )
        }

        const question = String(decision.payload['question'] ?? '')
        const choices = Array.isArray(decision.payload['choices'])
          ? (decision.payload['choices'] as unknown[]).filter((c): c is string => typeof c === 'string')
          : []
        const draft = drafts[decision.id] ?? ''
        return (
          <div key={decision.id} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <Hand className="size-3.5 flex-none text-sodium" />
              <span className="chrome-label">{t('decision.questionTag')}</span>
              <span className="flex-1" />
              <span className="mono flex-none text-[10px] text-ink-faint">{t('decision.timeoutHint')}</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{question}</p>
            {choices.length === 0 ? null : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {choices.map((choice) => (
                  <Button
                    key={choice}
                    variant="outline" size="xs"
                    disabled={resolving !== null}
                    onClick={() => { send(decision.id, { answer: choice }) }}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-end gap-2">
              <Textarea
                value={draft}
                disabled={resolving !== null}
                placeholder={t('decision.answerPlaceholder')}
                onChange={(e) => { setDrafts((prev) => ({ ...prev, [decision.id]: e.target.value })) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim().length > 0) {
                    send(decision.id, { answer: draft.trim() })
                  }
                }}
                className="field-sizing-fixed h-16 text-[13px]"
              />
              <Button
                size="xs"
                disabled={resolving !== null || draft.trim().length === 0}
                onClick={() => { send(decision.id, { answer: draft.trim() }) }}
              >
                <Send />{t('decision.answer')}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
