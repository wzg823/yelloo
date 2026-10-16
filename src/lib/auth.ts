/**
 * 认证核心逻辑。
 *
 * 被两处复用，**不要在其中任何一处重复实现校验规则**：
 *   1. Server Action（`src/app/(auth)/actions.ts`）—— 浏览器表单
 *   2. REST 端点（`src/app/api/auth/*`）—— 脚本、移动端、桌面端、集成
 *
 * 如果只实现 Server Action，任何非浏览器客户端都无法注册登录——
 * 因为 Server Action 要求浏览器注入的 `Next-Action` 头，无法从脚本直接调用。
 * 这是设计 REST 端点的真正原因，不是为了测试方便。
 *
 * ⚠️ 校验必须在这里做全套。HTML 的 maxLength/pattern 属性只约束浏览器表单，
 * 直接 POST 的请求完全绕过它们。
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { hashPassword, verifyPassword } from './password'
import { weakPasswordReason } from './password-policy'
import { createSession, getCurrentUser, type SessionUser } from './session'
import { combinePerms, permsForUserRole } from './permissions'
import { memberRoles, roles } from '@/db/schema'
import { eq } from 'drizzle-orm'

export const HANDLE_RE = /^[a-zA-Z0-9_-]{3,32}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
/**
 * 密码策略（最小长度、弱口令规则）在 `password-policy.ts` —— 单一来源。
 * 命令行改密脚本 `scripts/set-password.mjs` 也引用同一个文件，
 * 避免"脚本能设的密码，注册接口认为太弱"这种自相矛盾。
 * 这里转出一次，保持 `@/lib/auth` 的既有导入路径可用。
 */
export { MIN_PASSWORD_LENGTH } from './password-policy'
/** 用户名保留字：避免与将来可能的路由冲突 */
const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'mod', 'moderator',
  'api', 'www', 'mail', 'help', 'about', 'login', 'register', 'search',
  'settings', 'account', 'me', 'null', 'undefined',
])

/** Postgres 唯一约束冲突 */
const PG_UNIQUE_VIOLATION = '23505'

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  )
}

export type AuthOutcome =
  | { ok: true; userId: number; handle: string }
  | { ok: false; error: string; code: string; status: number }

/** 输入校验。两端共用，保证 REST 与表单的规则完全一致 */
export function validateRegistration(input: {
  handle: string
  email: string
  password: string
}): { ok: true } | { ok: false; error: string; code: string } {
  const handle = input.handle.trim()
  const email = input.email.trim().toLowerCase()

  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      code: 'invalid_handle',
      error: '用户名需为 3-32 位字母、数字、下划线或连字符',
    }
  }
  if (RESERVED_HANDLES.has(handle.toLowerCase())) {
    return { ok: false, code: 'reserved_handle', error: '该用户名是保留字，请换一个' }
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, code: 'invalid_email', error: '邮箱格式不正确' }
  }
  const weak = weakPasswordReason(input.password)
  if (weak) {
    return { ok: false, code: 'weak_password', error: weak }
  }
  return { ok: true }
}

/**
 * 创建用户（不含会话建立）。
 *
 * 不做"先查后插"：那有 TOCTOU 竞态，两个并发请求都会通过预检查。
 * 直接依赖唯一索引 users_handle_key / users_email_key，冲突就返回错误。
 */
export async function createUser(input: {
  handle: string
  email: string
  password: string
  role?: 'member' | 'mod' | 'admin'
  trustLevel?: number
}): Promise<AuthOutcome> {
  const validation = validateRegistration(input)
  if (!validation.ok) {
    // 先解构出 error/code，避免与下面的 status 一起出现重复的 ok 字段
    const { error, code } = validation
    return { ok: false, error, code, status: 400 }
  }

  const handle = input.handle.trim()
  const email = input.email.trim().toLowerCase()
  const passwordHash = await hashPassword(input.password)

  try {
    const inserted = await db
      .insert(users)
      .values({
        handle,
        email,
        passwordHash,
        displayName: handle,
        role: input.role ?? 'member',
        trustLevel: input.trustLevel ?? 0,
      })
      .returning({ id: users.id })

    return { ok: true, userId: inserted[0]!.id, handle }
  } catch (err) {
    if (isUniqueViolation(err)) {
      // 不区分"用户名占用"与"邮箱占用"更安全？这里明确区分：
      // 注册场景下用户体验优先，且邮箱是否注册过本就可通过登录流程探测。
      return { ok: false, code: 'conflict', error: '该用户名或邮箱已被占用', status: 409 }
    }
    console.error('[auth] createUser failed:', err)
    return { ok: false, code: 'internal', error: '注册失败，请稍后重试', status: 500 }
  }
}

/** 校验凭据。返回统一失败信息，不区分"账号不存在"与"密码错误" */
export async function authenticate(input: {
  email: string
  password: string
}): Promise<{ ok: true; userId: number } | { ok: false; error: string; code: string; status: number }> {
  const email = input.email.trim().toLowerCase()
  if (!email || !input.password) {
    return { ok: false, code: 'missing_credentials', error: '请输入邮箱和密码', status: 400 }
  }

  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash, status: users.status })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1)

  const genericFailure = {
    ok: false as const,
    code: 'invalid_credentials',
    // 不要区分"邮箱不存在"和"密码错误"，否则接口就成了账号枚举工具
    error: '邮箱或密码不正确',
    status: 401,
  }

  const row = rows[0]
  if (!row) {
    // 仍执行一次哈希校验以拉平耗时，避免通过响应时间差异判断账号是否存在
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
      input.password,
    )
    return genericFailure
  }

  if (row.status === 'banned') {
    return {
      ok: false,
      code: 'banned',
      error: '该账号已被封禁，如有异议请联系管理员',
      status: 403,
    }
  }

  const valid = await verifyPassword(row.passwordHash, input.password)
  if (!valid) return genericFailure

  return { ok: true, userId: row.id }
}

/** 建立会话并返回 token（调用方负责写入 Cookie 或响应体） */
export async function startSession(userId: number): Promise<string> {
  return createSession(userId)
}

/** 取当前用户的有效权限位。供需要细粒度判断的接口使用 */
export async function loadUserPerms(user: SessionUser): Promise<bigint> {
  const rolePerms = await db
    .select({ permissions: roles.permissions })
    .from(memberRoles)
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(eq(memberRoles.userId, user.id))
  return combinePerms([permsForUserRole(user.role), ...rolePerms.map((r) => r.permissions)])
}

export { getCurrentUser }
