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
