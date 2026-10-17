'use client'

/**
 * 主题切换按钮。
 *
 * ── 三件必须做对的事 ────────────────────────────────────────────────
 *
 * 1. **读到"当前生效"的主题，而不是 Cookie 里的值。**
 *    用户没选过时 Cookie 是空的，此时生效的是系统偏好。所以初始状态要从
 *    `data-theme` 或 `matchMedia` 推，不能假设默认是深色 —— 否则在浅色
 *    系统上第一次点击不会有任何变化（它把 light 切成 light）。
 *
 * 2. **必须等服务端再渲染图标。**
 *    服务端不知道用户的系统偏好（我们刻意只在有 Cookie 时写 data-theme），
 *    所以首帧只能给一个中性图标。若第一帧就按猜测渲染，hydration 会不一致
 *    并报警告。这里用 `mounted` 挡住。
 *
 * 3. **切换要同时改 DOM 与 Cookie。**
 *    只改 DOM → 刷新后回退成上次的选择；只写 Cookie → 要刷新才生效。
 *    改 DOM 让当前页立刻变，写 Cookie 让下次请求的服务端渲染直接是对的颜色。
 */
import { useCallback, useEffect, useState } from 'react'
import { THEME_COOKIE, nextTheme, parseTheme, themeCookieValue, type Theme } from '@/lib/theme'

function effectiveTheme(): Theme {
  const attr = parseTheme(document.documentElement.dataset.theme)
  if (attr) return attr
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme | null>(null)

  // 首帧不猜：mounted 为 false 时渲染中性样式，避免 hydration 不一致
  useEffect(() => {
    setTheme(effectiveTheme())
  }, [])

  const toggle = useCallback(() => {
    const current = theme ?? effectiveTheme()
    const next = nextTheme(current)

    document.documentElement.dataset.theme = next
    // 不设 HttpOnly：它需要被 JS 写。它也不含任何敏感信息，
    // 伪造它最多让攻击者自己看到另一种配色
    document.cookie = themeCookieValue(next)
    setTheme(next)
  }, [theme])

  const label = theme === null ? '切换主题' : theme === 'light' ? '切换到深色' : '切换到浅色'
  const icon = theme === null ? '◐' : theme === 'light' ? '☾' : '☀'

  return (
    <button
      type="button"
      className={`theme-toggle${compact ? ' compact' : ''}`}
      onClick={toggle}
      title={label}
      aria-label={label}
      // 屏幕阅读器需要知道这是个开关，而不只是一个按钮
      aria-pressed={theme === 'dark'}
    >
      <span className="theme-toggle-icon" aria-hidden>
        {icon}
      </span>
      {!compact && <span className="theme-toggle-text">{theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '主题'}</span>}
    </button>
  )
}
