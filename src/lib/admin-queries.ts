/**
 * 管理后台的数据访问层。
 *
 * 与 `queries.ts` 分开的理由：那边的函数服务于**公开读路径**（首页、频道流、
 * 搜索），会被高频调用；这里的每一个函数都只在管理界面被人工触发。
 * 混在一起会让"哪些查询需要考虑性能"这个判断变得越来越模糊。
 *
 * 约定：
 *  - 只接受/返回应用层类型，不泄露 Drizzle 行对象
 *  - **不做鉴权**。这里只管读写，权限一律由路由判定 —— 数据层里混入鉴权，
 *    会让"这个函数有没有替我检查过"变成每个调用点都要猜的问题
 *  - 所有时间列是 timestamptz，出参保持 Date，序列化交给 `toJson`
 */
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@/db'
import {
  auditLogs,
  bans,
  categories,
  channels,
  messageEdits,
  messages,
  reports,
  users,
} from '@/db/schema'

// 同一张表要在一次查询里出现多次（举报人 / 处理人 / 被举报人 / 消息作者），
// 必须起别名，否则 SQL 里会出现重名的 users 而报错。
//
// ★ 用 drizzle 的 alias()，不要用 sql`users as x` ★
// 后者看起来能写进 leftJoin，但 drizzle 需要真实的表对象才能生成列引用，
// 拼出来的 SQL 是错的（或者干脆在生成阶段就出问题）。
const reporterUser = alias(users, 'reporter_user')
const handlerUser = alias(users, 'handler_user')
const msgAuthor = alias(users, 'msg_author')
const targetUser = alias(users, 'target_user')
const msgChannel = alias(channels, 'msg_channel')
const auditActor = alias(users, 'audit_actor')

// ─────────────────────────────────────────────────────────────
// 举报
// ─────────────────────────────────────────────────────────────

export type ReportRow = {
  id: number
  targetType: string
  reason: string
  status: string
  createdAt: Date
  handledAt: Date | null
  resolutionNote: string | null
  reporter: { id: number | null; handle: string | null; displayName: string | null }
  handledBy: { id: number | null; handle: string | null } | null
  message: {
    id: string
    channelId: number | null
    channelSlug: string | null
    /** 已删除时为 null —— 此时要看 `deletedRevision` */
    content: string | null
    isDeleted: boolean
    authorId: number | null
    authorHandle: string | null
    /** 删除前的最后一版正文，供审核判断"他到底写了什么" */
    deletedRevision: string | null
  } | null
  targetUser: { id: number; handle: string; status: string } | null
}

/**
 * 举报列表。
 *
 * 一次查询带出所有关联（举报人、处理人、被举报消息、消息作者、频道、被举报用户），
 * 而不是逐条再查 —— 审核队列一屏 50 条，N+1 就是几百次往返。
 */
export async function listReports(opts: {
  status?: string
  limit?: number
}): Promise<ReportRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const conditions = []
  if (opts.status && opts.status !== 'all') {
    conditions.push(eq(reports.status, opts.status as 'open' | 'resolved' | 'dismissed'))
  }

  const rows = await db
    .select({
      id: reports.id,
      targetType: reports.targetType,
      reason: reports.reason,
      status: reports.status,
      createdAt: reports.createdAt,
      handledAt: reports.handledAt,
      resolutionNote: reports.resolutionNote,
      reporterId: reports.reporterId,
      handledById: reports.handledBy,
      messageId: reports.messageId,
      channelId: reports.channelId,
      targetUserId: reports.targetUserId,

      reporterHandle: reporterUser.handle,
      reporterDisplayName: reporterUser.displayName,
      handlerHandle: handlerUser.handle,

      msgContent: messages.contentMd,
      msgIsDeleted: messages.isDeleted,
      msgAuthorId: messages.authorId,
      msgAuthorHandle: msgAuthor.handle,
      msgChannelSlug: msgChannel.slug,

      targetHandle: targetUser.handle,
      targetStatus: targetUser.status,
    })
    .from(reports)
    // 全是左连接：举报人可能已注销，被举报的消息可能已被删除
    .leftJoin(reporterUser, eq(reporterUser.id, reports.reporterId))
    .leftJoin(handlerUser, eq(handlerUser.id, reports.handledBy))
    .leftJoin(messages, eq(messages.id, reports.messageId))
    .leftJoin(msgAuthor, eq(msgAuthor.id, messages.authorId))
    .leftJoin(msgChannel, eq(msgChannel.id, messages.channelId))
    .leftJoin(targetUser, eq(targetUser.id, reports.targetUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reports.createdAt))
    .limit(limit)

  const result: ReportRow[] = []
  for (const r of rows) {
    const messageId = r.messageId
    const isDeleted = Boolean(r.msgIsDeleted)
    result.push({
      id: r.id,
      targetType: r.targetType,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
      handledAt: r.handledAt,
      resolutionNote: r.resolutionNote,
      reporter: {
        id: r.reporterId,
        handle: r.reporterHandle,
        displayName: r.reporterDisplayName,
      },
      handledBy: r.handledById
        ? { id: r.handledById, handle: r.handlerHandle }
        : null,
      message: messageId
        ? {
            id: messageId.toString(),
            channelId: r.channelId,
            channelSlug: r.msgChannelSlug,
            content: isDeleted ? null : r.msgContent,
            isDeleted,
            authorId: r.msgAuthorId,
            authorHandle: r.msgAuthorHandle,
            // 已删除的消息正文在库里被清空了，而删除前的最后一版留在
            // message_edits（见 queries.softDeleteMessage）。审核必须能看到它 ——
            // 否则"处理举报"就变成了对着墓碑做判断
            deletedRevision: isDeleted ? await latestRevision(messageId) : null,
          }
        : null,
      targetUser:
        r.targetUserId != null
          ? {
              id: r.targetUserId,
              handle: r.targetHandle ?? '已注销',
              status: r.targetStatus ?? 'active',
            }
          : null,
    })
  }

  return result
}

/** 取某条消息的最后一版历史正文（用于查看被删除消息原本写了什么） */
export async function latestRevision(messageId: bigint): Promise<string | null> {
  const rows = await db
    .select({ contentMd: messageEdits.contentMd })
    .from(messageEdits)
    .where(eq(messageEdits.messageId, messageId))
    .orderBy(desc(messageEdits.id))
    .limit(1)
  return rows[0]?.contentMd ?? null
}

export async function getReportById(id: number): Promise<{ id: number; status: string } | null> {
  const rows = await db
    .select({ id: reports.id, status: reports.status })
    .from(reports)
    .where(eq(reports.id, id))
    .limit(1)
  return rows[0] ?? null
}

/**
 * 处置一条举报需要知道的三个 id。
 *
 * `targetUserId` 对消息举报来说就是**消息作者** —— 建单时已经写进去了，
 * 但这里仍然保留"回落到作者"的兜底：早期数据或人工插的单子可能没填，
 * 而缺了它会导致"删了消息却封不了人"这种半截处置。
 */
export async function getReportTargets(reportId: number): Promise<{
  messageId: bigint | null
  channelId: number | null
  targetUserId: number | null
} | null> {
  const rows = await db
    .select({
      messageId: reports.messageId,
      channelId: reports.channelId,
      targetUserId: reports.targetUserId,
      authorId: messages.authorId,
      msgChannelId: messages.channelId,
    })
    .from(reports)
    .leftJoin(messages, eq(messages.id, reports.messageId))
    .where(eq(reports.id, reportId))
    .limit(1)

  const r = rows[0]
  if (!r) return null
  return {
    messageId: r.messageId,
    channelId: r.channelId ?? r.msgChannelId ?? null,
    targetUserId: r.targetUserId ?? r.authorId ?? null,
  }
}

export async function createReport(input: {
  reporterId: number
  targetType: 'message' | 'user'
  messageId?: bigint | null
  targetUserId?: number | null
  channelId?: number | null
  reason: string
}): Promise<number> {
  const rows = await db
    .insert(reports)
    .values({
      reporterId: input.reporterId,
      targetType: input.targetType,
      messageId: input.messageId ?? null,
      targetUserId: input.targetUserId ?? null,
      channelId: input.channelId ?? null,
      reason: input.reason,
    })
    .returning({ id: reports.id })
  return rows[0]!.id
}

/**
 * 同一举报人是否已经举报过同一个目标且尚未处理。
 *
 * 用来挡住"连点举报按钮刷满队列"。比按 IP 限流更准确：同一个人重复举报
 * 同一条消息没有新增信息量，而不同的人举报同一条消息恰恰是重要信号，
 * 不该被去重掉。
 */
export async function hasOpenReportFrom(input: {
  reporterId: number
  messageId?: bigint | null
  targetUserId?: number | null
}): Promise<boolean> {
  const conditions = [eq(reports.reporterId, input.reporterId), eq(reports.status, 'open')]
  if (input.messageId) conditions.push(eq(reports.messageId, input.messageId))
  else if (input.targetUserId) conditions.push(eq(reports.targetUserId, input.targetUserId))
  else return false

  const rows = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(...conditions))
    .limit(1)
  return rows.length > 0
}

export async function resolveReport(input: {
  id: number
  handledBy: number
  status: 'resolved' | 'dismissed'
  note?: string | null
}): Promise<boolean> {
  const rows = await db
    .update(reports)
    .set({
      status: input.status,
      handledBy: input.handledBy,
      handledAt: new Date(),
      resolutionNote: input.note ?? null,
    })
    // 只处理还开着的单子：两个管理员同时点"已处理"时，第二个应当无效果，
    // 而不是把第一个人的处理意见覆盖掉
    .where(and(eq(reports.id, input.id), eq(reports.status, 'open')))
    .returning({ id: reports.id })
  return rows.length > 0
}

export async function countOpenReports(): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(reports)
    .where(eq(reports.status, 'open'))
  return Number(rows[0]?.n ?? 0)
}

// ─────────────────────────────────────────────────────────────
// 用户
// ─────────────────────────────────────────────────────────────

export type AdminUserRow = {
  id: number
  handle: string
  email: string
  displayName: string | null
  role: string
  status: string
  trustLevel: number
  mutedUntil: Date | null
  createdAt: Date
  lastSeenAt: Date
  messageCount: number
}

/** 发帖数是审核时最有用的上下文：0 条的新号与被举报的老号，处理方式完全不同 */
const messageCountSubquery = sql<number>`(
  select count(*) from ${messages} where ${messages.authorId} = ${users.id}
)`

export async function listUsersForAdmin(opts: {
  q?: string
  limit?: number
  offset?: number
}): Promise<{ users: AdminUserRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)

  const q = (opts.q ?? '').trim()
  // 邮箱也允许搜：处理"这个邮箱在批量注册"时要按邮箱找。
  // ilike 用不上普通索引，但管理界面是低频人工操作，不值得为它加 GIN
  const where = q
    ? or(ilike(users.handle, `%${q}%`), ilike(users.email, `%${q}%`))
    : undefined

  const rows = await db
    .select({
      id: users.id,
      handle: users.handle,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      trustLevel: users.trustLevel,
      mutedUntil: users.mutedUntil,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      messageCount: messageCountSubquery,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset)

  const totalRows = await db.select({ n: count() }).from(users).where(where)

  return {
    users: rows.map((r) => ({ ...r, messageCount: Number(r.messageCount ?? 0) })),
    total: Number(totalRows[0]?.n ?? 0),
  }
}

export async function getUserForAdmin(id: number): Promise<AdminUserRow | null> {
  const rows = await db
    .select({
      id: users.id,
      handle: users.handle,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      trustLevel: users.trustLevel,
      mutedUntil: users.mutedUntil,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      messageCount: messageCountSubquery,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)

  const r = rows[0]
  return r ? { ...r, messageCount: Number(r.messageCount ?? 0) } : null
}

/**
 * 更新用户的处置状态。
 *
 * `mutedUntil` 与 `status` 必须一起改，否则会出现两种矛盾状态：
 *   · status='muted' 但 mutedUntil 是过去 → 界面显示禁言、实际能发言
 *   · mutedUntil 是未来但 status='active' → 界面显示正常、实际被拦
 * 所以调用方传的是**完整**的处置意图（禁言时同时给 status 与 until），
 * 而不是分别打补丁。
 */
export async function updateUserModeration(input: {
  id: number
  patch: {
    status?: 'active' | 'muted' | 'banned'
    mutedUntil?: Date | null
    role?: 'member' | 'mod' | 'admin'
    trustLevel?: number
  }
}): Promise<boolean> {
  const rows = await db
    .update(users)
    .set(input.patch)
    .where(eq(users.id, input.id))
    .returning({ id: users.id })
  return rows.length > 0
}

/** 记录一次封禁。`users.status` 才是执行依据，这张表是留痕（原因、期限、经办人） */
export async function insertBan(input: {
  userId: number
  reason: string
  until: Date | null
  createdBy: number
  reportId?: number | null
}): Promise<void> {
  await db.insert(bans).values({
    userId: input.userId,
    reason: input.reason,
    until: input.until,
    createdBy: input.createdBy,
    reportId: input.reportId ?? null,
  })
}

/** 解封：清掉未到期的封禁记录，让"当前是否被封"只看 bans 表也能得出正确结论 */
export async function clearActiveBans(userId: number): Promise<number> {
  const rows = await db
    .delete(bans)
    .where(and(eq(bans.userId, userId), sql`${bans.until} is null or ${bans.until} > now()`))
    .returning({ id: bans.id })
  return rows.length
}

// ─────────────────────────────────────────────────────────────
// 频道
// ─────────────────────────────────────────────────────────────

export type AdminChannelRow = {
  id: number
  slug: string
  name: string
  type: string
  topic: string | null
  readOnly: boolean
  archived: boolean
  position: number
  categoryId: number | null
  categoryName: string | null
  messageCount: number
  lastMessageAt: Date | null
}

export async function listChannelsForAdmin(): Promise<AdminChannelRow[]> {
  const rows = await db
    .select({
      id: channels.id,
      slug: channels.slug,
      name: channels.name,
      type: channels.type,
      topic: channels.topic,
      readOnly: channels.readOnly,
      archived: channels.archived,
      position: channels.position,
      categoryId: channels.categoryId,
      categoryName: categories.name,
      messageCount: channels.messageCount,
      lastMessageAt: channels.lastMessageAt,
    })
    .from(channels)
    .leftJoin(categories, eq(categories.id, channels.categoryId))
    .orderBy(channels.position, channels.id)

  return rows.map((r) => ({ ...r, messageCount: Number(r.messageCount ?? 0) }))
}

export async function listCategories(): Promise<{ id: number; name: string; slug: string }[]> {
  return await db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories)
    .orderBy(categories.position, categories.id)
}

export async function createChannel(values: {
  slug: string
  name: string
  type: 'text' | 'forum' | 'announce' | 'thread'
  topic: string | null
  readOnly: boolean
  categoryId: number | null
  position: number
}): Promise<number> {
  const rows = await db
    .insert(channels)
    .values(values)
    .returning({ id: channels.id })
  return rows[0]!.id
}

export async function updateChannel(
  id: number,
  patch: {
    name?: string
    topic?: string | null
    readOnly?: boolean
    archived?: boolean
    position?: number
    categoryId?: number | null
  },
): Promise<boolean> {
  const rows = await db
    .update(channels)
    .set(patch)
    .where(eq(channels.id, id))
    .returning({ id: channels.id })
  return rows.length > 0
}

export async function getChannelForAdmin(id: number): Promise<AdminChannelRow | null> {
  const rows = await db
    .select({
      id: channels.id,
      slug: channels.slug,
      name: channels.name,
      type: channels.type,
      topic: channels.topic,
      readOnly: channels.readOnly,
      archived: channels.archived,
      position: channels.position,
      categoryId: channels.categoryId,
      categoryName: categories.name,
      messageCount: channels.messageCount,
      lastMessageAt: channels.lastMessageAt,
    })
    .from(channels)
    .leftJoin(categories, eq(categories.id, channels.categoryId))
    .where(eq(channels.id, id))
    .limit(1)

  const r = rows[0]
  return r ? { ...r, messageCount: Number(r.messageCount ?? 0) } : null
}

// ─────────────────────────────────────────────────────────────
// 审计日志
// ─────────────────────────────────────────────────────────────

export type AuditRow = {
  id: number
  action: string
  targetType: string
  targetId: string
  meta: unknown
  ip: string | null
  createdAt: Date
  actor: { id: number | null; handle: string | null } | null
}

export async function listAuditLogs(opts: {
  limit?: number
  action?: string
  targetType?: string
}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const conditions = []
  if (opts.action) conditions.push(eq(auditLogs.action, opts.action))
  if (opts.targetType) conditions.push(eq(auditLogs.targetType, opts.targetType))

  const rows = await db
    .select({
      id: auditLogs.id,
      actorId: auditLogs.actorId,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      meta: auditLogs.meta,
      ip: auditLogs.ip,
      createdAt: auditLogs.createdAt,
      actorHandle: auditActor.handle,
    })
    .from(auditLogs)
    .leftJoin(auditActor, eq(auditActor.id, auditLogs.actorId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    meta: r.meta,
    ip: r.ip,
    createdAt: r.createdAt,
    actor: r.actorId ? { id: r.actorId, handle: r.actorHandle } : null,
  }))
}

/** 审计里出现过的动作词表，供筛选下拉使用（按出现次数排序） */
export async function listAuditActions(): Promise<{ action: string; n: number }[]> {
  const rows = await db
    .select({ action: auditLogs.action, n: count() })
    .from(auditLogs)
    .groupBy(auditLogs.action)
    .orderBy(desc(count()))
  return rows.map((r) => ({ action: r.action, n: Number(r.n ?? 0) }))
}
