import { useEffect, useState } from 'react'
import { Bot, Check, Pencil, Plus, Star, Trash2, X } from 'lucide-react'
import { api, ApiError } from '@/api.ts'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { explain, useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { Executor, ExecutorProvider, Task } from '@/types.ts'

interface Props {
  /** 全部卡片，用来数"眼下有几张卡指名交给他"。 */
  tasks: Task[]
  /** 执行器有变动（增删改、换默认）—— 看板那份也得跟着换。 */
  onChanged: () => void
}

/** 编辑中的那份表单。新建与改名共用同一份形状。 */
interface Form {
  name: string
  provider: string
  model: string
}

/**
 * 执行器清单。
 *
 * 一个执行器就是「一个名字 + 哪个 CLI + 哪个模型」。这一页做的事很少 ——
 * 增、删、改、指一个默认 —— 但它是整套"交给谁干"的唯一入口：卡上那一栏、
 * 对话里的 `@`、右边那块聊天，说的都是这里定下的名字。
 *
 * 单独成页而不是塞进设置弹窗：这些名字是人每天要用的词，得有个能一眼看全
 * 的地方（谁是默认、谁背后是哪个模型、谁手上有几张卡）。
 */
export function ExecutorsPage({ tasks, onChanged }: Props): React.JSX.Element {
  const t = useT()
  const [executors, setExecutors] = useState<Executor[]>([])
  const [providers, setProviders] = useState<ExecutorProvider[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** 正在编辑谁：`'new'` 是新建，别的是那个 id；null 表示没在编辑。 */
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<Form>({ name: '', provider: '', model: '' })

  const load = (): void => {
    void api.executors()
      .then((loaded) => {
        setExecutors(loaded.executors)
        setProviders(loaded.providers)
        setDefaultId(loaded.defaultId)
      })
      .catch((error: unknown) => { report(error, t('executors.loadFailed')) })
  }

  useEffect(load, [])

  const report = (error: unknown, fallback: string): void => {
    setFailure(error instanceof ApiError ? explain(t, error.code, error.message) : fallback)
  }

  /** 每个执行器手上有几张卡。归档的不算 —— 那些已经不在视野里了。 */
  const assigned = (id: string): number =>
    tasks.filter((task) => task.executorId === id && task.archivedAt === undefined).length

  const startNew = (): void => {
    setFailure(null)
    setEditing('new')
    // CLI 预填第一个：绝大多数机器上只装了一两个，让人再挑一次没有意义。
    setForm({ name: '', provider: providers[0]?.id ?? '', model: '' })
  }

  const startEdit = (executor: Executor): void => {
    setFailure(null)
    setEditing(executor.id)
    setForm({ name: executor.name, provider: executor.provider, model: executor.model ?? '' })
  }

  const submit = (): void => {
    if (form.name.trim().length === 0 || form.provider.length === 0) return
    setBusy(true)
    setFailure(null)
    const done = (): void => {
      setEditing(null)
      load()
      onChanged()
    }
    const request = editing === 'new'
      ? api.createExecutor({
          name: form.name.trim(),
          provider: form.provider,
          ...(form.model.trim().length === 0 ? {} : { model: form.model.trim() }),
        })
      // 模型给 null 而不是省略：省略在服务端是"这次没提到"，清不掉已经填过的那个。
      : api.updateExecutor(editing ?? '', {
          name: form.name.trim(),
          provider: form.provider,
          model: form.model.trim().length === 0 ? null : form.model.trim(),
        })
    void request
      .then(done)
      .catch((error: unknown) => { report(error, t('executors.saveFailed')) })
      .finally(() => { setBusy(false) })
  }

  const remove = (executor: Executor): void => {
    setBusy(true)
    setFailure(null)
    void api.deleteExecutor(executor.id)
      .then((next) => {
        setExecutors(next.executors)
        setDefaultId(next.defaultId)
        onChanged()
      })
      .catch((error: unknown) => { report(error, t('executors.deleteFailed')) })
      .finally(() => { setBusy(false) })
  }

  const makeDefault = (executor: Executor): void => {
    setBusy(true)
    setFailure(null)
    void api.setDefaultExecutor(executor.id)
      .then(({ defaultId: next }) => { setDefaultId(next); onChanged() })
      .catch((error: unknown) => { report(error, t('executors.defaultFailed')) })
      .finally(() => { setBusy(false) })
  }

  /** 这个 CLI 能不能指定模型、有哪些可选 —— 探测出来的事实，不写死。 */
  const picked = providers.find((provider) => provider.id === form.provider)

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <section className={cn(
        'settle flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline',
        'bg-panel shadow-sm',
      )}>
        <header className="flex flex-none items-start gap-2 px-3.5 pb-3 pt-3.5">
          <Bot className="mt-px size-4 flex-none text-ink-faint" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold leading-none text-ink">{t('executors.title')}</h2>
            <p className="mt-1.5 text-xs text-ink-faint">{t('executors.hint')}</p>
          </div>
          <Button
            size="xs"
            disabled={busy || providers.length === 0 || editing === 'new'}
            title={providers.length === 0 ? t('executors.noProviders') : t('executors.new')}
            onClick={startNew}
          >
            <Plus />{t('executors.new')}
          </Button>
        </header>

        {failure === null ? null : (
          <p className="flex-none border-t border-lamp-fail/40 bg-lamp-fail/[0.07] px-3.5 py-2 text-[11px] text-lamp-fail">
            {failure}
          </p>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto border-t border-hairline p-3">
          {providers.length === 0 ? (
            <p className="cjk-label px-1 py-6 text-center">{t('executors.noProviders')}</p>
          ) : null}

          {editing === 'new' ? (
            <Editor
              form={form}
              provider={picked}
              providers={providers}
              busy={busy}
              onChange={setForm}
              onSubmit={submit}
              onCancel={() => { setEditing(null) }}
            />
          ) : null}

          {executors.length === 0 && editing !== 'new' && providers.length > 0 ? (
            <p className="cjk-label px-1 py-6 text-center">{t('executors.empty')}</p>
          ) : null}

          {executors.map((executor) => (
            editing === executor.id ? (
              <Editor
                key={executor.id}
                form={form}
                provider={picked}
                providers={providers}
                busy={busy}
                onChange={setForm}
                onSubmit={submit}
                onCancel={() => { setEditing(null) }}
              />
            ) : (
              <div
                key={executor.id}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border border-hairline px-3 py-2.5',
                  'transition-colors hover:border-hairline-bright',
                  executor.id === defaultId && 'border-sodium-deep/50 bg-sodium/[0.04]',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{executor.name}</span>
                    {executor.id === defaultId ? (
                      <span
                        title={t('executors.defaultHint')}
                        className="chrome-label rounded-md bg-sodium/[0.12] px-1.5 py-0.5 !text-[8px] text-sodium"
                      >
                        {t('executors.default')}
                      </span>
                    ) : null}
                  </div>
                  <p className="mono mt-1 truncate text-[11px] text-ink-faint">
                    {executor.provider}
                    {executor.model === undefined ? ` · ${t('executors.modelDefault')}` : ` · ${executor.model}`}
                  </p>
                </div>

                {assigned(executor.id) === 0 ? null : (
                  <span
                    title={t('executors.tasksHint')}
                    className="mono flex h-6 min-w-6 items-center justify-center rounded-md border border-hairline px-1.5 text-xs tabular-nums text-ink-faint"
                  >
                    {assigned(executor.id)}
                  </span>
                )}

                {executor.id === defaultId ? null : (
                  <Button
                    variant="outline"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={t('executors.setDefault')}
                    title={t('executors.setDefault')}
                    onClick={() => { makeDefault(executor) }}
                  >
                    <Star />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="icon-xs"
                  disabled={busy}
                  aria-label={t('executors.edit')}
                  title={t('executors.edit')}
                  onClick={() => { startEdit(executor) }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="outline"
                  size="icon-xs"
                  disabled={busy}
                  aria-label={t('executors.delete')}
                  title={t('executors.deleteHint')}
                  className="hover:!text-lamp-fail"
                  onClick={() => { remove(executor) }}
                >
                  <Trash2 />
                </Button>
              </div>
            )
          ))}
        </div>
      </section>
    </div>
  )
}

/** 新建 / 修改共用的一行表单。就地展开，不弹窗 —— 三个字段不值得盖住整页。 */
function Editor({ form, provider, providers, busy, onChange, onSubmit, onCancel }: {
  form: Form
  /** 选中的那个 CLI 的探测结果：能不能指定模型、有哪些可选。 */
  provider: ExecutorProvider | undefined
  providers: ExecutorProvider[]
  busy: boolean
  onChange: (form: Form) => void
  onSubmit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const selectClass = cn(
    'border-input h-8 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs',
    'transition-[color,box-shadow] outline-none dark:bg-input/30',
    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
    'disabled:cursor-not-allowed disabled:opacity-50',
  )

  return (
    <div className="space-y-2.5 rounded-xl border border-sodium-deep/50 bg-sodium/[0.04] px-3 py-3">
      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1">
          <span className="chrome-label !text-[8px]">{t('executors.name')}</span>
          <Input
            autoFocus
            value={form.name}
            disabled={busy}
            placeholder={t('executors.namePlaceholder')}
            className="h-8"
            onChange={(event) => { onChange({ ...form, name: event.target.value }) }}
            onKeyDown={(event) => { if (event.key === 'Enter') onSubmit() }}
          />
        </label>
        <label className="space-y-1">
          <span className="chrome-label !text-[8px]">{t('executors.provider')}</span>
          <select
            value={form.provider}
            disabled={busy}
            className={selectClass}
            onChange={(event) => {
              // 换了 CLI 就把模型清掉：模型名是各家自己的说法，
              // 留着一个别人不认识的名字只会在派活时炸。
              onChange({ ...form, provider: event.target.value, model: '' })
            }}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>{item.id}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="chrome-label !text-[8px]">{t('executors.model')}</span>
          {/* 能不能指定模型是**探测**出来的：不认 --model 的 CLI 这儿按住不动。
              清单之外也允许自由输入 —— 那份清单可能不全，认不认由 CLI 说了算。 */}
          <input
            list={`models-${form.provider}`}
            value={form.model}
            disabled={busy || provider?.canPickModel !== true}
            placeholder={t('executors.modelDefault')}
            className={cn(selectClass, 'mono text-[12px]')}
            onChange={(event) => { onChange({ ...form, model: event.target.value }) }}
            onKeyDown={(event) => { if (event.key === 'Enter') onSubmit() }}
          />
          <datalist id={`models-${form.provider}`}>
            {(provider?.models ?? []).map((model) => <option key={model} value={model} />)}
          </datalist>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-ink-faint">{t('executors.nameHint')}</p>
        <Button variant="outline" size="xs" disabled={busy} onClick={onCancel}>
          <X />{t('executors.cancel')}
        </Button>
        <Button size="xs" disabled={busy || form.name.trim().length === 0} onClick={onSubmit}>
          <Check />{t('executors.save')}
        </Button>
      </div>
    </div>
  )
}
