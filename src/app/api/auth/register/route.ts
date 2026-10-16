/**
 * POST /api/auth/register —— REST 注册端点。
 *
 * 与 Server Action 共用 `src/lib/auth.ts` 的校验与创建逻辑，
 * 保证两条路径的规则完全一致（**不要在任一处重复实现**）。
 *
 * 存在的理由：Server Action 需要浏览器注入的 `Next-Action` 头，
 * 脚本、移动端、桌面端都无法调用。没有这个端点，
 * 任何非浏览器客户端都注册不了账号。
 *
 * 会话通过 httpOnly Cookie 下发，与表单注册的行为一致。
 */
import type { NextRequest } from 'next/server'
import { createUser, startSession } from '@/lib/auth'
import { AUDIT, audit } from '@/lib/audit'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { SESSION_COOKIE, sessionCookieAttributes } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SESSION_TTL_S = 60 * 60 * 24 * 30

async function readInput(req: NextRequest): Promise<{
  handle: string
  email: string
  password: string
}> {
  const contentType = req.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    return {
      handle: String(body.handle ?? ''),
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    }
  }

  // 同时支持表单编码：便于 curl 与简单脚本
  const form = await req.formData().catch(() => null)
  return {
    handle: String(form?.get('handle') ?? ''),
    email: String(form?.get('email') ?? ''),
    password: String(form?.get('password') ?? ''),
  }
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers)

  const limit = consume(`register:ip:${ip}`, RATE_RULES.register)
  if (!limit.ok) {
    return jsonResponse(
      { error: '注册过于频繁，请稍后再试', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    )
  }

  let input: { handle: string; email: string; password: string }
  try {
    input = await readInput(req)
  } catch {
    return errorResponse(400, '请求体解析失败', 'bad_request')
  }

  const result = await createUser(input)
  if (!result.ok) {
    return jsonResponse({ error: result.error, code: result.code }, { status: result.status })
  }

  const token = await startSession(result.userId)

  await audit({
    actorId: result.userId,
    action: AUDIT.USER_REGISTER,
    targetType: 'user',
    targetId: result.userId,
    meta: { handle: result.handle, via: 'api' },
    ip,
  })

  const res = jsonResponse(
    { ok: true, user: { id: result.userId, handle: result.handle } },
    { status: 201 },
  )
  // httpOnly：客户端脚本读不到，降低 XSS 后的会话窃取风险
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; ${sessionCookieAttributes(SESSION_TTL_S)}`,
  )
  return res
}
