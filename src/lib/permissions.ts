/**
 * 权限位。
 *
 * 用 bigint 位域而不是多张关联表，理由：判断"这人能不能发言"是每个请求都要做的事，
 * 位运算比 join 快一个数量级；而且 Discord 已验证这套模型够用。
 *
 * 唯一坑：JS 位运算只有 32 位，必须全程用 BigInt，不能混用 Number。
 */

export const PERM = {
  VIEW: 1n << 0n,
  SEND_MESSAGE: 1n << 1n,
  ATTACH_FILES: 1n << 2n,
  CREATE_THREAD: 1n << 3n,
  EDIT_OWN_MESSAGE: 1n << 4n,
  MANAGE_MESSAGE: 1n << 5n,
  MANAGE_CHANNEL: 1n << 6n,
  MANAGE_ROLE: 1n << 7n,
  KICK_MEMBER: 1n << 8n,
  BAN_MEMBER: 1n << 9n,
  MANAGE_REPORT: 1n << 10n,
  VIEW_AUDIT_LOG: 1n << 11n,
  MENTION_EVERYONE: 1n << 12n,
  ADMINISTRATOR: 1n << 62n,
} as const

export type PermissionName = keyof typeof PERM

/** 普通成员的基础权限（无需任何角色即拥有） */
export const BASE_MEMBER_PERMS: bigint =
  PERM.VIEW |
  PERM.SEND_MESSAGE |
  PERM.ATTACH_FILES |
  PERM.CREATE_THREAD |
  PERM.EDIT_OWN_MESSAGE

/** 游客（未登录）：只读 */
export const GUEST_PERMS: bigint = PERM.VIEW

/** 管理员拥有一切：用掩码判断而不是逐项累加，避免漏权限 */
export const ALL_PERMS: bigint = (1n << 63n) - 1n

export function hasPerm(perms: bigint, required: bigint): boolean {
  if ((perms & PERM.ADMINISTRATOR) !== 0n) return true
  return (perms & required) === required
}

export function hasAnyPerm(perms: bigint, required: bigint): boolean {
  if ((perms & PERM.ADMINISTRATOR) !== 0n) return true
  return (perms & required) !== 0n
}

/** 把角色权限聚合成有效权限。DB 里存的是十进制字符串的 bigint 列 */
export function combinePerms(rolePerms: readonly bigint[]): bigint {
  return rolePerms.reduce((acc, p) => acc | p, 0n)
}

/** 从 user.role 推出的基础权限（mod/admin 走内置档位） */
export function permsForUserRole(role: string): bigint {
  switch (role) {
    case 'admin':
      return ALL_PERMS
    case 'mod':
      return (
        BASE_MEMBER_PERMS |
        PERM.MANAGE_MESSAGE |
        PERM.MANAGE_REPORT |
        PERM.KICK_MEMBER |
        PERM.VIEW_AUDIT_LOG
      )
    default:
      return BASE_MEMBER_PERMS
  }
}

/** 仅用于调试与角色编辑界面展示 */
export function describePerms(perms: bigint): PermissionName[] {
  return (Object.keys(PERM) as PermissionName[]).filter((name) =>
    hasPerm(perms, PERM[name]),
  )
}

/** bigint → 十进制字符串，用于写入权限位为 bigint 的列 */
export function permToString(perms: bigint): string {
  return perms.toString()
}

export function permFromString(raw: string | null | undefined): bigint {
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}
