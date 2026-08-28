/**
 * Run 事件总线：把落库的事件同时推给正在看的浏览器。
 *
 * 存储是真相，总线只是**通知**。订阅者拿到通知后按 seq 去存储补齐，
 * 所以即使总线丢了一条消息，SSE 重连时的 `Last-Event-ID` 也能把窟窿填上。
 */

import type { RunId } from '@loopkanban/core'
import type { RunEvent } from '../storage/index.ts'

type Listener = (event: RunEvent) => void

export class RunBus {
  private readonly listeners = new Map<string, Set<Listener>>()

  /**
   * 订阅某个 Run 的事件。
   * @param runId - 目标 Run。
   * @param listener - 回调。
   * @returns 取消订阅的函数。
   */
  subscribe(runId: RunId, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(runId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(runId)
    }
  }

  /**
   * 广播一条事件。单个订阅者抛异常不会影响其他订阅者。
   * @param event - 已落库的事件。
   */
  publish(event: RunEvent): void {
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event)
      } catch {
        // 一个订阅者坏掉不能拖垮其他订阅者，更不能影响写入方。
      }
    }
  }

  /** 当前订阅者总数，供诊断。 */
  get size(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}
