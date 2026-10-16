/**
 * 认证相关 Server Action（浏览器表单用）。
 *
 * 校验与用户创建逻辑全部复用 `src/lib/auth.ts` —— 与 REST 端点
 * （`/api/auth/register`、`/api/auth/login`）共享同一份实现。
 * **不要在这里重复实现校验规则**，否则两条路径的规则迟早会漂移，
 * 出现"表单能注册但 API 不能"或反之的诡异问题。
 *
 * 放在独立文件而不是组件里：Server Action 必须标记 'use server'，
 * 而组件文件同时导出组件和 action 会导致 Next 的编译期校验报错。
 */
'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { authenticate, createUser, startSession } from '@/lib/auth'
import {
  clearSessionCookie,
  destroySession,
  getCurrentUser,
  setSessionCookie,
  SESSION_COOKIE,
} from '@/lib/session'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { AUDIT, audit } from '@/lib/audit'

export type ActionResult =
  | { ok: true; error?: undefined }
  | { ok: false; error: string }

export async function registerAction(formData: FormData): Promise<ActionResult> {
  const h = await headers()
  const ip = clientIp(h)

  const limit = consume(`register:ip:${ip}`, RATE_RULES.register)
  if (!limit.ok) return { ok: false, error: '注册过于频繁，请稍后再试' }

  const input = {
    handle: String(formData.get('handle') ?? ''),
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  }

  const result = await createUser(input)
  if (!result.ok) return { ok: false, error: result.error }

  const token = await startSession(result.userId)
  await setSessionCookie(token)

  await audit({
    actorId: result.userId,
    action: AUDIT.USER_REGISTER,
    targetType: 'user',
    targetId: result.userId,
    meta: { handle: result.handle, via: 'form' },
    ip,
  })

  // 不在这里 redirect：调用方是客户端组件，由它 router.replace 并 refresh，
  // 这样本函数的返回类型保持为结果对象，前端能统一处理错误。
  return { ok: true }
}

export async function loginAction(formData: FormData): Promise<ActionResult> {
  const h = await headers()
  const ip = clientIp(h)

  const limit = consume(`login:ip:${ip}`, RATE_RULES.login)
  if (!limit.ok) return { ok: false, error: '尝试次数过多，请 15 分钟后再试' }

  const result = await authenticate({
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  })
  if (!result.ok) return { ok: false, error: result.error }

  const token = await startSession(result.userId)
  await setSessionCookie(token)

  await audit({
    actorId: result.userId,
    action: AUDIT.USER_LOGIN,
    targetType: 'user',
    targetId: result.userId,
    meta: { via: 'form' },
    ip,
  })

  return { ok: true }
}

export async function logoutAction(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const user = await getCurrentUser()

  if (token) await destroySession(token)
  await clearSessionCookie()

  if (user) {
    await audit({
      actorId: user.id,
      action: AUDIT.USER_LOGOUT,
      targetType: 'user',
      targetId: user.id,
    })
  }

  redirect('/')
}
