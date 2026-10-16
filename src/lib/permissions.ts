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
  /**
   * 删除自己的消息。刻意与 EDIT_OWN_MESSAGE 分开：
   * 两者是不同性质的权力——一个社区可能希望允许改错字，但不允许把
   * 已发出的内容随手抹掉（或者反过来）。合成一个位就再也拆不开了。
   */
  DELETE_OWN_MESSAGE: 1n << 13n,
  /**
   * 禁言。与 KICK_MEMBER / BAN_MEMBER 分开的理由：
   * "让他安静一会儿"、"踢出当前会话"、"永久拒绝" 是三种强度完全不同的处置，
   * 一个社区很可能只愿意把前两者交给版主。合成一位就再也分不开了。
   */
  MUTE_MEMBER: 1n << 14n,
  ADMINISTRATOR: 1n << 62n,
} as const

export type PermissionName = keyof typeof PERM

/** 普通成员的基础权限（无需任何角色即拥有） */
export const BASE_MEMBER_PERMS: bigint =
  PERM.VIEW |
  PERM.SEND_MESSAGE |
  PERM.ATTACH_FILES |
  PERM.CREATE_THREAD |
  PERM.EDIT_OWN_MESSAGE |
  PERM.DELETE_OWN_MESSAGE

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
        // 版主能禁言，但**不能封禁** —— 永久拒绝是站长才承担的责任
        PERM.MUTE_MEMBER |
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

/**
 * "这个人算不算管理" —— 供**客户端渲染**决定是否显示按钮。
 *
 * 刻意不复用 `hasPerm`：客户端拿不到权限位（`SessionSnapshot` 里没有 perms，
 * 见 `session-context.tsx`），而且角色→权限的映射一旦在客户端算，
 * 就会出现"前端以为有权限、后端算出来没有"这种最难查的不一致。
 *
 * ★ 它只影响按钮显不显示。任何写操作都必须在服务端重新判定。★
 */
export function isModeratorRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'mod'
}

export function permFromString(raw: string | null | undefined): bigint {
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}
