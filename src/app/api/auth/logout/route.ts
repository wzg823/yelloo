/**
 * POST /api/auth/logout —— REST 登出端点。
 *
 * 除删除会话记录外，还会通过实时通道踢掉该用户的所有 SSE 连接：
 * 登出后客户端不应再收到推送。前端虽会主动关闭 EventSource，
 * 但多标签页或异常情况下可能残留，服务端主动断开是唯一可靠的保证。
 */
import type { NextRequest } from 'next/server'
import { AUDIT, audit } from '@/lib/audit'
import { hashSessionToken } from '@/lib/password'
import { disconnectUser } from '@/lib/realtime/hub'
import { jsonResponse } from '@/lib/serialize'
import {
  destroySession,
  getCurrentUser,
  SESSION_COOKIE,
  sessionCookieAttributes,
} from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()

  // 从 Cookie 头手动取 token：这里是 Route Handler，
  // 不能依赖 next/headers 的 cookies() 写入能力（它只在 Server Action 中可写）。
  const cookieHeader = req.headers.get('cookie') ?? ''
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader)

  if (match?.[1]) {
    await destroySession(hashSessionToken(decodeURIComponent(match[1])))
  }

  if (user) {
    disconnectUser(user.id, 'logout')
    await audit({
      actorId: user.id,
      action: AUDIT.USER_LOGOUT,
      targetType: 'user',
      targetId: user.id,
      meta: { via: 'api' },
    })
  }

  const res = jsonResponse({ ok: true })
  // 必须用与写入时相同的属性（Path/Secure 等）清 Cookie，
  // 否则浏览器可能认为是另一个 Cookie 而保留旧的。Max-Age=0 即立即失效。
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; ${sessionCookieAttributes(0)}`,
  )
  return res
}
