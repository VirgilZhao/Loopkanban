import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
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
  const locked = task.column === 'running'

  // 卡片被外部改动（打回、执行完成）后重置表单，避免拿着旧值去覆盖新状态。
  useEffect(() => { setDraft(draftOf(task)) }, [task.id, task.revision])

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(task))

  const setAcceptance = (index: number, value: string): void => {
    setDraft((d) => ({ ...d, acceptance: d.acceptance.map((item, i) => (i === index ? value : item)) }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {locked ? (
          <p className="cjk-label mb-3 border border-sodium-deep/40 bg-sodium/[0.06] p-2 !text-sodium">
            正在执行，不能改需求 —— 否则你和 Agent 会对着两份不同的规格。要改先终止执行。
          </p>
        ) : null}

        <Label>标题</Label>
        <input
          value={draft.subject}
          disabled={locked}
          onChange={(e) => { setDraft((d) => ({ ...d, subject: e.target.value })) }}
          className={inputClass}
        />

        <Label>描述</Label>
        <textarea
          value={draft.description}
          disabled={locked}
          rows={4}
          onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })) }}
          className={cn(inputClass, 'resize-y leading-relaxed')}
        />

        <Label>
          验收标准
          <span className="ms-2 !font-normal !text-ink-faint/70">Agent 的完成判据，空着就进不了 Ready</span>
        </Label>
        <div className="space-y-1">
          {draft.acceptance.map((item, index) => (
            <div key={index} className="flex items-center gap-1">
              <span className="mono text-[11px] text-ink-faint">□</span>
              <input
                value={item}
                disabled={locked}
                placeholder="一条可判定的标准"
                onChange={(e) => { setAcceptance(index, e.target.value) }}
                className={cn(inputClass, 'my-0 flex-1')}
              />
              <IconButton
                label="删除这条"
                disabled={locked || draft.acceptance.length === 1}
                onClick={() => {
                  setDraft((d) => ({ ...d, acceptance: d.acceptance.filter((_, i) => i !== index) }))
                }}
              >
                <X className="size-2.5" />
              </IconButton>
            </div>
          ))}
          <IconButton
            label="新增一条" disabled={locked} wide
            onClick={() => { setDraft((d) => ({ ...d, acceptance: [...d.acceptance, ''] })) }}
          >
            <Plus className="size-2.5" />
          </IconButton>
        </div>

        <Label>指定执行器</Label>
        <div className="flex flex-wrap gap-1">
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
                <span className="ms-1 !text-sodium">{agent.permissionCaveat.label}</span>
              )}
            </Chip>
          ))}
        </div>

        <Label>
          写入范围
          <span className="ms-2 !font-normal !text-ink-faint/70">建议性，用于并发冲突预警</span>
        </Label>
        <input
          value={draft.writeScopes.join(', ')}
          disabled={locked}
          placeholder="src/auth/, docs/"
          onChange={(e) => {
            setDraft((d) => ({ ...d, writeScopes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))
          }}
          className={cn(inputClass, 'mono !text-[11px]')}
        />

        <Label>仓库</Label>
        <p className="mono text-[11px] text-ink-faint">{task.repoPath}</p>
        <p className="mono text-[11px] text-ink-faint">基线 {task.baseBranch}</p>
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-hairline px-3 py-2">
        <span className="cjk-label !text-[10px] !text-ink-faint/70">
          {dirty ? '有未保存的改动' : '已保存'}
        </span>
        <span className="flex-1" />
        <button
          disabled={busy || locked || !dirty}
          onClick={() => {
            onSave({
              ...draft,
              acceptance: draft.acceptance.map((s) => s.trim()).filter(Boolean),
            })
          }}
          className={cn(
            'cjk-label border px-2.5 py-1 !text-[11px] transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-40',
            dirty ? 'border-sodium !text-sodium hover:bg-sodium/10' : 'border-hairline',
          )}
        >
          保存
        </button>
      </div>
    </div>
  )
}

/** 裸输入框：只留一条发丝下划线，和整套面板的语言一致。 */
const inputClass = cn(
  'my-1 w-full rounded-[2px] border border-hairline bg-void px-2 py-1 text-[12px] text-ink',
  'placeholder:text-ink-faint/50 focus:border-sodium-deep focus:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-50',
)

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="cjk-label mb-1 mt-4 !text-[10px] first:mt-0">{children}</h3>
}

function IconButton({ children, onClick, disabled, label, wide }: {
  children: React.ReactNode
  onClick: () => void
  disabled: boolean
  label: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-5 items-center justify-center border border-hairline text-ink-faint transition-colors',
        'hover:border-sodium hover:text-sodium disabled:opacity-30 disabled:hover:border-hairline',
        wide ? 'w-full' : 'w-5 flex-none',
      )}
    >
      {children}
    </button>
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
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'chrome-label border px-2 py-1 transition-colors disabled:opacity-40',
        active ? 'border-sodium !text-sodium' : 'border-hairline hover:border-hairline-bright hover:!text-ink-dim',
      )}
    >
      {children}
    </button>
  )
}
