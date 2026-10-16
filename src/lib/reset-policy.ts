/**
 * 密码重置令牌的策略层。
 *
 * 只依赖 `node:crypto`（内置模块，脚本能用真实模块名 import），
 * 所以仍然可以被 `scripts/test-reset-policy.mjs` 直接测试。
 *
 * ── 这里最容易写错的四件事 ──────────────────────────────────────────
 *
 * 1. **存 token 还是存哈希** —— 必须存哈希。数据库泄露时，明文 token
 *    等于把所有人的账号直接交出去。
 * 2. **令牌是不是一次性的** —— 必须。否则用户点过的链接会永久留在
 *    浏览器历史、邮件客户端缓存、以及任何日志里。
 * 3. **有没有有效期** —— 必须有，而且不能太长。30 分钟足够走完
 *    "打开邮箱 → 点链接 → 设新密码"，又不足以让一封泄露的邮件长期有效。
 * 4. **错误信息会不会泄露令牌是否存在** —— 对外必须**只说一句**
 *    "链接无效或已过期"。对内（日志、测试）才区分"已用尽"与"已过期"，
 *    否则接口就成了"这个令牌存在吗"的探测器。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 令牌有效期。够走完"打开邮箱 → 点链接 → 设新密码"，又不至于长期有效 */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

/** 32 字节 = 256 位熵，base64url 后 43 字符 */
const TOKEN_BYTES = 32

/**
 * 生成一枚新令牌。
 *
 * @returns `token` 是要发进邮件里的明文（**只在这一刻存在**），
 *          `hash` 是要入库的东西。
 */
export function generateResetToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashResetToken(token) }
}

/** 与 `src/lib/password.ts` 的会话令牌同一套做法：只存 SHA-256 */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function resetExpiry(now: number = Date.now()): Date {
  return new Date(now + RESET_TOKEN_TTL_MS)
}

/**
 * 常量时间比较两个哈希。
 *
 * 数据库查询本身就是按 token_hash 精确匹配的，所以实际用不到这个函数 ——
 * 保留它是为了**在应用层再校验一次**时不要引入时序侧信道。
 * 直接 `===` 比较哈希串会因为提前返回而泄露前缀匹配长度。
 */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export type ResetRecord = {
  expiresAt: Date | number
  usedAt: Date | number | null
}

export type ResetVerdict =
  | { ok: true }
  /** `code` 精确，用于日志与测试；`error` 对外统一，不泄露具体原因 */
  | { ok: false; code: 'used' | 'expired'; error: string }

const GENERIC_ERROR = '链接无效或已过期，请重新申请'

function toMillis(v: Date | number): number {
  return v instanceof Date ? v.getTime() : v
}

/**
 * 令牌是否还能用。
 *
 * 检查顺序刻意的：**先看有没有用过，再看有没有过期**。
 * 反过来会让"已用尽的令牌又过期了"报成 expired，而真正的原因是有人
 * 重复使用了它 —— 那正是最该被注意到的信号。
 */
export function isResetTokenUsable(
  record: ResetRecord,
  now: number = Date.now(),
): ResetVerdict {
  if (record.usedAt !== null && record.usedAt !== undefined) {
    return { ok: false, code: 'used', error: GENERIC_ERROR }
  }
  if (toMillis(record.expiresAt) <= now) {
    return { ok: false, code: 'expired', error: GENERIC_ERROR }
  }
  return { ok: true }
}

/**
 * 邮箱脱敏，用于日志与审计。
 *
 * 审计日志会被很多人看到（包括未来的协作者），而里面没必要出现完整邮箱。
 * `a***@example.com` 已经足够定位是谁，又不构成一份可直接利用的邮箱清单。
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 1) return `*${domain}`
  return `${local[0]}***${domain}`
}

/** 重置邮件正文。抽成纯函数，是为了能断言"链接和有效期确实写进去了" */
export function resetEmailBody(input: {
  handle: string
  link: string
  ttlMinutes?: number
}): { subject: string; text: string } {
  const ttl = input.ttlMinutes ?? Math.round(RESET_TOKEN_TTL_MS / 60_000)
  return {
    subject: '重置你的密码',
    text: [
      `${input.handle}，你好：`,
      '',
      '我们收到了重置这个账号密码的请求。点击下面的链接设置新密码：',
      '',
      input.link,
      '',
      `链接 ${ttl} 分钟内有效，且只能使用一次。`,
      '',
      '如果不是你本人发起的，忽略这封邮件即可 —— 你的密码不会被改动。',
      '',
      '（这是一封系统自动发送的邮件，请勿直接回复。）',
    ].join('\n'),
  }
}
