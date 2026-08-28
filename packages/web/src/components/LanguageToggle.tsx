import { useI18n } from '@/lib/i18n.tsx'
import { cn } from '@/lib/utils.ts'

/**
 * 中英切换。
 *
 * 按钮上写的是**要切过去的那一种** —— 和多数网站的做法一致：中文界面上写
 * "EN"，英文界面上写"中"。写当前语言会让人以为点了没反应。
 */
export function LanguageToggle({ className }: { className?: string }): React.JSX.Element {
  const { lang, setLang, t } = useI18n()
  const label = t('lang.toggle')

  return (
    <button
      type="button"
      onClick={() => { setLang(lang === 'zh' ? 'en' : 'zh') }}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-5 flex-none items-center justify-center rounded border border-hairline px-1.5',
        'text-[10px] font-semibold tracking-wide text-ink-faint',
        'transition-colors hover:border-sodium hover:text-sodium',
        className,
      )}
    >
      {t('lang.short')}
    </button>
  )
}
