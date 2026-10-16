/**
 * 展示层小工具。
 *
 * 全部做成纯函数，便于在 Server Component 与 Client Component 中共用。
 * 注意：任何 `Date.now()` 相关的格式化都会导致 SSR 与 CSR 输出不一致
 * （React 会报 hydration 警告），因此时间列统一渲染成绝对时间 + <time> 标签，
 * 由客户端脚本选择性地转为相对时间。
 */

/** 相对时间（"3 分钟前"）。只在客户端调用 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  if (diff < 0) return '刚刚'

  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/**
 * 绝对时间。固定用 UTC+8 输出——中国大陆社区的用户预期，
 * 且固定时区可避免服务端与浏览器时区不同导致的 hydration 不一致。
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  return parts
}

/** 头像占位：取用户名首字符。避免为没有头像的用户引入图片请求 */
export function initials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  // 中文取首字，英文取首字母
  return /[\u4e00-\u9fa5]/.test(trimmed[0]!) ? trimmed[0]! : trimmed[0]!.toUpperCase()
}

/** 从用户名派生一个稳定的头像底色，避免所有人都是一样的灰 */
export function avatarHue(id: number | string): number {
  const s = String(id)
  let hash = 0
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) % 360
  }
  return hash
}

/** 频道 URL。集中在这里，将来改路由结构只需改一处 */
export function channelHref(slug: string, opts?: { before?: string; page?: number }): string {
  const base = `/c/${slug}`
  if (!opts?.before) return base
  return `${base}?before=${opts.before}`
}

export function messagePermalink(id: string): string {
  return `/m/${id}`
}
