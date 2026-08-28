import type { Agent, Task } from '@/types.ts'

/** 显示名的长度上限，与领域层一致。 */
const TITLE_MAX = 60

/**
 * 卡片的显示名：描述的第一行。
 *
 * 与 `@loopkanban/core` 的 `taskTitle` 同一套规则 —— 前端不依赖后端包，
 * 只依赖那份契约，所以这里跟着复述一遍。
 *
 * @returns 第一行（截断到 60 字）；一个字都没写时退回任务 id。
 */
export function taskTitle(task: Pick<Task, 'id' | 'description'>): string {
  const first = task.description.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  if (first === undefined) return task.id
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first
}

/**
 * 某个执行器可选的模型。
 *
 * 卡上原有的模型即使不在探测清单里也补进去 —— 清单会随 CLI 升级、随
 * models.dev 变，不该因为它变了就把一张老卡的选择悄悄抹掉。
 */
export function modelOptions(agent: Agent, current: string | undefined): string[] {
  if (current === undefined || agent.models.includes(current)) return agent.models
  return [current, ...agent.models]
}

/**
 * 这张卡是不是"建出来就没动过"。
 *
 * 新卡是先落地、再在弹窗里动笔的（服务端建的是一张空白卡）。所以直接叉掉
 * 弹窗时得能认出"其实什么都没写"，把那张空卡收走 —— 否则想法池里会堆着
 * 一排只有 id 的卡片。
 *
 * 判据是两条一起看：revision 还停在建卡那一版（存过、归档过、挪过都会让它
 * 往前走），并且内容确实还空着。
 */
export function isUntouchedDraft(task: Pick<Task, 'revision' | 'description' | 'acceptance'>): boolean {
  return task.revision === 1
    && task.description.trim().length === 0
    && task.acceptance.every((item) => item.trim().length === 0)
}

/**
 * 卡片右下角那个计时从哪一刻起算。
 *
 * running 的卡从**拿到租约那一刻**起算，其余的卡看 `updatedAt`。
 *
 * 不能一律用 `updatedAt`：长任务每 30 秒续一次租，续租是一次真实的行更新，
 * `updatedAt` 会跟着往前走 —— 于是跑了一小时的卡在看板上永远显示"11s"，
 * 那个数字看着像在跑，其实只是在数心跳。`acquiredAt` 在整个 Run 里不变，
 * 打回重做换来新租约时才重新起算，那正是"这一轮跑了多久"。
 */
export function taskClockFrom(task: Pick<Task, 'column' | 'lease' | 'doneAt' | 'updatedAt'>): number {
  if (task.column === 'running' && task.lease !== undefined) return task.lease.acquiredAt
  if (task.column === 'done') return doneOrder(task)
  return task.updatedAt
}

/**
 * Done 列的排序键：这张卡是什么时候做完的。
 *
 * 迁移之前完成的卡没有 `doneAt`，退回 `updatedAt` —— 它们不会再被改动，
 * 那个时刻通常就是当初验收通过的时刻。同一个式子也喂给卡片右下角的计时，
 * 于是那一列的数字自上而下单调变大，和眼睛看到的顺序对得上。
 */
export function doneOrder(task: Pick<Task, 'doneAt' | 'updatedAt'>): number {
  return task.doneAt ?? task.updatedAt
}
