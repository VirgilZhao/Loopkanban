import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive, CircleAlert, FolderGit2, GitPullRequest, Hand, Link2, ListChecks, Lock, Paperclip,
  PauseCircle, RotateCw, TriangleAlert,
} from 'lucide-react'
import { summarize } from '@/lib/events.ts'
import { skipMessage, useT } from '@/lib/i18n.tsx'
import { taskClockFrom } from '@/lib/task.ts'
import { cn } from '@/lib/utils.ts'
import type { LiveLine, PendingDecision, PullRequest, RunFailure, Skip, Task } from '@/types.ts'

/** 把毫秒时长压成人能扫一眼的形式。 */
function since(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`
  return `${String(Math.floor(seconds / 3600))}h${String(Math.floor((seconds % 3600) / 60))}m`
}

interface Props {
  task: Task
  now: number
  selected: boolean
  /** 该任务最新的一条执行事件，用于卡片上那行日志预览。 */
  live?: LiveLine | undefined
  /** 调度器这一轮为什么没派它。 */
  skip?: Skip | undefined
  /**
   * 上一轮执行没跑成时的收场。**Review 那一列的卡才有** —— 成败同处一列，
   * 不写出来的话，"干完了等你验"和"压根没跑起来"在看板上长得一模一样。
   */
  failure?: RunFailure | undefined
  /** 所属项目名。只有概览里才给 —— 单项目视图下每张卡都一样，写了是噪音。 */
  projectName?: string | undefined
  /** 挂了几个附件。0 就不显示那枚回形针。 */
  attachments?: number | undefined
  /** 这张卡开过的 PR，新的在前。一条都没有就不显示那枚标记。 */
  prs?: PullRequest[] | undefined
  /** 跑过几轮。0 轮（还没派出去过）就不显示 —— 没发生的事不占卡面。 */
  rounds?: number | undefined
  /** 等人拍板的决策（权限审批 / 提问）。空就不显示。 */
  pending?: PendingDecision[] | undefined
  onSelect: (task: Task) => void
}

export function TaskCard({
  task, now, selected, live, skip, failure, projectName, attachments, prs, rounds, pending, onSelect,
}: Props): React.JSX.Element {
  const t = useT()
  // Done 的卡最该一眼看出"是怎么进主干的"：合过几条 PR。还开着的那些
  // 也算进这个数，但颜色不给亮的 —— 开着不等于合上了。
  const merged = prs?.filter((pr) => pr.state === 'merged') ?? []
  const archived = task.archivedAt !== undefined
  // Done 的卡同样拖不动：那一列是终点（领域层不给它任何出口），顺序也不再由
  // position 决定，而是按完成时间从新到旧排。留着拖拽只会让人拖完看见它弹回去。
  const fixed = archived || task.column === 'done'
  // 归档的卡拖不动 —— 领域层也会拒绝。在这里就关掉拖拽，免得用户拖了半天
  // 只换来一条错误提示。
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id, disabled: fixed,
  })
  const running = task.column === 'running'
  const leaseExpired = task.lease !== undefined && task.lease.expiresAt <= now

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => { onSelect(task) }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        // 卡片形制照抄主题预览里的 card：xl 圆角、发丝边、一层浅影。
        // 不铺底色 —— 让列的面透上来，卡片只靠边和影浮起。
        'group relative cursor-grab overflow-hidden rounded-xl border border-hairline px-3 py-2.5 text-left',
        'shadow-sm transition-[border-color,box-shadow] duration-150',
        'hover:border-hairline-bright hover:shadow-md',
        // 拖不动的卡不摆出"可以抓"的手势。
        fixed && 'cursor-default',
        selected && 'border-sodium-deep ring-1 ring-sodium-deep/30',
        isDragging && 'z-50 cursor-grabbing opacity-90 shadow-lg',
        // 归档的卡是背景板：看得见、认得出，但不参与任何操作。
        archived && 'cursor-default border-dashed opacity-45 shadow-none',
      )}
    >
      {/* 正在执行的卡片带一条持续扫描的轨 —— 与 Running 列头那个转圈一起，是界面里仅有的恒动元素。 */}
      {running && !leaseExpired ? <span className="scan-rail" aria-hidden /> : null}
      {leaseExpired || failure !== undefined
        ? <span className="absolute inset-y-0 start-0 w-0.5 bg-lamp-fail" aria-hidden />
        : null}

      <div className={cn('flex items-center gap-2', running && 'ps-1.5')}>
        <span className="tag">{task.id}</span>
        <span className="flex-1" />
        {archived ? <Archive className="size-3 text-ink-faint" /> : null}
        {task.preferredProvider === undefined ? null : (
          // 指定了模型就一并标出来：覆盖过默认值这件事，一眼看得见才有意义。
          // 但 opencode 的模型 id 能长到 `opencode-go/deepseek-v4-flash`，
          // 不截断就会把整张卡挤成三行 —— 截了，完整的挂在 title 上。
          <span
            className="chrome-label min-w-0 truncate !text-[8px]"
            title={`${task.preferredProvider}${task.model === undefined ? '' : ` · ${task.model}`}`}
          >
            {task.preferredProvider}{task.model === undefined ? '' : ` · ${task.model}`}
          </span>
        )}
        <span className="lamp" data-state={archived ? 'idle' : task.column} />
      </div>

      {/* 卡片正文就是描述本身：任务没有独立标题，两行放不下的用省略号收住。 */}
      {task.description.trim().length === 0 ? (
        <p className={cn('mt-1.5 text-ink-faint/70 italic', running && 'ps-1.5')}>{t('card.empty')}</p>
      ) : (
        <p className={cn('mt-1.5 line-clamp-2 whitespace-pre-wrap text-ink', running && 'ps-1.5')}>
          {task.description.trim()}
        </p>
      )}

      {/* 正在跑的卡给一行日志预览：不打开详情也看得出 Agent 走到哪儿了。
          只留一行 —— 卡片是扫视用的，要读全文去弹窗里的事件流。 */}
      {running && live !== undefined ? (
        <p className="mono mt-1.5 flex items-center gap-1.5 ps-1.5 text-[10px] text-sodium">
          <span className="inline-block size-1 flex-none animate-pulse rounded-full bg-sodium" />
          <span className="min-w-0 truncate" title={summarize({ seq: 0, ...live })}>
            {summarize({ seq: 0, ...live })}
          </span>
        </p>
      ) : null}

      {leaseExpired ? (
        <p className="mono mt-1.5 flex items-center gap-1 ps-1.5 text-[10px] text-lamp-fail">
          <CircleAlert className="size-3" /> {t('card.leaseExpired')}
        </p>
      ) : null}

      {/* Agent 停下来等人了。这是整个看板最不该被错过的一行 —— 它不做任何事，
          就在等一句回答；人不知道的话，这张卡就一直停着。 */}
      {running && pending !== undefined && pending.length > 0 ? (
        <p className="mt-1.5 flex items-center gap-1 ps-1.5 text-[11px] font-medium leading-snug text-sodium">
          <Hand className="size-3 flex-none animate-pulse" />
          {t('card.pendingDecision', { n: pending.length })}
        </p>
      ) : null}

      {/* 这一轮跑挂了。诊断挂在 title 上 —— 卡片是扫视用的，一行说清"它没跑成"
          就够，为什么挂的要去弹窗里读日志。 */}
      {failure === undefined ? null : (
        <p
          title={failure.diagnostic ?? t('card.runFailedHint')}
          className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-lamp-fail"
        >
          <TriangleAlert className="mt-[2px] size-3 flex-none" />
          <span className="min-w-0 truncate">
            {failure.status === 'aborted'
              ? t('card.runAborted', { provider: failure.provider })
              : t('card.runFailed', { provider: failure.provider })}
          </span>
        </p>
      )}

      {/* 「我的卡为什么不动」——调度器跳过它的原因直接写在卡上。 */}
      {skip === undefined ? null : (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-ink-faint">
          <PauseCircle className="mt-[2px] size-3 flex-none" />
          <span className="min-w-0">{skipMessage(t, skip)}</span>
        </p>
      )}

      <div className={cn(
        'mt-2 flex items-center gap-3 border-t border-hairline/60 pt-2 text-ink-faint',
        running && 'ps-1.5',
      )}>
        <span className="mono flex items-center gap-1 text-[10px]">
          <ListChecks className="size-3" />{task.acceptance.length}
        </span>
        {rounds === undefined || rounds === 0 ? null : (
          <span className="mono flex items-center gap-1 text-[10px]" title={t('panel.roundsHint')}>
            <RotateCw className="size-3" />{rounds}
          </span>
        )}
        {task.blockedBy.length > 0 ? (
          <span className="mono flex items-center gap-1 text-[10px] text-lamp-review" title={t('card.blocked')}>
            <Lock className="size-3" />{task.blockedBy.length}
          </span>
        ) : null}
        {attachments === undefined || attachments === 0 ? null : (
          <span className="mono flex items-center gap-1 text-[10px]">
            <Paperclip className="size-3" />{attachments}
          </span>
        )}
        {prs === undefined || prs.length === 0 ? null : (
          <span
            className={cn('mono flex items-center gap-1 text-[10px]', merged.length > 0 && 'text-lamp-ok')}
            title={prs.map((pr) => `#${String(pr.number)} ${pr.state}`).join('\n')}
          >
            <GitPullRequest className="size-3" />
            {merged.length > 0 ? merged.map((pr) => `#${String(pr.number)}`).join(' ') : prs.length}
          </span>
        )}
        {/* 关联用普通色，依赖那把锁是警示色：一个是"还有东西要读"，
            另一个是"这张卡现在动不了"，两者不该长得一样。 */}
        {task.relatedTo.length > 0 ? (
          <span className="mono flex items-center gap-1 text-[10px]" title={t('card.related')}>
            <Link2 className="size-3" />{task.relatedTo.length}
          </span>
        ) : null}
        {projectName === undefined ? null : (
          <span className="flex min-w-0 items-center gap-1 truncate text-[10px]">
            <FolderGit2 className="size-3 flex-none" />{projectName}
          </span>
        )}
        <span className="flex-1" />
        <span className="mono text-[10px]">{since(taskClockFrom(task), now)}</span>
      </div>
    </div>
  )
}
