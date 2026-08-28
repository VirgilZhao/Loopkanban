import { useCallback, useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useT } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'

const KEY = 'loopkanban.theme'

/** 用户手动选过的明暗；没选过（或读不到）返回 null，此时以系统为准。 */
function storedTheme(): 'dark' | 'light' | null {
  let value: string | null = null
  try {
    value = localStorage.getItem(KEY)
  } catch {
    // 隐私模式下 localStorage 会抛。当作没选过。
  }
  return value === 'dark' || value === 'light' ? value : null
}

/**
 * 明暗切换。首帧的类名由 index.html 里的内联脚本定好，
 * 这里只负责之后的切换与记忆 —— 否则刷新时会闪一下另一套配色。
 *
 * 默认跟随系统，且是**活的**：没手动切换过时，用户在系统设置里改了外观，
 * 开着的页面立刻跟上，不用刷新。一旦手动切过，那次选择就压过系统。
 */
export function ThemeToggle(): React.JSX.Element {
  const t = useT()
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  // state 是唯一真相，DOM 跟着它走。
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const follow = (): void => {
      if (storedTheme() === null) setDark(media.matches)
    }
    // 先对一次：内联脚本跑过之后系统外观也可能已经变了。
    follow()
    media.addEventListener('change', follow)
    return () => { media.removeEventListener('change', follow) }
  }, [])

  const toggle = useCallback(() => {
    const next = !dark
    setDark(next)
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light')
    } catch {
      // 隐私模式下存不下，切换本身仍然有效，只是刷新后回到跟随系统。
    }
  }, [dark])

  return (
    <button
      onClick={toggle}
      aria-label={dark ? t('theme.toLight') : t('theme.toDark')}
      title={dark ? t('theme.toLight') : t('theme.toDark')}
      className={cn(
        'flex size-6 items-center justify-center rounded-md border border-hairline text-ink-faint',
        'transition-colors hover:border-sodium hover:text-sodium',
      )}
    >
      {dark ? <Moon className="size-3" /> : <Sun className="size-3" />}
    </button>
  )
}
