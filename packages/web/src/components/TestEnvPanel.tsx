import { useCallback, useEffect, useRef, useState } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { api, ApiError, subscribeTestEnv } from '@/api.ts'
import { maybe, useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { TestEnv } from '@/types.ts'

/** 屏上最多留多少行日志。再往上翻的价值抵不过把一页 DOM 撑到几万个节点。 */
const MAX_LINES = 400

interface Line {
  seq: number
  stream: 'out' | 'err'
  text: string
}

/** 一张卡的测试环境在界面这边的全部状态与动作。 */
export interface TestEnvHandle {
  env: TestEnv | null
  lines: Line[]
  busy: boolean
  /** 活着（还没退出）。界面上"停止"与"启动"就按它二选一。 */
  live: boolean
  start: () => void
  stop: () => void
}

/**
 * 盯住一张卡的测试环境。
 *
 * **挂在 `RunPanel` 上而不是挂在日志那一栏上**：日志那栏是可以合上的，而这条
 * 订阅一断，服务端就开始收尸倒计时（见 host 侧 `TestEnvs.subscribe`）——
 * 合上一栏日志不该等于"我验完了"，关掉整张卡才是。
 *
 * 启动命令与配置文件**不在这儿配** —— 那是项目的事实，在项目设置里配一次，
 * 所有卡都照着跑（见 `ProjectSettingsDialog`）。
 */
export function useTestEnv({ taskId, enabled, onError }: {
  taskId: string
  /** 这张卡该不该有测试环境（只有 Review 里的卡有）。false 时什么都不做。 */
  enabled: boolean
  onError: (code: string, detail: string) => void
}): TestEnvHandle {
  const [env, setEnv] = useState<TestEnv | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)

  /*
   * 面板一打开就问一次：这张卡可能已经有一个跑着的环境 —— 上次关掉面板还没
   * 到一分钟，或者另一个标签页里正开着。此时要接上它，而不是显示"未启动"再
   * 让人点一次启动（那一下会拿回同一个环境，但界面已经骗过人了）。
   */
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void api.testEnv(taskId)
      .then(({ env: found }) => { if (alive) setEnv(found) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [taskId, enabled])

  /*
   * 订阅日志与状态。**这条连接就是心跳**：组件卸载（关掉这张卡、关标签页）
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
    const stop = subscribeTestEnv(taskId, (event) => {
      if (event.kind === 'status') { setEnv(event.env); return }
      setLines((prev) => [...prev, { seq: event.seq, stream: event.stream, text: event.text }].slice(-MAX_LINES))
    })
    return stop
  }, [taskId, env !== null])

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError) onError(error.code, error.message)
  }, [onError])

  const start = useCallback(() => {
    setBusy(true)
    setLines([])
    void api.startTestEnv(taskId)
      .then(({ env: started }) => { setEnv(started) })
      .catch(fail)
      .finally(() => { setBusy(false) })
  }, [taskId, fail])

  const stop = useCallback(() => {
    setBusy(true)
    void api.stopTestEnv(taskId)
      .then(({ env: stopped }) => { setEnv(stopped) })
      .catch(fail)
      .finally(() => { setBusy(false) })
  }, [taskId, fail])

  return {
    env,
    lines,
    busy,
    live: env !== null && env.status !== 'exited',
    start,
    stop,
  }
}

/**
 * 测试环境的日志：任务弹窗右边的一栏，同文档预览。
 *
 * 为什么不留在卡片里：服务起没起来、报了什么错，要**对着需求看** —— 而卡片
 * 那一栏本来就窄，塞一个滚动的日志框进去，两样东西都只剩一条缝。
 */
export function TestEnvLogPane({ handle, onClose }: {
  handle: TestEnvHandle
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const { env, lines } = handle
  const screenRef = useRef<HTMLDivElement>(null)
  /** 新输出到了要不要贴底。判据是用户有没有往回翻，同命令行那块。 */
  const follow = useRef(true)

  useEffect(() => {
    const node = screenRef.current
    if (node === null || !follow.current) return
    node.scrollTop = node.scrollHeight
  }, [lines])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-s border-hairline bg-panel">
      <header className="flex flex-none items-start gap-2 border-b border-hairline px-4 py-3">
        <FlaskConical className="mt-[3px] size-4 flex-none text-sodium" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{t('testenv.logTitle')}</p>
          <p className="mono truncate text-[10px] text-ink-faint" title={env?.command ?? ''}>
            {env?.command ?? ''}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('testenv.hideLog')} title={t('testenv.hideLog')}>
          <X />
        </Button>
      </header>

      <div
        ref={screenRef}
        onScroll={(event) => {
          const node = event.currentTarget
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-void/40 px-4 py-3"
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

      {env === null ? null : (
        <div className="flex-none border-t border-hairline px-4 py-2">
          <Outcome env={env} />
        </div>
      )}
    </div>
  )
}

/** 环境的收场：是谁收的、退出码是多少。"它自己没了"是最难查的一类问题。 */
function Outcome({ env }: { env: TestEnv }): React.JSX.Element {
  const t = useT()
  if (env.status === 'exited') {
    const how = env.stoppedBy === undefined
      ? t('testenv.exited', {
        code: env.signal ?? (env.exitCode === undefined ? '?' : String(env.exitCode)),
      })
      : maybe(t, `testenv.stoppedBy.${env.stoppedBy}`, env.stoppedBy)
    return <p className="cjk-label">{how}</p>
  }
  // 起了但没监听端口：说明这条命令不是个服务（比如 `pnpm test --watch`）。
  // 不说清楚的话，人会一直等一个永远不会出现的链接。
  if (env.status === 'running') return <p className="cjk-label">{t('testenv.noPort')}</p>
  return <p className="cjk-label">{t('testenv.autostop')}</p>
}
