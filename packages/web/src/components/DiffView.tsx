import { useMemo } from 'react'
import { cn } from '@/lib/utils.ts'
import type { DiffView as Diff } from '@/types.ts'

interface FileDiff {
  path: string
  hunks: { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string }[]
  added: number
  removed: number
}

/** 把 unified diff 拆成按文件分组的行。 */
function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | null = null

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/x b/x` —— 取 b 侧路径，重命名时它才是新名字。
      const path = line.split(' b/').at(-1) ?? line
      current = { path, hunks: [], added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (current === null) continue
    // 文件头噪音（index/---/+++/new file mode…）对阅读没有帮助。
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue

    if (line.startsWith('@@')) current.hunks.push({ kind: 'hunk', text: line })
    else if (line.startsWith('+')) { current.hunks.push({ kind: 'add', text: line.slice(1) }); current.added += 1 }
    else if (line.startsWith('-')) { current.hunks.push({ kind: 'del', text: line.slice(1) }); current.removed += 1 }
    else current.hunks.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  return files
}

export function DiffView({ diff }: { diff: Diff }): React.JSX.Element {
  const files = useMemo(() => parseDiff(diff.patch), [diff.patch])

  if (diff.patch.trim().length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="cjk-label">这次执行没有产生任何改动</p>
        <p className="mono mt-2 text-[10px] text-ink-faint">{diff.branch}</p>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-hairline px-3 py-1.5">
        <p className="mono text-[10px] text-ink-faint">
          {diff.branch} <span className="text-ink-faint/60">↔</span> {diff.baseBranch}
        </p>
      </div>

      {files.map((file) => (
        <section key={file.path} className="border-b border-hairline/60">
          <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-hairline/60 bg-panel px-3 py-1.5">
            <span className="mono min-w-0 flex-1 truncate text-[11px] text-ink">{file.path}</span>
            <span className="mono text-[10px] text-lamp-ok">+{file.added}</span>
            <span className="mono text-[10px] text-lamp-fail">−{file.removed}</span>
          </header>
          <div className="overflow-x-auto">
            {file.hunks.map((hunk, index) => (
              <div
                key={`${file.path}-${String(index)}`}
                className={cn(
                  'mono flex whitespace-pre text-[11px] leading-[1.5]',
                  hunk.kind === 'add' && 'bg-lamp-ok/[0.08] text-lamp-ok',
                  hunk.kind === 'del' && 'bg-lamp-fail/[0.08] text-lamp-fail',
                  hunk.kind === 'hunk' && 'bg-raised/60 text-ink-faint',
                  hunk.kind === 'ctx' && 'text-ink-dim',
                )}
              >
                {/* 左侧细轨代替 +/- 符号：符号会被误复制进代码里。 */}
                <span
                  className={cn(
                    'w-[3px] flex-none',
                    hunk.kind === 'add' && 'bg-lamp-ok/70',
                    hunk.kind === 'del' && 'bg-lamp-fail/70',
                  )}
                />
                <span className="px-2">{hunk.text || ' '}</span>
              </div>
            ))}
          </div>
        </section>
      ))}

      {diff.truncated ? (
        <p className="cjk-label p-3 !text-lamp-fail">
          改动过大，这里只显示了前一部分。完整补丁在产物目录里。
        </p>
      ) : null}
    </div>
  )
}
