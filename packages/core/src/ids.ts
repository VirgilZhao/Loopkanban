/**
 * 带品牌的 id 类型。
 *
 * 这些 id 在运行时都是字符串，互相赋值不会有任何编译错误 —— 品牌类型把
 * 「把 RunId 当成 TaskId 传进去」这类错误提前到编译期。
 */

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type ProjectId = Branded<string, 'ProjectId'>
export type TaskId = Branded<string, 'TaskId'>
export type RunId = Branded<string, 'RunId'>

export const asProjectId = (value: string): ProjectId => value as ProjectId
export const asTaskId = (value: string): TaskId => value as TaskId
export const asRunId = (value: string): RunId => value as RunId
