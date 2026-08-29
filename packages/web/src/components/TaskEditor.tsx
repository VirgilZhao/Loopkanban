import { useEffect, useState } from 'react'
import { ChevronRight, Link2, Lock, Plus, X } from 'lucide-react'
import { Attachments } from '@/components/Attachments.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useT } from '@/lib/i18n.tsx'
import { modelOptions, taskTitle } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import {
  COLUMN_META, PERMISSION_TIERS, type Agent, type PermissionTier, type Task, type TaskEdit,
} from '@/types.ts'

interface Props {
  task: Task
  /**
   * 同项目的其它卡片，可供关联。**只能同项目** —— 任务在这个项目派生的
   * worktree 里干活，指向别的仓库里的卡，Agent 既读不到也用不上。
   */
  siblings: Task[]
  agents: Agent[]
  busy: boolean
  onSave: (edit: TaskEdit) => void
  /** 附件是即时生效的，不进草稿，所以它自己要能报错、能通知外面刷新。 */
  onError: (code: string, detail: string) => void
  onChanged: () => void
}

/** 表单里持有的草稿。`preferredProvider` 显式允许 undefined —— 「任意」就是它。 */
interface Draft {
  description: string
  acceptance: string[]
  preferredProvider: string | undefined
  model: string | undefined
  permission: PermissionTier | undefined
  relatedTo: string[]
  blockedBy: string[]
}

/** 从任务取出可编辑的那部分，作为表单初值。 */
function draftOf(task: Task): Draft {
  return {
    description: task.description,
    acceptance: task.acceptance.length > 0 ? task.acceptance : [''],
    preferredProvider: task.preferredProvider,
    model: task.model,
    permission: task.permission,
    relatedTo: [...task.relatedTo],
    blockedBy: [...task.blockedBy],
  }
}

export function TaskEditor({
  task, siblings, agents, busy, onSave, onError, onChanged,
}: Props): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState(() => draftOf(task))
  // 两种冻结，同一套只读：正在执行的、以及归档的。字段上的 disabled 全靠它。
  const locked = task.column === 'running' || task.archivedAt !== undefined
  const lockReason = task.column === 'running' ? t('editor.lockedRunning') : t('editor.lockedArchived')

  // 卡片被外部改动（留言回队列、执行完成）后重置表单，避免拿着旧值去覆盖新状态。
  useEffect(() => { setDraft(draftOf(task)) }, [task.id, task.revision])

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(task))
  /** 选定的执行器；没选就没有模型这一说。 */
  const picked = agents.find((agent) => agent.id === draft.preferredProvider)
  /** 下拉里的选项；卡上原有的模型即使不在探测清单里也留着。 */
  const options = picked === undefined ? [] : modelOptions(picked, draft.model)
  /** 模型这一栏眼下能不能选：没挑执行器、CLI 不认 --model、清单没探出来，都算不能。 */
  const pickable = picked !== undefined && picked.canPickModel && options.length > 0
  const modelHint = picked === undefined
    ? t('editor.modelNeedProvider')
    : !picked.canPickModel
      ? t('editor.modelUnsupported', { provider: picked.id })
      : options.length === 0
        ? t('editor.modelUnknown', { provider: picked.id })
        : t('editor.modelHint', { count: picked.models.length, provider: picked.id })
  /** 选了指定执行器不支持的档位，就说清楚"执行时会退回 standard" —— 不许诺做不到的事。 */
  const permissionHint = draft.permission !== undefined && picked !== undefined
    && !picked.permissionTiers.includes(draft.permission)
    ? t('editor.permissionUnsupported', { provider: picked.id, tier: draft.permission })
    : t('editor.permissionHint')

  /** 还能关联的卡：同项目、不是自己、也还没关联上。 */
  const linkable = siblings.filter(
    (other) => other.id !== task.id && !draft.relatedTo.includes(other.id),
  )
  /** 还能挂上依赖的卡：同项目、不是自己、也还没挂上。 */
  const blockable = siblings.filter(
    (other) => other.id !== task.id && !draft.blockedBy.includes(other.id),
  )

  const setAcceptance = (index: number, value: string): void => {
    setDraft((d) => ({ ...d, acceptance: d.acceptance.map((item, i) => (i === index ? value : item)) }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {locked ? (
          <p className="rounded-md border border-sodium-deep/40 bg-sodium/[0.06] px-3 py-2 text-sm text-sodium">
            {lockReason}
          </p>
        ) : null}

        {/* 卡片没有标题字段：一句话的活写一句话，复杂的活写一段。
            要显示"叫什么"的地方（分支名、提交信息、通知）取第一行。 */}
        <Field label={t('editor.description')} hint={t('editor.descriptionHint')}>
          <Textarea
            value={draft.description}
            disabled={locked}
            rows={6}
            autoFocus={draft.description.trim().length === 0}
            placeholder={t('editor.descriptionPlaceholder')}
            onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })) }}
            // Textarea 默认 field-sizing:content —— 高度跟着内容走，写长了就把
            // 下面的字段一路顶下去。这里按住不动：固定高度、写满了自己滚。
            // （rows 只在不认 field-sizing 的浏览器上兜底。）
            className="field-sizing-fixed h-40 leading-relaxed"
          />
        </Field>

        {/* 验收标准是可选的，所以默认收起来 —— 没写的时候它不该占着屏幕。 */}
        <Collapsible
          label={t('editor.acceptance')}
          hint={t('editor.acceptanceHint')}
          count={draft.acceptance.filter((item) => item.trim().length > 0).length}
          defaultOpen={task.acceptance.length > 0}
        >
          <div className="space-y-2">
            {draft.acceptance.map((item, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={item}
                  disabled={locked}
                  placeholder={t('editor.acceptancePlaceholder')}
                  onChange={(e) => { setAcceptance(index, e.target.value) }}
                />
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('editor.acceptanceRemove')}
                  title={t('editor.acceptanceRemove')}
                  disabled={locked || draft.acceptance.length === 1}
                  onClick={() => {
                    setDraft((d) => ({ ...d, acceptance: d.acceptance.filter((_, i) => i !== index) }))
                  }}
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={locked}
              onClick={() => { setDraft((d) => ({ ...d, acceptance: [...d.acceptance, ''] })) }}
            >
              <Plus />{t('editor.acceptanceAdd')}
            </Button>
          </div>
        </Collapsible>

        {/* 关联卡片。折叠着 —— 多数卡不需要它，而它一展开就是一串下拉与条目。
            关联是**引用不是依赖**：它不拦调度，只是在派活时把那几张卡的正文
            一起写进 TASK.md，让 Agent 照着已经定下来的东西做。 */}
        <Collapsible
          label={t('editor.related')}
          hint={t('editor.relatedHint')}
          count={draft.relatedTo.length}
          defaultOpen={task.relatedTo.length > 0}
        >
          <div className="space-y-2">
            {draft.relatedTo.map((id) => {
              const other = siblings.find((candidate) => candidate.id === id)
              return (
                <div key={id} className="flex items-center gap-2 rounded-md border border-hairline px-3 py-2">
                  <Link2 className="size-3.5 flex-none text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    {/* 卡刚被删掉时它还留在草稿里 —— 显示 id 而不是装作没这回事，
                        存下去时服务端也会拒；两边都沉默的话，人只会看到关联凭空少了一条。 */}
                    <p className="truncate text-sm text-ink">
                      {other === undefined ? t('editor.relatedGone') : taskTitle(other)}
                    </p>
                    <p className="mono truncate text-xs text-ink-faint">
                      {id}
                      {other === undefined ? '' : ` · ${COLUMN_META[other.column].label}`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('editor.relatedRemove')}
                    title={t('editor.relatedRemove')}
                    disabled={locked}
                    onClick={() => {
                      setDraft((d) => ({ ...d, relatedTo: d.relatedTo.filter((item) => item !== id) }))
                    }}
                  >
                    <X />
                  </Button>
                </div>
              )
            })}
            {linkable.length === 0 ? (
              <p className="text-xs text-ink-faint">
                {siblings.length === 0 ? t('editor.relatedNone') : t('editor.relatedAllPicked')}
              </p>
            ) : (
              <select
                value=""
                disabled={locked}
                onChange={(e) => {
                  const picked = e.target.value
                  if (picked.length === 0) return
                  setDraft((d) => ({ ...d, relatedTo: [...d.relatedTo, picked] }))
                }}
                className={cn(
                  'border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
                  'transition-[color,box-shadow] outline-none dark:bg-input/30',
                  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <option value="">{t('editor.relatedAdd')}</option>
                {linkable.map((other) => (
                  <option key={other.id} value={other.id}>
                    {`${COLUMN_META[other.column].label} · ${taskTitle(other)}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Collapsible>

        {/* 依赖与关联长得像，性质相反：关联是派活时的参考资料，依赖是调度器
            的硬约束 —— blockedBy 里的卡不全部进入 Done，这张卡就不会被派出。
            成环会被服务端拒掉：环上的卡互相等，谁也不会开工。 */}
        <Collapsible
          label={t('editor.blocked')}
          hint={t('editor.blockedHint')}
          count={draft.blockedBy.length}
          defaultOpen={task.blockedBy.length > 0}
        >
          <div className="space-y-2">
            {draft.blockedBy.map((id) => {
              const other = siblings.find((candidate) => candidate.id === id)
              return (
                <div key={id} className="flex items-center gap-2 rounded-md border border-hairline px-3 py-2">
                  <Lock className="size-3.5 flex-none text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    {/* 卡刚被删掉时它还留在草稿里 —— 显示 id 而不是装作没这回事，
                        存下去时服务端也会拒；两边都沉默的话，人只会看到依赖凭空少了一条。 */}
                    <p className="truncate text-sm text-ink">
                      {other === undefined ? t('editor.blockedGone') : taskTitle(other)}
                    </p>
                    <p className="mono truncate text-xs text-ink-faint">
                      {id}
                      {other === undefined ? '' : ` · ${COLUMN_META[other.column].label}`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('editor.blockedRemove')}
                    title={t('editor.blockedRemove')}
                    disabled={locked}
                    onClick={() => {
                      setDraft((d) => ({ ...d, blockedBy: d.blockedBy.filter((item) => item !== id) }))
                    }}
                  >
                    <X />
                  </Button>
                </div>
              )
            })}
            {blockable.length === 0 ? (
              <p className="text-xs text-ink-faint">
                {siblings.length === 0 ? t('editor.blockedNone') : t('editor.blockedAllPicked')}
              </p>
            ) : (
              <select
                value=""
                disabled={locked}
                onChange={(e) => {
                  const picked = e.target.value
                  if (picked.length === 0) return
                  setDraft((d) => ({ ...d, blockedBy: [...d.blockedBy, picked] }))
                }}
                className={cn(
                  'border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
                  'transition-[color,box-shadow] outline-none dark:bg-input/30',
                  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <option value="">{t('editor.blockedAdd')}</option>
                {blockable.map((other) => (
                  <option key={other.id} value={other.id}>
                    {`${COLUMN_META[other.column].label} · ${taskTitle(other)}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Collapsible>

        {/* 附件不折叠：它是"写需求"的一部分 —— 设计稿、报错截图、要照着做的
            那份 PDF，收起来等于让人先想起有这回事才找得到。空着时也只是一行
            提示加一个投放区，不占多少地方。 */}
        <Field label={t('editor.attachments')} hint={t('editor.attachmentsHint')}>
          <Attachments
            taskId={task.id}
            locked={locked}
            onError={onError}
            onChanged={onChanged}
          />
        </Field>

        {/* 执行器与模型并排一行。都是只可选、不可填 —— 能选的都是探测出来的，
            手打一个 CLI 不认的名字只会在派活那一刻才炸。 */}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('editor.provider')} hint={t('editor.providerHint')}>
            <select
              value={draft.preferredProvider ?? ''}
              disabled={locked}
              onChange={(e) => {
                const next = e.target.value
                setDraft((d) => ({
                  ...d,
                  // 不指定执行器时模型也跟着清掉：模型名是各家 CLI 自己的说法，
                  // 留着一个别人不认识的名字只会在派活时炸。
                  preferredProvider: next.length === 0 ? undefined : next,
                  model: next === d.preferredProvider ? d.model : undefined,
                }))
              }}
              className={cn(
                'border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
                'transition-[color,box-shadow] outline-none dark:bg-input/30',
                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <option value="">{t('editor.providerAny')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.permissionCaveat === undefined ? agent.id : `${agent.id} · ${agent.permissionCaveat.label}`}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('editor.model')} hint={modelHint}>
            {/* 没选定执行器、那个 CLI 不认 --model、或者模型清单没探出来：
                三种情况都只给"默认模型"并且按住不动 —— 不是能选的状态就别
                装成能选的。卡上原有的模型即使不在清单里也留着，免得打开一张
                老卡就把它的选择悄悄抹掉。 */}
            <select
              value={draft.model ?? ''}
              disabled={locked || picked === undefined || !pickable}
              title={modelHint}
              onChange={(e) => {
                const next = e.target.value
                setDraft((d) => ({ ...d, model: next.length === 0 ? undefined : next }))
              }}
              className={cn(
                'mono border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
                'transition-[color,box-shadow] outline-none dark:bg-input/30',
                'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <option value="">{t('editor.modelDefault')}</option>
              {options.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </Field>
        </div>

        {/* 权限档位。执行时的边界画在哪儿 —— 是"只许看"还是"要权限先问人"
            还是"放开跑"，是需求的一部分，跟执行器、模型放在一起。 */}
        <Field label={t('editor.permission')} hint={permissionHint}>
          <select
            value={draft.permission ?? ''}
            disabled={locked}
            onChange={(e) => {
              const next = e.target.value
              setDraft((d) => ({
                ...d,
                permission: next.length === 0 ? undefined : (next as PermissionTier),
              }))
            }}
            className={cn(
              'border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs',
              'transition-[color,box-shadow] outline-none dark:bg-input/30',
              'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <option value="">{t('editor.permissionDefault')}</option>
            {PERMISSION_TIERS.map((tier) => (
              <option key={tier} value={tier}>{t(`editor.permission.tier.${tier}`)}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-hairline px-4 py-3">
        <span className="text-xs text-ink-faint">{dirty ? t('editor.dirty') : t('editor.saved')}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={busy || locked || !dirty}
          onClick={() => {
            onSave({
              ...draft,
              acceptance: draft.acceptance.map((s) => s.trim()).filter(Boolean),
            })
          }}
        >
          {t('editor.save')}
        </Button>
      </div>
    </div>
  )
}

/** 一组「标签 + 说明 + 控件」。说明写在标签下面，和主题预览里的卡片一个语序。 */
function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>{label}</Label>
        {hint === undefined ? null : <p className="text-xs text-ink-faint">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

/** 可折叠的一组字段。收起时只留标题那一行，右侧标出里面有几条。 */
function Collapsible({ label, hint, count, defaultOpen, children }: {
  label: string
  hint?: string
  count: number
  defaultOpen: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => { setOpen((on) => !on) }}
        className="flex w-full items-start gap-1.5 text-left"
      >
        <ChevronRight
          className={cn('mt-0.5 size-3.5 flex-none text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <Label className="cursor-pointer">
            {label}
            {count > 0 ? <span className="mono text-xs text-ink-faint">{count}</span> : null}
          </Label>
        </div>
      </button>
      {open ? (
        <div className="space-y-2 ps-5">
          {hint === undefined ? null : <p className="text-xs text-ink-faint">{hint}</p>}
          {children}
        </div>
      ) : null}
    </div>
  )
}
