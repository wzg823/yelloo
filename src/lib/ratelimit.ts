/**
 * 进程内速率限制（滑动窗口）。
 *
 * 单实例部署足够用。多实例时必须换成 Redis，否则每个实例各限各的，
 * 实际额度会乘以实例数。切换点已隔离在 `consume()` 内。
 */

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()
let lastSweep = Date.now()

function sweep(now: number) {
  // 每 5 分钟清一次过期桶，防止 Map 无限增长（这是内存泄漏的常见来源）
  if (now - lastSweep < 300_000) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

export type RateLimitRule = {
  /** 窗口长度，毫秒 */
  windowMs: number
  /** 窗口内允许的次数 */
  max: number
}

/** 预设规则：注册要最严，发帖次之 */
export const RATE_RULES = {
  register: { windowMs: 60 * 60 * 1000, max: 5 },
  login: { windowMs: 15 * 60 * 1000, max: 10 },
  postMessage: { windowMs: 60 * 1000, max: 10 },
  createThread: { windowMs: 60 * 60 * 1000, max: 10 },
  upload: { windowMs: 60 * 60 * 1000, max: 30 },
  report: { windowMs: 60 * 60 * 1000, max: 20 },
  /**
   * 编辑自己的消息。
   *
   * 为什么需要限流：编辑会广播 `message.updated`，反复改同一条消息
   * 就等于在不发新消息的情况下持续占用所有人的屏幕 —— 是一种绕过
   * 发帖限流的刷屏方式。20 次/5 分钟对正常改错字绰绰有余。
   */
  editMessage: { windowMs: 5 * 60 * 1000, max: 20 },
  /** 删除比编辑宽松得多：删错了用户要能立刻删对 */
  deleteMessage: { windowMs: 60 * 60 * 1000, max: 60 },
} satisfies Record<string, RateLimitRule>

export type RateLimitResult = {
  ok: boolean
  remaining: number
  /** 距离窗口重置的毫秒数，用于 Retry-After */
  retryAfterMs: number
}

/**
 * @param key  形如 `postMessage:user:42` 或 `register:ip:1.2.3.4`
 *             必须包含身份维度，否则同一 NAT 出口下的用户会互相拖累
 */
export function consume(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now()
  sweep(now)

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs })
    return { ok: true, remaining: rule.max - 1, retryAfterMs: rule.windowMs }
  }

  if (bucket.count >= rule.max) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.resetAt - now }
  }

  bucket.count += 1
  return { ok: true, remaining: rule.max - bucket.count, retryAfterMs: bucket.resetAt - now }
}

/** 从请求头取客户端 IP（Caddy 会设置 X-Forwarded-For） */
export function clientIp(h: Headers): string {
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip') ||
    '0.0.0.0'
  )
}
