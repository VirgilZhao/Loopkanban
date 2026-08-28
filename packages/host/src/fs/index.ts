/**
 * 安全地读本机的一个文件：围栏、上限、二进制判定、截断收尾。
 *
 * 拆成三块，因为调用方要的东西不一样重：
 *
 * - `utf8.ts` —— 一个纯函数。命令行排空管道时也要它，那里没有文件也没有围栏。
 * - `fence.ts` —— 路径在不在给定的一组根里面。目录浏览、跑命令都只要这一块。
 * - `text.ts` —— 读出前 N 字节并如实说明读到了什么。
 *
 * 上面的策略（根是哪些、越界回什么话、二进制是拒绝还是标注）留给调用方：
 * 预览按「这张卡够得着的 worktree 与仓库」，浏览按「已登记项目的仓库」，
 * 那个差别是真的。
 */

export { trimPartialUtf8, decodeUtf8 } from './utf8.ts'
export { contains, confine, refusalFor } from './fence.ts'
export type { Refusal } from './fence.ts'
export { MAX_TEXT_BYTES, readTextHead } from './text.ts'
export type { TextHead, TextFailure, TextResult } from './text.ts'
