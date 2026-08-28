import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { cn } from '@/lib/utils.ts'
import type { Agent, Task, TaskEdit } from '@/types.ts'

interface Props {
  task: Task
  agents: Agent[]
  busy: boolean
  onSave: (edit: TaskEdit) => void
}

/** 表单里持有的草稿。`preferredProvider` 显式允许 undefined —— 「任意」就是它。 */
interface Draft {
  subject: string
  description: string
  acceptance: string[]
  preferredProvider: string | undefined
  writeScopes: string[]
}

/** 从任务取出可编辑的那部分，作为表单初值。 */
function draftOf(task: Task): Draft {
  return {
    subject: task.subject,
    description: task.description,
    acceptance: task.acceptance.length > 0 ? task.acceptance : [''],
    preferredProvider: task.preferredProvider,
    writeScopes: task.writeScopes,
  }
}

export function TaskEditor({ task, agents, busy, onSave }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(() => draftOf(task))
  // 两种冻结，同一套只读：正在执行的、以及归档的。字段上的 disabled 全靠它。
  const locked = task.column === 'running' || task.archivedAt !== undefined
  const lockReason = task.column === 'running'
    ? '正在执行，不能改需求 —— 否则你和 Agent 会对着两份不同的规格。要改先终止执行。'
    : '已归档，内容冻结。要改先从归档里取出。'

  // 卡片被外部改动（打回、执行完成）后重置表单，避免拿着旧值去覆盖新状态。
  useEffect(() => { setDraft(draftOf(task)) }, [task.id, task.revision])

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(task))

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

        <Field label="标题">
          <Input
            value={draft.subject}
            disabled={locked}
            onChange={(e) => { setDraft((d) => ({ ...d, subject: e.target.value })) }}
          />
        </Field>

        <Field label="描述">
          <Textarea
            value={draft.description}
            disabled={locked}
            rows={4}
            onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })) }}
            className="leading-relaxed"
          />
        </Field>

        <Field label="验收标准" hint="Agent 的完成判据，空着就进不了 Ready">
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
        </Field>

        <Field label="指定执行器" hint="不指定就由调度器按可用性挑一个">
          <div className="flex flex-wrap gap-2">
            <Chip
              active={draft.preferredProvider === undefined}
              disabled={locked}
              onClick={() => { setDraft((d) => ({ ...d, preferredProvider: undefined })) }}
            >
              任意
            </Chip>
            {agents.map((agent) => (
              <Chip
                key={agent.id}
                active={draft.preferredProvider === agent.id}
                disabled={locked}
                title={agent.permissionCaveat?.detail}
                onClick={() => { setDraft((d) => ({ ...d, preferredProvider: agent.id })) }}
              >
                {agent.id}
                {agent.permissionCaveat === undefined ? null : (
                  <span className="text-sodium">{agent.permissionCaveat.label}</span>
                )}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="写入范围" hint="建议性，用于并发冲突预警">
          <Input
            value={draft.writeScopes.join(', ')}
            disabled={locked}
            placeholder="src/auth/, docs/"
            className="mono"
            onChange={(e) => {
              setDraft((d) => ({ ...d, writeScopes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))
            }}
          />
        </Field>

        <Field label="仓库">
          <p className="mono text-xs text-ink-faint">{task.repoPath}</p>
          <p className="mono text-xs text-ink-faint">基线 {task.baseBranch}</p>
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
