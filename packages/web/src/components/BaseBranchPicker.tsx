import { useEffect, useState } from 'react'
import { api } from '@/api.ts'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'
import type { Project } from '@/types.ts'

interface Props {
  project: Project
  onChange: (branch: string) => void
}

/**
 * 顶栏上的基线分支，点一下就能换。
 *
 * 基线是新增项目时定的，而那时的默认值只是个猜测。猜错了不该只能靠删掉项目
 * 重建来纠正 —— 于是把它做成就地可改的：显示的就是入口。
 *
 * **分支清单等到点开才拉**：每切一个项目就去跑一次 git 只为了填一个多数时候
 * 没人会碰的下拉框，不值得。
 */
export function BaseBranchPicker({ project, onChange }: Props): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[] | null>(null)

  // 换了项目就收起来：上一个仓库的分支清单对这一个毫无意义。
  useEffect(() => { setOpen(false); setBranches(null) }, [project.id])

  if (!open) {
    return (
      <button
        type="button"
        title={t('header.baseHint')}
        className={cn(
          'mono flex-none rounded-sm px-1 text-[10px] text-ink-faint',
          'underline decoration-dotted underline-offset-2 hover:text-ink',
        )}
        onClick={() => {
          setOpen(true)
          // 读不出来（仓库被移走、权限没了）就只剩当前这一条可选 —— 那也是
          // 实话：此刻确实没有别的分支可以给你。
          void api.branches(project.repoPath)
            .then((listing) => { setBranches(listing.branches) })
            .catch(() => { setBranches([]) })
        }}
      >
        {t('header.base', { branch: project.baseBranch })}
      </button>
    )
  }

  // 当前基线始终在清单里 —— 分支被删掉了也得让人看见自己现在挂在哪儿。
  const options = branches === null || branches.includes(project.baseBranch)
    ? branches ?? [project.baseBranch]
    : [project.baseBranch, ...branches]

  return (
    <select
      autoFocus
      value={project.baseBranch}
      disabled={branches === null}
      aria-label={t('header.baseHint')}
      className={cn(
        'mono h-6 flex-none rounded-md border border-hairline bg-transparent px-1 text-[10px] text-ink',
        'outline-none focus-visible:border-ring',
      )}
      onBlur={() => { setOpen(false) }}
      onChange={(event) => {
        const next = event.target.value
        setOpen(false)
        if (next !== project.baseBranch) onChange(next)
      }}
    >
      {options.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
    </select>
  )
}
