/**
 * 用令牌设置新密码。
 *
 *     POST /api/auth/reset  { token, password }
 *
 * ── 校验顺序（从便宜到昂贵）────────────────────────────────────────
 *   限流 → 参数 → 密码强度 → **抢占令牌** → 写密码 + 撤销全部会话 → 审计
 *
 * 密码强度放在抢占令牌**之前**：否则一个不符合策略的密码会白白烧掉
 * 用户的一次性令牌，他得重新申请一封邮件。这个顺序很容易写反，
 * 而写反的表现是"我第一次输的密码太短，然后链接就失效了"。
 *
 * ── 令牌无效时只报一句话 ────────────────────────────────────────────
 * `consumePasswordReset()` 内部能区分 not_found / used / expired，
 * 但对外一律返回"链接无效或已过期"。区分开来等于告诉探测者
 * "这个令牌存在，只是用过了" —— 那是一次有效的信息泄露。
 * 精确的原因写进日志。
 */
import type { NextRequest } from 'next/server'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { weakPasswordReason } from '@/lib/password-policy'
import { hashPassword } from '@/lib/password'
import { AUDIT, audit } from '@/lib/audit'
import { hashResetToken } from '@/lib/reset-policy'
import { consumePasswordReset, setPasswordAndRevokeSessions } from '@/lib/reset-queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const GENERIC_TOKEN_ERROR = '链接无效或已过期，请重新申请'

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers)

  const limit = consume(`reset:ip:${ip}`, RATE_RULES.resetPassword)
  if (!limit.ok) {
    return jsonResponse(
      { error: '请求过于频繁，请稍后再试', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    )
  }

  let token = ''
  let password = ''
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await req.json()) as Record<string, unknown>
      token = String(body.token ?? '').trim()
      password = String(body.password ?? '')
    } else {
      const form = await req.formData().catch(() => null)
      token = String(form?.get('token') ?? '').trim()
      password = String(form?.get('password') ?? '')
    }
  } catch {
    return errorResponse(400, '请求体解析失败', 'bad_request')
  }

  if (!token) return errorResponse(400, GENERIC_TOKEN_ERROR, 'invalid_token')

  // ★ 强度检查必须在消费令牌之前 ★
  // 否则一次"密码太短"就烧掉了用户的一次性链接
  const weak = weakPasswordReason(password)
  if (weak) return errorResponse(400, weak, 'weak_password')

  const claimed = await consumePasswordReset(hashResetToken(token))
  if (!claimed.ok) {
    // 精确原因只进日志；对外的措辞完全一致
    console.warn(`[reset] 令牌不可用（${claimed.reason}）ip=${ip}`)
    return errorResponse(400, GENERIC_TOKEN_ERROR, 'invalid_token')
  }

  const passwordHash = await hashPassword(password)
  const { revoked } = await setPasswordAndRevokeSessions({
    userId: claimed.userId,
    passwordHash,
  })

  await audit({
    actorId: claimed.userId,
    action: AUDIT.USER_PASSWORD_RESET,
    targetType: 'user',
    targetId: claimed.userId,
    meta: { via: 'email_token', revoked_sessions: revoked },
    ip,
  })

  return jsonResponse({
    ok: true,
    message: '密码已重置，请用新密码登录',
    // 如实告知踢掉了几个会话：用户如果发现数字异常，那本身就是个信号
    revoked_sessions: revoked,
  })
}
