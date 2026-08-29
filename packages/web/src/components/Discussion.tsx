import { useEffect, useRef, useState } from 'react'
import { Bot, Paperclip, Send, Upload, User } from 'lucide-react'
import { api, ApiError, type NextRound } from '@/api.ts'
import { AttachmentChip } from '@/components/Attachments.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { explain, useT } from '@/lib/i18n.tsx'
import { renderMarkdown } from '@/lib/markdown.tsx'
import { modelOptions } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import type { Agent, Attachment, Task, TaskComment } from '@/types.ts'

/** 与服务端 `MAX_ATTACHMENTS_PER_COMMENT` 对齐。超了服务端也会拒，这里只是先说一声。 */
const MAX_PER_COMMENT = 10

/**
 * 讨论区那两个小下拉。
 *
 * 只可选、不可填 —— 能选的都是探测出来的，手打一个 CLI 不认的名字
 * 只会在派活那一刻才炸。
 */
function Picker({ value, label, disabled, onChange, children }: {
  value: string
  label: string
  disabled: boolean
  onChange: (value: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <select
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => { onChange(event.target.value) }}
      className={cn(
        'mono border-input h-7 max-w-[180px] rounded-md border bg-transparent px-1.5 text-[11px] shadow-xs',
        'transition-[color,box-shadow] outline-none dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </select>
  )
}

/**
 * 讨论线程：Agent 的回复与人的留言按时间排开，底下是输入框。
 *
 * 这条线程不只是给人看的记录 —— 下一次执行会把它整段交给 Agent，所以
 * 「说了什么」和「什么时候说的」都要能对上号。
 *
 * 输入框上还带着「下一轮交给谁、用哪个模型」：说"再改一版"和"这次换个人干"
 * 本来就是同一句话，不该逼人先去规格里存一遍再回来发言。改动跟着这条留言
 * 一起发出去 —— 光换个下拉不发言，等于什么都没说。
 *
 * 也能带附件。贴一张截图问"这儿为什么长这样"，比用文字描述一个界面快得多，
 * 而这种材料十有八九是在往来当中才出现的 —— 逼人回规格表单去传，等于让它
 * 和这句话失去关系。文件**选完就传**（丢一个已经传上去的文件是最恼火的那种
 * 意外），发送时才认领给这条留言。
 */
export function Discussion({
  task, agents, comments, busy, requeues, after, before, scrollKey, mute, onOpenFile, onSend,
}: {
  task: Task
  agents: Agent[]
  comments: TaskComment[]
  busy: boolean
  requeues: boolean
  /**
   * 排在留言后面的东西：这一轮执行的过程、等人拍板的决策。
   *
   * 它们是同一条时间线上的事 —— 摆到别处去，人就得在两个地方之间对时间。
   */
  after?: React.ReactNode
  /**
   * 排在某一条留言**前面**的东西：产出这条留言的那一轮执行。
   *
   * 一张卡跑过好几轮，每一轮的过程要挨着它自己的那条总结 —— 全堆到线程
   * 末尾的话，第一轮的过程会排在第三轮的结论后面，时间线就读反了。
   */
  before?: (comment: TaskComment) => React.ReactNode
  /** 变了就把线程滚到底。`after` 里有活的内容（事件流）时靠它跟住。 */
  scrollKey?: string | number
  /**
   * 有话说不出去的原因。给了就把输入框按住并把这句话摆在下面 ——
   * 执行中的卡就是这样：这会儿该看它干活，或者回答它的问题。
   */
  mute?: string | undefined
  /** 点开回复里的一条文档链接。 */
  onOpenFile: (path: string) => void
  /** 发出去；成功回 null，失败回一句能显示给人看的话（草稿会原样留着）。 */
  onSend: (body: string, next: NextRound, attachmentIds: string[]) => Promise<string | null>
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [provider, setProvider] = useState(task.preferredProvider)
  const [model, setModel] = useState(task.model)
  /** 已经传上去、还没跟着留言发出去的文件。 */
  const [files, setFiles] = useState<Attachment[]>([])
  /** 正在上传的文件名。一个一个传，进度就是"轮到谁了"。 */
  const [uploading, setUploading] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const pickRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // 同规格表单的两种冻结：执行中的卡改了也存不进去，归档的卡内容是冻的。
  // **这只管"下一轮交给谁"那两个下拉**：留言和它带的文件不受这条约束，
  // 它们本来就是留给下一轮的。
  const locked = task.column === 'running' || task.archivedAt !== undefined
  /** 这会儿还能不能再挂一个文件。 */
  const attaching = busy || mute !== undefined || uploading !== null || files.length >= MAX_PER_COMMENT
  const lockReason = task.column === 'running' ? t('editor.lockedRunning') : t('editor.lockedArchived')
  /** 选定的执行器；没选（"任意"）或本机没探测到，就没有模型这一说。 */
  const picked = agents.find((agent) => agent.id === provider)
  const models = picked === undefined ? [] : modelOptions(picked, model)
  // 卡上指定的执行器本机没探测到时也要能选回来 —— 下拉里少了它，
  // 一打开就等于把这张卡的选择改成了别人。
  const providers = provider !== undefined && picked === undefined
    ? [provider, ...agents.map((agent) => agent.id)]
    : agents.map((agent) => agent.id)

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [comments.length, scrollKey])

  // 上次没发出去的草稿附件摆回来：文件已经在服务端了，不摆出来人只会以为
  // 传丢了，然后再传一遍 —— 于是同一张图在讨论里出现两次。
  useEffect(() => {
    let cancelled = false
    void api.attachments(task.id, 'draft')
      .then(({ attachments }) => { if (!cancelled) setFiles(attachments) })
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [task.id])

  // 卡被外部改动（跑完一轮、别处改了规格）后跟上，别拿着旧值去覆盖新状态。
  useEffect(() => {
    setProvider(task.preferredProvider)
    setModel(task.model)
  }, [task.id, task.revision])

  const upload = (picked: FileList | null): void => {
    if (picked === null || picked.length === 0) return
    setFailure(null)
    void (async () => {
      // 一个一个传，不并发：一次拖十个文件并发上去，服务端要同时把十份
      // 字节读进内存，而这里本来就没有"快"的需求。
      for (const file of Array.from(picked)) {
        setUploading(file.name)
        try {
          const created = await api.upload(task.id, file, 'draft')
          setFiles((prev) => [...prev, created])
        } catch (error) {
          // 非 ApiError（host 挂了、连接断了）也要说一句：一声不吭地把
          // 文件吞掉，人只会看着空空的那一行猜到底传上去没有。
          setFailure(error instanceof ApiError
            ? explain(t, error.code, error.message)
            : t('talk.attachFailed'))
          // 一个传失败就停下：多半是超限，剩下的接着传只会连着弹同一条错误。
          break
        } finally {
          setUploading(null)
        }
      }
    })()
  }

  const drop = (attachment: Attachment): void => {
    void api.removeAttachment(attachment.id)
      .then(() => { setFiles((prev) => prev.filter((item) => item.id !== attachment.id)) })
      .catch((error: unknown) => {
        // 同上：撤不掉就得说，否则那个叉点下去没反应，人只会一直点。
        setFailure(error instanceof ApiError
          ? explain(t, error.code, error.message)
          : t('talk.attachRemoveFailed'))
      })
  }

  /**
   * 还在传文件时发不出去。
   *
   * 发送带走的是**此刻**这批草稿的 id，路上那个文件不在其中 —— 它会在留言
   * 认领完之后才落地，于是永远留在草稿里，而人已经看着面板关掉、以为那张图
   * 跟着话走了。宁可让发送键灰一秒。
   */
  const sendable = !busy && mute === undefined && uploading === null && draft.trim().length > 0

  const send = (): void => {
    if (!sendable) return
    const body = draft.trim()
    setFailure(null)
    // 只送真正变了的字段：没动过就别提它，免得白白顶掉一个 revision。
    void onSend(body, {
      ...(provider === task.preferredProvider ? {} : { preferredProvider: provider }),
      ...(model === task.model ? {} : { model }),
    }, files.map((file) => file.id)).then((error) => {
      // 发不出去就把话留在框里。这一段是人一个字一个字敲的，
      // 而"卡刚被人认领了"这种拒绝重试一次就过去了 —— 不该让他重打一遍。
      // 附件同理：它们还是草稿，重试时照样跟着走。
      if (error === null) { setDraft(''); setFiles([]) }
      else setFailure(error)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {comments.map((comment) => (
          <div key={comment.id} className="space-y-1.5">
            {/* 这条留言是哪一轮的产物，那一轮的过程就摆在它上面。 */}
            {before?.(comment)}
            <div className="flex items-center gap-1.5">
              {comment.author === 'agent'
                ? <Bot className="size-3.5 text-sodium" />
                : <User className="size-3.5 text-ink-faint" />}
              <span className={cn(
                'text-xs font-medium',
                comment.author === 'agent' ? 'text-sodium' : 'text-ink',
              )}>
                {comment.author === 'agent' ? 'Agent' : t('talk.you')}
              </span>
              <span className="mono text-[10px] text-ink-faint">
                {new Date(comment.at).toLocaleString()}
              </span>
            </div>
            <div className={cn(
              'rounded-lg border px-3 py-2 text-[13px]',
              comment.author === 'agent'
                ? 'border-hairline bg-sunken/40'
                : 'border-sodium-deep/30 bg-sodium/[0.05]',
            )}>
              {renderMarkdown(comment.body, { onOpenFile })}
              {/* 这条话带的文件就摆在它底下 —— 一张截图脱离了说它的那句话，
                  就只是一张来历不明的图。发出去的撤不回，所以没有那个叉。 */}
              {comment.attachments === undefined || comment.attachments.length === 0 ? null : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {comment.attachments.map((file) => <AttachmentChip key={file.id} file={file} />)}
                </div>
              )}
            </div>
          </div>
        ))}
        {/* 这一轮的过程与等人拍板的事排在留言后面 —— 同一条时间线。 */}
        {after}
        <div ref={bottomRef} />
      </div>

      <div className="flex-none space-y-2 border-t border-hairline px-4 py-3">
        {/* 已带上的文件摆在输入框**上面**：它们是"要说的话的一部分"，
            而输入框底部那行是动作区，混在一起的话长文件名会把整行挤爆。 */}
        {files.length === 0 && uploading === null ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            {uploading === null ? null : (
              <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-hairline px-1.5 py-1 text-[11px] text-ink-faint">
                <Upload className="size-3 animate-pulse" />
                <span className="max-w-40 truncate" title={uploading}>{uploading}</span>
              </span>
            )}
            {files.map((file) => (
              <AttachmentChip
                key={file.id}
                file={file}
                removeLabel={t('talk.attachRemove')}
                onRemove={() => { drop(file) }}
              />
            ))}
            {files.length >= MAX_PER_COMMENT ? (
              <span className="text-xs text-sodium">{t('talk.attachFull', { max: MAX_PER_COMMENT })}</span>
            ) : null}
          </div>
        )}

        {/* 整个输入框都是投放区：人拖着一张截图过来时瞄的是"写字的地方"，
            让他去找一个单独的小方块只是白白多一道手续。 */}
        <div
          className="relative"
          onDragOver={(event) => {
            event.preventDefault()
            if (!attaching) setDragOver(true)
          }}
          onDragLeave={() => { setDragOver(false) }}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
            if (!attaching) upload(event.dataTransfer.files)
          }}
        >
          <Textarea
            value={draft}
            disabled={busy || mute !== undefined}
            placeholder={mute ?? (requeues ? t('talk.placeholderRequeue') : t('talk.placeholder'))}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              // ⌘/Ctrl + Enter 发出去；单独回车留给换行 —— 这里写的是段落，不是聊天。
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
            }}
            // 固定高度：这儿贴在面板底上，跟着内容长会把上面的对话挤没了。
            // 工具条**不叠**在框里 —— 叠进去的话光标一走到底部，字就被那行挡住。
            className={cn('field-sizing-fixed h-24', dragOver && 'border-sodium-deep')}
          />

          {dragOver ? (
            <div className={cn(
              'pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-md',
              // 盖实：底下那句占位文案和"松手就传上去"叠在一起，谁都读不清。
              'border border-dashed border-sodium-deep bg-sunken text-xs text-sodium',
            )}>
              <Upload className="size-3.5" />{t('talk.attachDropActive')}
            </div>
          ) : null}
          <input
            ref={pickRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              upload(event.target.files)
              // 清空，否则同一个文件第二次选不会触发 change。
              event.target.value = ''
            }}
          />
        </div>

        {/* 工具条独占一行，压在输入框**外面**：带上文件、下一轮交给、发送。
            不往框里叠的原因很实际 —— 光标走到底部时，字会被那行盖住。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <button
            type="button"
            disabled={attaching}
            onClick={() => { pickRef.current?.click() }}
            title={t('talk.attach')}
            className={cn(
              'inline-flex flex-none items-center gap-1.5 rounded-md border border-dashed border-hairline px-2 py-1',
              'text-[12px] text-ink-faint transition-colors',
              'hover:border-hairline-bright hover:text-ink',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Paperclip className="size-3.5" />{t('talk.attach')}
          </button>
          {/* 一台 Agent 都没探测到、卡上也没指定过谁：这儿没有可选的，不摆空下拉。 */}
          {providers.length === 0 ? null : (
            <span className="flex items-center gap-1.5" {...(locked ? { title: lockReason } : {})}>
              <span className="flex-none text-xs text-ink-faint">{t('talk.nextRound')}</span>
              <Picker
                value={provider ?? ''}
                disabled={busy || locked}
                label={t('editor.provider')}
                onChange={(next) => {
                  // 换人就把模型清掉：模型名是各家 CLI 自己的说法，
                  // 留着一个别人不认识的名字只会在派活时炸。（同规格表单）
                  setProvider(next.length === 0 ? undefined : next)
                  setModel(undefined)
                }}
              >
                <option value="">{t('editor.providerAny')}</option>
                {providers.map((id) => <option key={id} value={id}>{id}</option>)}
              </Picker>
              {/* 能不能指定模型是**探测**出来的：不认 --model 的 CLI 这儿就没有这一栏。 */}
              {picked === undefined || !picked.canPickModel || models.length === 0 ? null : (
                <Picker
                  value={model ?? ''}
                  disabled={busy || locked}
                  label={t('editor.model')}
                  onChange={(next) => { setModel(next.length === 0 ? undefined : next) }}
                >
                  <option value="">{t('editor.modelDefault')}</option>
                  {models.map((id) => <option key={id} value={id}>{id}</option>)}
                </Picker>
              )}
            </span>
          )}
          <span className="flex-1" />
          {failure === null ? (
            <p
              className="min-w-0 truncate text-xs text-ink-faint"
              title={mute ?? (requeues ? t('talk.noteRequeue') : t('talk.note'))}
            >
              {mute ?? (requeues ? t('talk.noteRequeue') : t('talk.note'))}
            </p>
          ) : (
            <p className="min-w-0 max-w-full truncate text-xs text-lamp-fail" title={failure}>{failure}</p>
          )}
          <Button size="xs" className="flex-none" disabled={!sendable} onClick={send}>
            <Send />{t('talk.send')}
          </Button>
        </div>
      </div>
    </div>
  )
}
