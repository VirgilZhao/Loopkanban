import type { Column, Task } from '@/types.ts'

/**
 * 算出拖放后的新 position。
 *
 * position 是浮点数，插入两张卡之间取中点，因此不必重排整列 ——
 * 一次拖动只写一条记录，CAS 冲突的面也最小。
 *
 * @param tasks - 全部任务。
 * @param moving - 被拖动的卡。
 * @param column - 目标列。
 * @param overTask - 落在哪张卡上；落在空白处则为 null（放到列尾）。
 */
export function insertPosition(
  tasks: readonly Task[], moving: Task, column: Column, overTask: Task | null,
): number {
  const siblings = tasks
    .filter((t) => t.column === column && t.id !== moving.id)
    .sort((a, b) => a.position - b.position)

  if (siblings.length === 0) return 1
  const found = overTask === null ? siblings.length : siblings.findIndex((t) => t.id === overTask.id)
  // findIndex 落空（落点不在本列）时按"放到列尾"处理，而不是悄悄排到列首。
  const index = found < 0 ? siblings.length : found
  if (index === 0) return (siblings[0]?.position ?? 1) - 1
  if (index >= siblings.length) return (siblings.at(-1)?.position ?? 0) + 1

  const before = siblings[index - 1]?.position ?? 0
  const after = siblings[index]?.position ?? before + 2
  return (before + after) / 2
}
