import type { Task } from '@/types.ts'

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
