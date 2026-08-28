import { useEffect, useState } from 'react'
import { ChevronRight, FolderGit2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { cn } from '@/lib/utils.ts'
import type { Agent, Project, Task, TaskEdit } from '@/types.ts'

/**
 * 枚举不出模型时的占位提示。
 *
 * 只在 CLI 自己列不出清单（目前是 codex）时才用得上，给的是"长什么样"，
 * 不是一份要维护的清单。
 */
const MODEL_PLACEHOLDER: Record<string, string> = {
  claude: '例如 opus / sonnet',
  codex: '例如 gpt-5-codex',
  opencode: '例如 anthropic/claude-sonnet-4-5',
}

interface Props {
  task: Task
  /** 任务所属项目；卡片就在它派生出来的 worktree 里干活。 */
  project: Project | null
  agents: Agent[]
  busy: boolean
  onSave: (edit: TaskEdit) => void
}

/** 表单里持有的草稿。`preferredProvider` 显式允许 undefined —— 「任意」就是它。 */
interface Draft {
  description: string
  acceptance: string[]
  preferredProvider: string | undefined
  model: string | undefined
}

/** 从任务取出可编辑的那部分，作为表单初值。 */
function draftOf(task: Task): Draft {
  return {
    description: task.description,
    acceptance: task.acceptance.length > 0 ? task.acceptance : [''],
    preferredProvider: task.preferredProvider,
    model: task.model,
  }
}

export function TaskEditor({ task, project, agents, busy, onSave }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(() => draftOf(task))
  // 两种冻结，同一套只读：正在执行的、以及归档的。字段上的 disabled 全靠它。
  const locked = task.column === 'running' || task.archivedAt !== undefined
  const lockReason = task.column === 'running'
    ? '正在执行，不能改需求 —— 否则你和 Agent 会对着两份不同的规格。要改先终止执行。'
    : '已归档，内容冻结。要改先从归档里取出。'

  // 卡片被外部改动（留言回队列、执行完成）后重置表单，避免拿着旧值去覆盖新状态。
  useEffect(() => { setDraft(draftOf(task)) }, [task.id, task.revision])

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(task))
  /** 选定的执行器；没选就没有模型这一说。 */
  const picked = agents.find((agent) => agent.id === draft.preferredProvider)

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
        <Field label="任务内容" hint="第一行会被当作这张卡的名字">
          <Textarea
            value={draft.description}
            disabled={locked}
            rows={6}
            autoFocus={draft.description.trim().length === 0}
            placeholder="要 Agent 做什么？"
            onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })) }}
            // Textarea 用的是 field-sizing:content，高度跟着内容走、rows 说了不算，
            // 所以要给它更大的起始高度得抬 min-h（rows 只在不支持的浏览器上兜底）。
            className="min-h-32 leading-relaxed"
          />
        </Field>

        {/* 验收标准是可选的，所以默认收起来 —— 没写的时候它不该占着屏幕。 */}
        <Collapsible
          label="验收标准"
          hint="可选。写了 Agent 就照着做、你就照着验；不写也能派活"
          count={draft.acceptance.filter((item) => item.trim().length > 0).length}
          defaultOpen={task.acceptance.length > 0}
        >
          <div className="space-y-2">
            {draft.acceptance.map((item, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={item}
                  disabled={locked}
                  placeholder="一条可判定的标准"
                  onChange={(e) => { setAcceptance(index, e.target.value) }}
                />
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="删除这条"
                  title="删除这条"
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
              <Plus />新增一条
            </Button>
          </div>
        </Collapsible>

        <Field label="指定执行器" hint="不指定就由调度器按可用性挑一个">
          <div className="flex flex-wrap gap-2">
            <Chip
              active={draft.preferredProvider === undefined}
              disabled={locked}
              onClick={() => {
                // 不指定执行器时模型也跟着清掉：模型名是各家 CLI 自己的说法，
                // 留着一个别人不认识的名字只会在派活时炸。
                setDraft((d) => ({ ...d, preferredProvider: undefined, model: undefined }))
              }}
            >
              任意
            </Chip>
            {agents.map((agent) => (
              <Chip
                key={agent.id}
                active={draft.preferredProvider === agent.id}
                disabled={locked}
                title={agent.permissionCaveat?.detail}
                onClick={() => {
                  setDraft((d) => ({
                    ...d,
                    preferredProvider: agent.id,
                    ...(d.preferredProvider === agent.id ? {} : { model: undefined }),
                  }))
                }}
              >
                {agent.id}
                {agent.permissionCaveat === undefined ? null : (
                  <span className="text-sodium">{agent.permissionCaveat.label}</span>
                )}
              </Chip>
            ))}
          </div>
        </Field>

        {/* 只有选定了执行器、且那个 CLI 认 --model 时才出现这一栏。
            能不能指定模型是**探测**出来的，不是写死的。 */}
        {picked === undefined ? null : picked.canPickModel ? (
          <Field
            label="模型"
            hint={picked.models.length > 0
              ? `${picked.id} 报了 ${String(picked.models.length)} 个可用模型；留空就用它自己的默认`
              : `留空用 ${picked.id} 自己的默认模型`}
          >
            {/* 有清单就给建议，但仍然允许自由输入：清单可能不全也可能过期，
                真正认不认由 CLI 说了算。 */}
            <Input
              value={draft.model ?? ''}
              disabled={locked}
              className="mono"
              list={picked.models.length > 0 ? `models-${picked.id}` : undefined}
              placeholder={picked.models.length > 0 ? '点开选，或直接输入' : MODEL_PLACEHOLDER[picked.id] ?? '模型名'}
              onChange={(e) => {
                const next = e.target.value.trim()
                setDraft((d) => ({ ...d, model: next.length === 0 ? undefined : next }))
              }}
            />
            {picked.models.length === 0 ? null : (
              <datalist id={`models-${picked.id}`}>
                {picked.models.map((model) => <option key={model} value={model} />)}
              </datalist>
            )}
          </Field>
        ) : (
          <Field label="模型">
            <p className="text-xs text-ink-faint">
              这个版本的 {picked.id} 没有 <span className="mono">--model</span> 参数，
              只能用它自己的默认模型。
            </p>
          </Field>
        )}

        <Field label="项目" hint="任务在它派生出来的 worktree 里执行，做完再合回基线">
          <div className="rounded-md border border-hairline px-3 py-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <FolderGit2 className="size-3.5 flex-none text-ink-faint" />
              {project?.name ?? '未知项目'}
            </p>
            <p className="mono mt-1 break-all text-xs text-ink-faint">{task.repoPath}</p>
            <p className="mono text-xs text-ink-faint">基线 {task.baseBranch}</p>
          </div>
        </Field>
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-hairline px-4 py-3">
        <span className="text-xs text-ink-faint">{dirty ? '有未保存的改动' : '已保存'}</span>
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
          保存
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

function Chip({ children, active, disabled, onClick, title }: {
  children: React.ReactNode
  active: boolean
  disabled: boolean
  onClick: () => void
  title?: string
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      {...(title === undefined ? {} : { title })}
      className={cn(active && 'border-primary bg-primary/10 text-sodium hover:bg-primary/15 hover:text-sodium')}
    >
      {children}
    </Button>
  )
}
