/**
 * POST /api/auth/login —— REST 登录端点。
 *
 * 与注册端点的理由相同：Server Action 无法被非浏览器客户端调用。
 * 校验与凭据检查复用 `src/lib/auth.ts`。
 */
import type { NextRequest } from 'next/server'
import { authenticate, startSession } from '@/lib/auth'
import { AUDIT, audit } from '@/lib/audit'
import { RATE_RULES, clientIp, consume, peek } from '@/lib/ratelimit'
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
  const loginKey = `login:ip:${ip}`

  // ★ 只对**失败**计数 ★
  //
  // 早期版本对每次请求都 consume，于是同一个出口 IP 后面的人（办公室、学校、
  // 运营商 NAT）累计登录十次就会被集体锁在门外 15 分钟 —— 而每人每天重新
  // 登录一次是完全正常的操作。这个缺陷是端到端验证脚本自己先撞上的：
  // 它连跑几轮就把自己的额度用完了。
  //
  // 语义上正确的做法：额度用来限制**失败尝试**（那才是暴力破解的信号）。
  // 所以先 peek 判断是否已经透支，认证失败后才 consume。
  const budget = peek(loginKey, RATE_RULES.login)
  if (!budget.ok) {
    return jsonResponse(
      { error: '尝试次数过多，请 15 分钟后再试', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(budget.retryAfterMs / 1000)) },
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
    // 失败才计入额度。注意这里不去区分"账号不存在"与"密码错"——
    // 两者都是失败尝试，都该计入
    consume(loginKey, RATE_RULES.login)
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
