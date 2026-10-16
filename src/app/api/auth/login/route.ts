/**
 * POST /api/auth/login —— REST 登录端点。
 *
 * 与注册端点的理由相同：Server Action 无法被非浏览器客户端调用。
 * 校验与凭据检查复用 `src/lib/auth.ts`。
 */
import type { NextRequest } from 'next/server'
import { authenticate, startSession } from '@/lib/auth'
import { AUDIT, audit } from '@/lib/audit'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { SESSION_COOKIE, sessionCookieAttributes } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SESSION_TTL_S = 60 * 60 * 24 * 30

async function readInput(req: NextRequest): Promise<{ email: string; password: string }> {
  const contentType = req.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    return { email: String(body.email ?? ''), password: String(body.password ?? '') }
  }

  const form = await req.formData().catch(() => null)
  return {
    email: String(form?.get('email') ?? ''),
    password: String(form?.get('password') ?? ''),
  }
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers)

  // 登录限流比注册更严格：这是暴力破解的入口
  const limit = consume(`login:ip:${ip}`, RATE_RULES.login)
  if (!limit.ok) {
    return jsonResponse(
      { error: '尝试次数过多，请 15 分钟后再试', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    )
  }

  let input: { email: string; password: string }
  try {
    input = await readInput(req)
  } catch {
    return errorResponse(400, '请求体解析失败', 'bad_request')
  }

  const result = await authenticate(input)
  if (!result.ok) {
    return jsonResponse({ error: result.error, code: result.code }, { status: result.status })
  }

  const token = await startSession(result.userId)

  await audit({
    actorId: result.userId,
    action: AUDIT.USER_LOGIN,
    targetType: 'user',
    targetId: result.userId,
    meta: { via: 'api' },
    ip,
  })

  const res = jsonResponse({ ok: true, user: { id: result.userId } })
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; ${sessionCookieAttributes(SESSION_TTL_S)}`,
  )
  return res
}
