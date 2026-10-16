/**
 * 申请密码重置。
 *
 *     POST /api/auth/forgot  { email }
 *
 * ── 这个接口最重要的一条性质：**不泄露邮箱是否存在** ────────────────
 *
 * 无论邮箱有没有注册过，响应必须**完全一致**（同一句话、同一个状态码）。
 * 否则它就成了账号枚举工具：攻击者可以先跑一遍常见邮箱，筛出真实用户，
 * 再对这些账号做定向撞库或钓鱼。
 *
 * 而且"发信失败"也不能改变响应 —— 那同样是一个可观测的信号。
 * 邮件发送的结果只进日志，不回给调用方。
 *
 * ── 另一个刻意的设计：邮箱不存在时也写审计 ──────────────────────────
 * 只在成功时记录的话，审计表本身就变成了"哪些邮箱存在"的清单。
 * 邮箱不存在时记一条 actorId 为 null 的请求，让两种情况的痕迹一致。
 */
import type { NextRequest } from 'next/server'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { AUDIT, audit } from '@/lib/audit'
import { sendMail } from '@/lib/mailer'
import {
  generateResetToken,
  maskEmail,
  resetEmailBody,
  resetExpiry,
} from '@/lib/reset-policy'
import { createPasswordReset, findUserForReset } from '@/lib/reset-queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 对外的**唯一**响应。所有分支都返回它。
 *
 * 措辞刻意用"如果该邮箱已注册"而不是"邮件已发送"：前者如实说明
 * 我们不知道（也不打算告诉）这个邮箱有没有注册。
 */
const GENERIC_RESPONSE = { ok: true, message: '如果该邮箱已注册，我们已发送重置邮件' }

function siteUrl(req: NextRequest): string {
  const configured = process.env.SITE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  // 兜底：从请求头推断，避免本地开发时链接指到 example.com
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host = req.headers.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers)

  // 按 IP 限流。这个接口会发邮件，不限流就是一个免费的骚扰工具，
  // 而且会烧掉邮件服务的额度
  const limit = consume(`forgot:ip:${ip}`, RATE_RULES.forgotPassword)
  if (!limit.ok) {
    return jsonResponse(
      { error: '请求过于频繁，请稍后再试', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    )
  }

  let email = ''
  try {
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await req.json()) as Record<string, unknown>
      email = String(body.email ?? '').trim().toLowerCase()
    } else {
      const form = await req.formData().catch(() => null)
      email = String(form?.get('email') ?? '').trim().toLowerCase()
    }
  } catch {
    return errorResponse(400, '请求体解析失败', 'bad_request')
  }

  // 邮箱格式明显不对时直接回同一个响应：连格式校验的错误信息都不给，
  // 避免任何"这次和上次不一样"的差异
  if (!email || email.length > 254 || !email.includes('@')) {
    return jsonResponse(GENERIC_RESPONSE)
  }

  const user = await findUserForReset(email)

  await audit({
    actorId: user?.id ?? null,
    action: AUDIT.USER_PASSWORD_RESET_REQUEST,
    targetType: 'user',
    // 邮箱不存在时没有 targetId，用脱敏后的邮箱占位，保证两种情况的记录形状一致
    targetId: user ? String(user.id) : `unknown:${maskEmail(email)}`,
    meta: { email: maskEmail(email), found: Boolean(user) },
    ip,
  })

  if (!user) return jsonResponse(GENERIC_RESPONSE)

  // 被封禁的账号不发重置邮件，但**响应不变** —— 否则"这个邮箱被封了"
  // 也成了一个可探测的信息
  if (user.status === 'banned') {
    console.warn(`[forgot] 已封禁账号申请重置，忽略：${maskEmail(email)}`)
    return jsonResponse(GENERIC_RESPONSE)
  }

  const { token, hash } = generateResetToken()
  await createPasswordReset({
    userId: user.id,
    tokenHash: hash,
    expiresAt: resetExpiry(),
    requestedIp: ip,
  })

  const link = `${siteUrl(req)}/reset?token=${encodeURIComponent(token)}`
  const body = resetEmailBody({ handle: user.handle, link })
  const sent = await sendMail({ to: user.email, subject: body.subject, text: body.text })

  // 发信结果只进日志，绝不进响应
  if (sent.ok) {
    console.info(`[forgot] 重置邮件已交给通道 ${sent.transport}：${maskEmail(email)}`)
  } else {
    console.error(`[forgot] 重置邮件发送失败（${sent.transport}）：${sent.error}`)
  }

  return jsonResponse(GENERIC_RESPONSE)
}
