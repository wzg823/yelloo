/**
 * 密码重置的数据访问层。
 *
 * 单独一个文件而不是塞进 `queries.ts`：那边的函数服务于公开读路径，
 * 这里的每一个都涉及凭据，混在一起会让"哪些查询碰密码"变得难以一眼看清。
 *
 * 约定同 `admin-queries.ts`：只读写，不鉴权。
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { passwordResets, sessions, users } from '@/db/schema'

/** 按邮箱找账号。返回的是最小字段集 —— 重置流程不需要角色、头像这些 */
export async function findUserForReset(
  email: string,
): Promise<{ id: number; handle: string; email: string; status: string } | null> {
  const rows = await db
    .select({
      id: users.id,
      handle: users.handle,
      email: users.email,
      status: users.status,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1)
  return rows[0] ?? null
}

/**
 * 签发一枚重置令牌，并**作废该用户此前所有未用尽的令牌**。
 *
 * 两件事必须在同一个事务里：只插入不作废的话，"发送重置邮件"点三次
 * 就会留下三个可用链接，把攻击面乘三倍；而只作废不插入的中断又会让
 * 用户什么都没有拿到。
 *
 * 用 `used_at = now()` 标记作废而不是删除：留痕。运维排查"为什么
 * 用户说点了三次只收到一封能用的邮件"时，这些记录就是答案。
 */
export async function createPasswordReset(input: {
  userId: number
  tokenHash: string
  expiresAt: Date
  requestedIp?: string | null
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, input.userId), isNull(passwordResets.usedAt)))

    await tx.insert(passwordResets).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      requestedIp: input.requestedIp ?? null,
    })
  })
}

export type ConsumeResult =
  | { ok: true; userId: number }
  | { ok: false; reason: 'not_found' | 'used' | 'expired' }

/**
 * 消费一枚令牌。
 *
 * ★ 必须原子 ★
 *
 * 用一条 `UPDATE ... WHERE used_at IS NULL ... RETURNING` 来"抢占"令牌，
 * 而不是"先 SELECT 检查、再 UPDATE 标记"。后者在并发下会让同一个链接
 * 被两个请求同时判定为有效 —— 用户双击一下链接就可能重置两次，
 * 而如果是攻击者在重放，那就等于令牌不是一次性的。
 *
 * 成功的路径只有这一条 UPDATE；失败时再补一次查询，只为把
 * not_found / used / expired 区分开（**仅供日志与测试**，对外统一报
 * "链接无效或已过期"，见 `reset-policy.ts`）。
 */
export async function consumePasswordReset(
  tokenHash: string,
): Promise<ConsumeResult> {
  const claimed = await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResets.tokenHash, tokenHash),
        isNull(passwordResets.usedAt),
        sql`${passwordResets.expiresAt} > now()`,
      ),
    )
    .returning({ userId: passwordResets.userId })

  const row = claimed[0]
  if (row) return { ok: true, userId: row.userId }

  // 失败路径：查清楚是哪种失败。这一步不改变任何状态
  const existing = await db
    .select({ usedAt: passwordResets.usedAt, expiresAt: passwordResets.expiresAt })
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, tokenHash))
    .limit(1)

  if (existing.length === 0) return { ok: false, reason: 'not_found' }
  if (existing[0]!.usedAt) return { ok: false, reason: 'used' }
  return { ok: false, reason: 'expired' }
}

/**
 * 改密码并**撤销该用户全部会话**。
 *
 * 撤销会话不是可选项：重置密码的语义就是"把这个账号从所有地方踢下线"。
 * 账号被他人接管时，旧会话继续有效等于重置毫无作用 —— 攻击者依然在线。
 * 这也是"忘记密码"能当作应急手段的前提。
 *
 * 与 `scripts/set-password.mjs` 保持同一套语义，两者行为必须一致，
 * 否则"命令行改密会踢人、网页改密不会"这种差异迟早会被当成漏洞报上来。
 */
export async function setPasswordAndRevokeSessions(input: {
  userId: number
  passwordHash: string
}): Promise<{ revoked: number }> {
  return await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: input.passwordHash })
      .where(eq(users.id, input.userId))

    const gone = await tx
      .delete(sessions)
      .where(eq(sessions.userId, input.userId))
      .returning({ id: sessions.id })

    return { revoked: gone.length }
  })
}

/** 清理过期的重置记录。挂在宿主 cron 上每天跑一次即可 */
export async function purgeExpiredPasswordResets(): Promise<number> {
  const rows = await db
    .delete(passwordResets)
    // 留 1 天余量：刚过期的记录还有排查价值
    .where(sql`${passwordResets.expiresAt} < now() - interval '1 day'`)
    .returning({ id: passwordResets.id })
  return rows.length
}
