/**
 * 主题（深色 / 浅色）—— 纯函数，零 import。
 *
 * ── 为什么主题要经过服务端 ──────────────────────────────────────────
 *
 * 如果只在客户端切换（localStorage + useEffect 设置 class），首屏会先按
 * 默认配色画一遍再跳到用户选的配色 —— 也就是"闪白"。深色用户尤其难受：
 * 夜里打开页面先被闪一记白光。
 *
 * 所以选择存在 **Cookie** 里（不是 localStorage），服务端渲染时读出来直接
 * 落成 `<html data-theme="...">`，第一帧就是对的。代价是每次请求多带一个
 * 几十字节的 Cookie，很划算。
 *
 * ── "跟随系统"是默认行为，不是第三档选项 ────────────────────────────
 *
 * Cookie 不存在时**不写 data-theme**，让 CSS 的 `color-scheme: light dark`
 * 按系统偏好走。用户一旦点过切换按钮，就是显式选择，之后不再跟随系统。
 *
 * 这样"未选择"和"选择与系统一致"仍然可以区分 —— 如果你把两者混成一个值，
 * 用户之后改系统主题时会困惑"为什么它不跟了"。
 */

export type Theme = 'light' | 'dark'

/** Cookie 名。带 `bbs_` 前缀，避免与同域下其它应用撞名 */
export const THEME_COOKIE = 'bbs_theme'

/** 一年。主题这种东西不该反复过期，用户也不会希望它自动变回去 */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * 把 Cookie 里的原始字符串解析成主题。
 *
 * 无法识别时返回 `null`（= 未选择，跟随系统），而不是硬给一个默认值：
 * 猜错了会让用户看到与系统相反的主题，而且他没法通过"清除选择"回到自动。
 */
export function parseTheme(raw: string | null | undefined): Theme | null {
  if (raw === 'light' || raw === 'dark') return raw
  return null
}

/** 取反。用于切换按钮 —— 逻辑放在这里，组件里只调它 */
export function nextTheme(current: Theme): Theme {
  return current === 'light' ? 'dark' : 'light'
}

/**
 * 服务端渲染时该往 `<html>` 上写什么。
 * `undefined` 表示不写属性（跟随系统）。
 */
export function htmlThemeAttribute(raw: string | null | undefined): Theme | undefined {
  return parseTheme(raw) ?? undefined
}

/** 拼出 Set-Cookie 的值。与 `src/lib/session.ts` 的属性保持一致的写法 */
export function themeCookieValue(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`
}
