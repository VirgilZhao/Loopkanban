import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * 从 `--version` 的原文里挑出版本号本身。
 *
 * 各家的格式并不一致：claude 是 `2.1.250 (Claude Code)`，codex 是
 * `codex-cli 0.150.1`，opencode 就是 `1.18.24`。所以不能按位置取 ——
 * 掐开头会把 codex 变成 "codex-cli"，掐结尾又会把 claude 变成 "Code)"。
 * 认第一段"数字加点"的东西，认不出就原样给出，宁可长一点也别给错。
 */
export function shortVersion(version: string): string {
  return /\d+(?:\.\d+)*/.exec(version)?.[0] ?? version
}
