/**
 * 管理接口的统一入口守卫。
 *
 * ── 为什么值得单独一个文件 ──────────────────────────────────────────
 *
 * 管理接口有十来个，如果每个文件各写一遍"取当前用户 → 判权限 → 造 403"，
 * 迟早会有一个漏掉某一步 —— 而漏掉的那一个就是整站的后门。所以：
 *
 *   1. 只在这里取用户、只在这里判权限
 *   2. 返回值刻意做成判别联合（`denied` 存在即失败），让调用方**必须**处理
 *      失败分支：`if ('denied' in gate) return gate.denied`
 *   3. 权限位由调用方传进来，因为这个文件不该知道"用户列表页需要哪个权限"
 *
 * ⚠️ 这里只判"有没有这个能力"。能不能对**某个具体对象**用这个能力
 * （比如版主不能封另一个版主）由 `admin-policy.ts` 的 `canModerateTarget` 负责。
 * 两者缺一不可：只有能力位就会出现横向提权。
 */
import type { SessionUser } from './session'
import { getCurrentUser } from './session'
import { hasPerm } from './permissions'
import { errorResponse } from './serialize'

export type AdminGate =
  | { denied: Response; user?: undefined }
  | { denied?: undefined; user: SessionUser }

/**
 * @param perm 该接口要求的能力位
 */
export async function requirePerm(perm: bigint): Promise<AdminGate> {
  const user = await getCurrentUser()
  if (!user) return { denied: errorResponse(401, '需要登录', 'unauthorized') }
  if (!hasPerm(user.perms, perm)) {
    return { denied: errorResponse(403, '你没有执行该操作的权限', 'forbidden') }
  }
  return { user }
}

/** 把请求体解析成对象；非对象（数组、字符串、假值）一律当成空对象 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

export function asTrimmedString(value: unknown, max = 500): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

export function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
  return n
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}
