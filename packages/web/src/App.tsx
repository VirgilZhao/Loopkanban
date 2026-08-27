import { useCallback, useEffect, useMemo, useState } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { api, ApiError } from '@/api.ts'
import { Column } from '@/components/Column.tsx'
import { RunPanel } from '@/components/RunPanel.tsx'
import { cn } from '@/lib/utils.ts'
import { COLUMNS, type Agent, type Column as ColumnKey, type Task } from '@/types.ts'

/** 卡片上的时长要走字，但每秒重渲染整块看板没必要，5 秒一次足够。 */
const CLOCK_MS = 5_000

/**
 * 领域错误码 → 用户能照做的说明。
 *
 * 拖拽被拒时卡片会弹回原位，如果不解释清楚，用户只会觉得"拖不动"。
 * 所以这里给的不是错误名，而是下一步该做什么。
 */
const ERROR_HINT: Record<string, string> = {
  'acceptance-required': '这张卡还没有验收标准。补上之后才能进 Ready —— 否则 Agent 干完了也没人能判定对不对。',
  'illegal-transition': '不允许这样跨列。流转顺序是 Backlog → Ready → Running → Review → Done。',
  'blocked-by-dependency': '它依赖的任务还没完成。',
  'lease-held': '这张卡正被某个 Agent 持有，等它跑完或超时释放。',
  'revision-conflict': '这张卡刚被改动过，已为你重新加载。',
  'provider-unavailable': '这个 Agent CLI 本机没有探测到。装好它，或者换一个。',
  'launch-failed': '起进程失败。多半是 worktree 建不出来 —— 检查仓库路径和基线分支。',
  'no-runner': '当前实例没有启用执行器，只能看板不能派活。',
  'feedback-required': '打回要写明改什么，否则 Agent 只会把上次的活重做一遍。',
  'dirty-worktree': '你的主工作区有未提交改动，先处理干净再合并。改动已经提交在任务分支上，不会丢。',
  'wrong-branch': '你的主工作区不在基线分支上。改动已经提交在任务分支上，切回去再合并即可。',
  'no-run': '这张卡还没有执行记录。',
}

export default function App(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [liveTools, setLiveTools] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    const { tasks: loaded } = await api.state()
    setTasks(loaded)
  }, [])

  useEffect(() => {
    void refresh()
    void api.agents().then(({ agents: found }) => { setAgents(found) })
  }, [refresh])

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, CLOCK_MS)
    return () => { clearInterval(timer) }
  }, [])

  // Run 结束时卡片会自己换列（running → review/failed），界面必须跟上。
  // 有 Agent 在跑时盯紧一点，闲着时放慢，别白烧 CPU。
  useEffect(() => {
    const busy = tasks.some((t) => t.column === 'running')
    const timer = setInterval(() => { void refresh() }, busy ? 1_500 : 6_000)
    return () => { clearInterval(timer) }
  }, [tasks, refresh])

  useEffect(() => {
    // 只有信息类提示自动消失；被拒绝的操作要留在屏幕上，
    // 否则用户看到的只是"卡片弹回去了"而没有原因。
    if (notice === null || notice.tone === 'warn') return undefined
    const timer = setTimeout(() => { setNotice(null) }, 4_000)
    return () => { clearTimeout(timer) }
  }, [notice])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const byColumn = useMemo(() => {
    const grouped = Object.fromEntries(COLUMNS.map((c) => [c, [] as Task[]])) as Record<ColumnKey, Task[]>
    for (const task of tasks) grouped[task.column].push(task)
    for (const list of Object.values(grouped)) list.sort((a, b) => a.position - b.position)
    return grouped
  }, [tasks])

  const selected = tasks.find((t) => t.id === selectedId) ?? null

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const target = event.over?.id
    if (typeof target !== 'string') return
    const task = tasks.find((t) => t.id === event.active.id)
    if (task === undefined || task.column === target) return

    // 乐观更新，失败时用服务端的真相覆盖回来。
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, column: target as ColumnKey } : t)))
    try {
      const { task: updated } = await api.move(task.id, task.revision, target)
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (error) {
      if (error instanceof ApiError) {
        setNotice({
          text: ERROR_HINT[error.code] ?? `${error.code} · ${error.message}`,
          tone: error.status === 409 ? 'info' : 'warn',
        })
      }
      await refresh()
    }
  }, [tasks, refresh])

  const onLiveTool = useCallback((taskId: string, tool: string | undefined) => {
    setLiveTools((prev) => {
      if (tool === undefined) {
        const { [taskId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [taskId]: tool }
    })
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const runningCount = byColumn.running.length

  return (
    <div className="flex h-full flex-col">
      {/* ── 顶栏：产品标识 + 本机 Agent 状态 ───────────────────── */}
      <header className="flex flex-none items-center gap-4 border-b border-hairline px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[15px] font-semibold tracking-tight text-ink"
            style={{ fontFamily: 'var(--font-chrome)' }}
          >
            OPEN<span className="text-sodium">KANBAN</span>
          </span>
          <span className="chrome-label !text-[8px]">agent dispatch</span>
        </div>

        <div className="h-4 w-px bg-hairline" />

        {/* 探测到的 CLI —— 没探测到的 provider 不会出现，任务也选不到它。 */}
        <div className="flex items-center gap-3">
          {agents.length === 0 ? (
            <span className="cjk-label !text-lamp-fail">未探测到 Agent CLI</span>
          ) : agents.map((agent) => (
            <div key={agent.id} className="flex items-center gap-1.5" title={`${agent.bin}\n${agent.version}`}>
              <span className="lamp" data-state="done" />
              <span className="chrome-label !text-ink-dim">{agent.id}</span>
              <span className="mono text-[10px] text-ink-faint">
                {/^[\d.]+/.exec(agent.version)?.[0] ?? agent.version}
              </span>
              {agent.canResume ? null : (
                <span className="cjk-label !text-[10px] !text-lamp-fail">无续跑</span>
              )}
            </div>
          ))}
        </div>

        <span className="flex-1" />

        <div className="flex items-center gap-1.5">
          <span className={cn('lamp', runningCount > 0 && '')} data-state={runningCount > 0 ? 'running' : 'idle'} />
          <span className="chrome-label">running</span>
          <span className="mono text-[11px] text-ink">{runningCount}</span>
        </div>
      </header>

      {notice === null ? null : (
        <div className={cn(
          'flex flex-none items-center gap-3 border-b px-4 py-2',
          notice.tone === 'warn'
            ? 'border-lamp-fail/40 bg-lamp-fail/[0.07]'
            : 'border-sodium-deep/50 bg-sodium/[0.07]',
        )}>
          <span className="lamp" data-state={notice.tone === 'warn' ? 'failed' : 'running'} />
          <span className={cn('flex-1', notice.tone === 'warn' ? 'text-lamp-fail' : 'text-sodium')}>
            {notice.text}
          </span>
          <button
            onClick={() => { setNotice(null) }}
            className="chrome-label border border-current/30 px-1.5 py-0.5 opacity-70 transition-opacity hover:opacity-100"
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── 看板 + 详情面板 ────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <DndContext sensors={sensors} onDragEnd={(e) => { void handleDragEnd(e) }}>
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {COLUMNS.map((column, index) => (
              <Column
                key={column}
                column={column}
                index={index}
                tasks={byColumn[column]}
                now={now}
                selectedId={selectedId}
                liveTools={liveTools}
                onSelect={(task) => { setSelectedId(task.id) }}
              />
            ))}
          </div>
        </DndContext>

        {selected === null ? null : (
          <RunPanel
            task={selected}
            agents={agents}
            onLiveTool={onLiveTool}
            onChanged={() => { void refresh() }}
            onError={(code, detail) => {
              setNotice({ text: ERROR_HINT[code] ?? `${code} · ${detail}`, tone: 'warn' })
            }}
            onClose={() => { setSelectedId(null) }}
          />
        )}
      </div>
    </div>
  )
}
