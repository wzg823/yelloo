/**
 * 会话管理。
 *
 * 设计：DB 存会话（可即时吊销），Cookie 只放不透明随机 token，存 httpOnly。
 * 刻意不用 JWT：论坛需要"封禁立即生效"，而 JWT 在过期前无法撤销。
 */
import { cookies, headers } from 'next/headers'
import { and, eq, gt, lt } from 'drizzle-orm'
import { db } from '@/db'
import { memberRoles, roles, sessions, users } from '@/db/schema'
import { generateSessionToken, hashSessionToken } from './password'
import { combinePerms, permsForUserRole } from './permissions'

export const SESSION_COOKIE = 'bbs_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 天
const SESSION_RENEW_AFTER_MS = 1000 * 60 * 60 * 24 // 使用超过 1 天才续期，避免每次请求都写库

/**
 * 会话 Cookie 是否带 `Secure` 标志。
 *
 * 默认跟随 `NODE_ENV === 'production'`。但生产模式下若通过 **HTTP** 访问
 * （典型场景：用 SSH 隧道在 `http://localhost:3000` 上验证部署），
 * 浏览器会拒绝发送带 `Secure` 的 Cookie —— 表现为
 * **"登录成功但立刻又变成未登录"**，很容易被误判成认证逻辑有 bug。
 *
 * 因此提供显式开关。**只在纯 HTTP 的验证环境设为 false**：
 *   COOKIE_SECURE=false
 * 任何走 HTTPS 的环境都必须保持 true，否则会话 Cookie 会在明文链路上传输。
 */
function useSecureCookie(): boolean {
  const override = process.env.COOKIE_SECURE
  if (override === 'false') return false
  if (override === 'true') return true
  return process.env.NODE_ENV === 'production'
}

/**
 * 会话 Cookie 的属性串（不含 `名字=值` 部分）。
 *
 * 抽出来给 Route Handler 复用 —— 它们必须手动拼 `Set-Cookie` 头
 * （`next/headers` 的 `cookies()` 只在 Server Action 中可写）。
 *
 * **清除 Cookie 时必须用同一组属性**（Path 至少要对得上），
 * 否则浏览器可能认为是另一个 Cookie 而保留旧的。
 */
export function sessionCookieAttributes(maxAgeSeconds: number): string {
  const parts = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (useSecureCookie()) parts.push('Secure')
  return parts.join('; ')
}

export type SessionUser = {
  id: number
  handle: string
  email: string
  displayName: string | null
  avatarUrl: string | null
  role: string
  status: string
  mutedUntil: Date | null
  trustLevel: number
  /**
   * 注册时间。新人限流（src/lib/trust.ts）靠它算账号年龄。
   *
   * 刻意放在会话查询里一起取，而不是限流时再查一次库：
   * 发帖是最高频的写路径，为一个已知的字段多打一次数据库往返不值得。
   */
  createdAt: Date
  perms: bigint
}

/**
 * 在 Server Component 里调用 cookies() 是安全的；
 * 在 Route Handler 里也可以。但某些上下文（如构建期预渲染、脚本）不可用，
 * 所以统一包一层，失败就当作未登录，而不是抛异常。
 */
async function tryCookies() {
  try {
    return await cookies()
  } catch {
    return null
  }
}

export async function createSession(userId: number): Promise<string> {
  const token = generateSessionToken()
  const id = hashSessionToken(token)

  let userAgent: string | null = null
  let ip: string | null = null
  try {
    const h = await headers()
    userAgent = h.get('user-agent')?.slice(0, 300) ?? null
    ip =
      h.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 45) ??
      h.get('x-real-ip')?.slice(0, 45) ??
      null
  } catch {
    /* 无请求上下文（例如脚本内），忽略 */
  }

  await db.insert(sessions).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent,
    ip,
  })

  return token
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await tryCookies()
  if (!store) return
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 中国大陆生产环境必须走 HTTPS（备案后正常配），因此默认 secure 为 true。
    // 纯 HTTP 验证环境需要 COOKIE_SECURE=false，原因见 useSecureCookie 的说明。
    secure: useSecureCookie(),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await tryCookies()
  if (!store) return
  store.delete(SESSION_COOKIE)
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)))
}

/** 读取当前登录用户；未登录返回 null。guest 可见的页面也调它来判断 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await tryCookies()
  const token = store?.get(SESSION_COOKIE)?.value
  if (!token) return null

  const sessionId = hashSessionToken(token)

  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      userId: users.id,
      handle: users.handle,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
      mutedUntil: users.mutedUntil,
      trustLevel: users.trustLevel,
      createdAt: users.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  // 被永久封禁的会话立即失效（而不是等 cookie 过期）
  if (row.status === 'banned') {
    await db.delete(sessions).where(eq(sessions.id, sessionId))
    return null
  }

  const rolePerms = await db
    .select({ permissions: roles.permissions })
    .from(memberRoles)
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(eq(memberRoles.userId, row.userId))

  const perms = combinePerms([
    permsForUserRole(row.role),
    ...rolePerms.map((r) => r.permissions),
  ])

  // 惰性续期：只在接近过期或长期未活动时写一次，避免每个请求一条 UPDATE
  const now = Date.now()
  if (now - row.lastUsedAt.getTime() > SESSION_RENEW_AFTER_MS) {
    await db
      .update(sessions)
      .set({ lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) })
      .where(eq(sessions.id, sessionId))
  }

  return {
    id: row.userId,
    handle: row.handle,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    mutedUntil: row.mutedUntil,
    trustLevel: row.trustLevel,
    createdAt: row.createdAt,
    perms,
  }
}

/** 需要登录的路由/动作统一用它，未登录直接抛错 */
export class UnauthorizedError extends Error {
  constructor(message = '需要登录') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) throw new UnauthorizedError()
  return user
}

/** 是否处于禁言期 */
export function isMuted(user: SessionUser): boolean {
  if (user.status === 'muted') {
    return !user.mutedUntil || user.mutedUntil.getTime() > Date.now()
  }
  return user.mutedUntil ? user.mutedUntil.getTime() > Date.now() : false
}

/** 清理过期会话。挂在宿主 cron 上每天跑一次 */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
  return result.rowCount ?? 0
}
