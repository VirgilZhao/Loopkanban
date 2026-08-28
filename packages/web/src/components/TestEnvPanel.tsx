import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleStop, ExternalLink, FlaskConical, Pencil, Play, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { api, ApiError, subscribeTestEnv } from '@/api.ts'
import { maybe, useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { Project, Task, TestEnv } from '@/types.ts'

/** 屏上最多留多少行日志。再往上翻的价值抵不过把一页 DOM 撑到几万个节点。 */
const MAX_LINES = 400

interface Line {
  seq: number
  stream: 'out' | 'err'
  text: string
}

interface Props {
  task: Task
  /** 启动命令记在项目上 —— 同一个仓库怎么跑起来是仓库的事实。 */
  project: Project | null
  /** 改过项目（存了启动命令）之后让上层重读。 */
  onChanged: () => void
  onError: (code: string, detail: string) => void
}

/**
 * 一键测试环境。
 *
 * 为什么要有它：Review 那一屏只能读 diff，而"这个 feature 做对了没有"很多
 * 时候读不出来 —— 得点开页面自己试。人工试一次要找到那个七层深的 worktree
 * 路径、开终端、装依赖、起服务、还得记着端口别跟主工作区撞上；验完还得记得
 * 回来把它 kill 掉。这里把这几步压成一个按钮。
 *
 * **关掉这个面板就等于说"我验完了"**：日志那条 SSE 连接是服务端判断"还有人
 * 在看"的唯一凭据，断开一分钟之后它会把整棵进程树收掉。所以这里最要紧的一行
 * 代码是 effect 的清理函数 —— 漏了它，那个 dev server 会活到你下次重启电脑。
 */
export function TestEnvPanel({ task, project, onChanged, onError }: Props): React.JSX.Element {
  const t = useT()
  const [env, setEnv] = useState<TestEnv | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  // 正在编辑启动命令时的草稿；null 表示没在编辑。
  const [draft, setDraft] = useState<string | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  /** 新输出到了要不要贴底。判据是用户有没有往回翻，同命令行那块。 */
  const follow = useRef(true)

  const command = project?.testCommand ?? ''
  const live = env !== null && env.status !== 'exited'

  useEffect(() => {
    const node = screenRef.current
    if (node === null || !follow.current) return
    node.scrollTop = node.scrollHeight
  }, [lines])

  /*
   * 面板一打开就问一次：这张卡可能已经有一个跑着的环境 —— 上次关掉面板还没
   * 到一分钟，或者另一个标签页里正开着。此时要接上它，而不是显示"未启动"再
   * 让人点一次启动（那一下会拿回同一个环境，但界面已经骗过人了）。
   */
  useEffect(() => {
    let alive = true
    void api.testEnv(task.id)
      .then(({ env: found }) => { if (alive) setEnv(found) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [task.id])

  /*
   * 订阅日志与状态。**这条连接就是心跳**：组件卸载（关面板、切卡、关标签页）
   * 时它断开，服务端随即开始收尸倒计时。
   *
   * 已经退出的环境也订阅：服务端会把之前的日志补齐，而"它为什么起不来"恰恰
   * 只能从那几行里看出来。对一个已经没有进程的环境来说，这条连接只是让那份
   * 日志多留一会儿 —— 人一走它就跟着清掉。
   *
   * 依赖只看"有没有环境"，不看状态：状态变化本来就从这条连接推过来，
   * 写进依赖会让每一次状态变化都重连一次，日志跟着闪。
   */
  useEffect(() => {
    if (env === null) return
    const stop = subscribeTestEnv(task.id, (event) => {
      if (event.kind === 'status') { setEnv(event.env); return }
      setLines((prev) => [...prev, { seq: event.seq, stream: event.stream, text: event.text }].slice(-MAX_LINES))
    })
    return stop
  }, [task.id, env !== null])

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError) onError(error.code, error.message)
  }, [onError])

  const start = useCallback(() => {
    setBusy(true)
    setLines([])
    follow.current = true
    void api.startTestEnv(task.id)
      .then(({ env: started }) => { setEnv(started) })
      .catch(fail)
      .finally(() => { setBusy(false) })
  }, [task.id, fail])

  const stop = useCallback(() => {
    setBusy(true)
    void api.stopTestEnv(task.id)
      .then(({ env: stopped }) => { setEnv(stopped) })
      .catch(fail)
      .finally(() => { setBusy(false) })
  }, [task.id, fail])

  const saveCommand = useCallback((next: string) => {
    if (project === null) return
    setBusy(true)
    void api.updateProject(project.id, { testCommand: next.trim() })
      .then(() => { setDraft(null); onChanged() })
      .catch(fail)
      .finally(() => { setBusy(false) })
  }, [project, onChanged, fail])

  return (
    <div className="border-b border-hairline px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-3.5 flex-none text-sodium" />
        <span className="chrome-label">{t('testenv.title')}</span>

        {live ? (
          <>
            <StatusPill env={env} />
            {env.url === null ? null : (
              <a
                href={env.url}
                target="_blank"
                rel="noreferrer"
                className="mono inline-flex items-center gap-1 text-[11px] text-sodium underline-offset-2 hover:underline"
              >
                {env.url}
                <ExternalLink className="size-3" />
              </a>
            )}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={stop}
              className="border-lamp-fail/40 text-lamp-fail hover:bg-lamp-fail/10 hover:text-lamp-fail"
            >
              <CircleStop />{t('testenv.stop')}
            </Button>
          </>
        ) : (
          <>
            {env === null ? null : <StatusPill env={env} />}
            <span className="flex-1" />
            {draft === null && command.length > 0 ? (
              <button
                type="button"
                onClick={() => { setDraft(command) }}
                title={t('testenv.edit')}
                aria-label={t('testenv.edit')}
                className="flex size-6 items-center justify-center rounded-md border border-hairline text-ink-faint transition-colors hover:border-sodium hover:text-sodium"
              >
                <Pencil className="size-3" />
              </button>
            ) : null}
            <Button size="sm" disabled={busy || command.length === 0} onClick={start}>
              <Play />{t('testenv.start')}
            </Button>
          </>
        )}
      </div>

      {/* 命令是这个功能唯一要人配的东西。没配就把输入框直接摆在这儿 ——
          让他为此跑一趟项目设置，是在验收的当口打断他。 */}
      {draft !== null || (command.length === 0 && !live) ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); saveCommand(draft ?? '') }}
        >
          <Input
            autoFocus
            value={draft ?? ''}
            disabled={busy || project === null}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('testenv.commandPlaceholder')}
            aria-label={t('testenv.commandLabel')}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              // 回车自己提交。表单的隐式提交在个别环境里不触发（这个面板嵌在
              // 弹窗里就是其中之一），而"敲回车存下这条命令"不该有环境依赖。
              if (event.key !== 'Enter') return
              event.preventDefault()
              saveCommand(draft ?? '')
            }}
            className="mono h-8 text-[11px]"
          />
          <Button type="submit" size="sm" disabled={busy || project === null}>
            {t('testenv.save')}
          </Button>
          {command.length === 0 ? null : (
            <button
              type="button"
              onClick={() => { setDraft(null) }}
              title={t('testenv.cancelEdit')}
              aria-label={t('testenv.cancelEdit')}
              className="flex size-6 flex-none items-center justify-center rounded-md border border-hairline text-ink-faint transition-colors hover:border-sodium hover:text-sodium"
            >
              <X className="size-3" />
            </button>
          )}
        </form>
      ) : null}

      {/* 命令原文一直摆着。它跑在你的机器上、用你的凭据，看不见它才是问题。 */}
      {draft === null && command.length > 0 && !live ? (
        <p className="mono mt-2 truncate text-[11px] text-ink-faint" title={command}>{command}</p>
      ) : null}

      <p className="cjk-label mt-2">
        {command.length === 0 && draft === null ? t('testenv.needCommand') : t('testenv.commandHint')}
      </p>

      {env === null ? null : (
        <>
          <div
            ref={screenRef}
            onScroll={(event) => {
              const node = event.currentTarget
              follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
            }}
            className="mt-2 max-h-56 min-h-16 overflow-y-auto rounded-md border border-hairline bg-void/40 px-3 py-2"
          >
            {lines.length === 0 ? (
              <p className="cjk-label">{t('testenv.logsEmpty')}</p>
            ) : lines.map((line) => (
              <p
                key={line.seq}
                className={cn(
                  'mono break-all whitespace-pre-wrap text-[11px] leading-[1.5]',
                  // stderr 单独标出来：很多工具把进度写在 stderr 上，揉成一股
                  // 就再也分不出"它到底出没出错"。
                  line.stream === 'err' ? 'text-lamp-fail/90' : 'text-ink-dim',
                )}
              >
                {line.text}
              </p>
            ))}
          </div>
          <Outcome env={env} />
        </>
      )}
    </div>
  )
}

/** 状态灯。`running` 是活着但没监听端口 —— 那不是失败，措辞上要分得开。 */
function StatusPill({ env }: { env: TestEnv }): React.JSX.Element {
  const t = useT()
  const tone = env.status === 'ready'
    ? 'border-lamp-ok/40 text-lamp-ok'
    : env.status === 'exited'
      ? 'border-hairline text-ink-faint'
      : 'border-lamp-review/40 text-lamp-review'
  return (
    <span className={cn('chrome-label rounded-full border px-2 py-0.5', tone)}>
      {t(`testenv.status.${env.status}`)}
    </span>
  )
}

/** 环境的收场：是谁收的、退出码是多少。"它自己没了"是最难查的一类问题。 */
function Outcome({ env }: { env: TestEnv }): React.JSX.Element | null {
  const t = useT()
  if (env.status === 'exited') {
    const how = env.stoppedBy === undefined
      ? t('testenv.exited', {
        code: env.signal ?? (env.exitCode === undefined ? '?' : String(env.exitCode)),
      })
      : maybe(t, `testenv.stoppedBy.${env.stoppedBy}`, env.stoppedBy)
    return <p className="cjk-label mt-1.5">{how}</p>
  }
  // 起了但没监听端口：说明这条命令不是个服务（比如 `pnpm test --watch`）。
  // 不说清楚的话，人会一直等一个永远不会出现的链接。
  if (env.status === 'running') return <p className="cjk-label mt-1.5">{t('testenv.noPort')}</p>
  return <p className="cjk-label mt-1.5">{t('testenv.autostop')}</p>
}
