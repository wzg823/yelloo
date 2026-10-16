/**
 * 审计日志。
 *
 * `action` 必须取自下面的受控词表——禁止自由文本，否则日后无法可靠检索，
 * 也无法在合规场景下向监管说明"我们对哪些行为留了痕"。
 */
import { db, type DbLike } from '@/db'
import { auditLogs } from '@/db/schema'

export const AUDIT = {
  USER_REGISTER: 'user.register',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_BAN: 'user.ban',
  USER_UNBAN: 'user.unban',
  USER_MUTE: 'user.mute',
  USER_UNMUTE: 'user.unmute',
  USER_ROLE_GRANT: 'user.role_grant',
  USER_ROLE_REVOKE: 'user.role_revoke',

  MESSAGE_CREATE: 'message.create',
  MESSAGE_EDIT: 'message.edit',
  MESSAGE_DELETE: 'message.delete',
  MESSAGE_RESTORE: 'message.restore',

  CHANNEL_CREATE: 'channel.create',
  CHANNEL_UPDATE: 'channel.update',
  CHANNEL_ARCHIVE: 'channel.archive',

  REPORT_CREATE: 'report.create',
  REPORT_RESOLVE: 'report.resolve',
  REPORT_DISMISS: 'report.dismiss',
} as const

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT]

export type AuditInput = {
  actorId: number | null
  action: AuditAction
  targetType: 'user' | 'message' | 'channel' | 'report' | 'role' | 'session'
  targetId: string | number | bigint
  meta?: Record<string, unknown>
  ip?: string | null
}

/**
 * 写审计日志。
 *
 * 关键：允许传入事务对象（DbLike），使审计与业务写入在同一事务内提交。
 * 若分开写，进程崩溃时会出现"操作生效但无留痕"，这在处置申诉时是致命的。
 */
export async function audit(input: AuditInput, tx: DbLike = db): Promise<void> {
  await tx.insert(auditLogs).values({
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: String(input.targetId),
    meta: input.meta ?? null,
    ip: input.ip ?? null,
  })
}
