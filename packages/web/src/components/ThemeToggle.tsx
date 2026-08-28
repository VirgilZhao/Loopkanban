import { useCallback, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils.ts'

const KEY = 'openkanban.theme'

/**
 * 明暗切换。首帧的类名由 index.html 里的内联脚本定好，
 * 这里只负责之后的切换与记忆 —— 否则刷新时会闪一下另一套配色。
 */
export function ThemeToggle(): React.JSX.Element {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      document.documentElement.style.colorScheme = next ? 'dark' : 'light'
      try {
        localStorage.setItem(KEY, next ? 'dark' : 'light')
      } catch {
        // 隐私模式下 localStorage 会抛，切换本身仍然有效。
      }
      return next
    })
  }, [])

  return (
    <button
      onClick={toggle}
      aria-label={dark ? '切换到亮色' : '切换到暗色'}
      title={dark ? '切换到亮色' : '切换到暗色'}
      className={cn(
        'flex size-6 items-center justify-center rounded-md border border-hairline text-ink-faint',
        'transition-colors hover:border-sodium hover:text-sodium',
      )}
    >
      {dark ? <Moon className="size-3" /> : <Sun className="size-3" />}
    </button>
  )
}
