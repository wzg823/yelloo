/**
 * 数据访问层。
 *
 * 约定：
 *  - 所有函数只接受/返回应用层类型，不向外泄露 Drizzle 行对象
 *  - 游标分页统一用 Snowflake id，禁止 offset（offset 在消息表上会随数据量线性变慢）
 *  - 软删除的消息仍然返回（占位），否则游标会"跳过"位置导致前端分页错位
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { attachments, channels, messages, readStates, users } from '@/db/schema'
import { parseId } from './snowflake'
import { IMAGE_TYPES, attachmentUrl } from './storage'
import {
  toPublicMessage,
  type MessageRow,
  type PublicAttachment,
  type PublicMessage,
} from './serialize'

// ─────────────────────────────────────────────────────────────
// 消息行 → 应用层类型 的公共 select 形状
// ─────────────────────────────────────────────────────────────

const messageSelection = {
  id: messages.id,
  channelId: messages.channelId,
  threadId: messages.threadId,
  replyToId: messages.replyToId,
  kind: messages.kind,
  contentMd: messages.contentMd,
  contentHtml: messages.contentHtml,
  isDeleted: messages.isDeleted,
  editedAt: messages.editedAt,
  createdAt: messages.createdAt,
  attachmentCount: messages.attachmentCount,
  reactionCount: messages.reactionCount,
  authorId: messages.authorId,
  authorHandle: users.handle,
  authorDisplayName: users.displayName,
  authorAvatarUrl: users.avatarUrl,
  authorRole: users.role,
}

type RawMessageRow = {
  id: bigint
  channelId: number
  threadId: number | null
  replyToId: bigint | null
  kind: 'text' | 'system'
  contentMd: string
  contentHtml: string | null
  isDeleted: boolean
  editedAt: Date | null
  createdAt: Date
  attachmentCount: number
  reactionCount: number
  authorId: number | null
  authorHandle: string | null
  authorDisplayName: string | null
  authorAvatarUrl: string | null
  authorRole: 'member' | 'mod' | 'admin' | null
}

/**
 * 批量取附件并按 message_id 分组。
 *
 * 用一次 `IN (...)` 查询覆盖整页消息，而不是每条消息查一次 ——
 * 50 条消息 N+1 查询会让频道首屏慢一个数量级，这是列表类接口最典型的性能陷阱。
 */
async function loadAttachments(
  messageIds: bigint[],
): Promise<Map<string, PublicAttachment[]>> {
  const grouped = new Map<string, PublicAttachment[]>()
  if (messageIds.length === 0) return grouped

  const rows = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      filename: attachments.filename,
      mime: attachments.mime,
      size: attachments.size,
      storageKey: attachments.storageKey,
    })
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds))
    .orderBy(asc(attachments.id))

  for (const r of rows) {
    const key = r.messageId.toString()
    const list = grouped.get(key) ?? []
    list.push({
      id: r.id,
      message_id: key,
      filename: r.filename,
      mime: r.mime,
      size: r.size,
      url: attachmentUrl(r.storageKey),
      is_image: IMAGE_TYPES.has(r.mime),
    })
    grouped.set(key, list)
  }
  return grouped
}

/** 行 → 应用层类型。必须 await：附件要批量预取并挂上去 */
async function mapRows(rows: RawMessageRow[]): Promise<PublicMessage[]> {
  const withAttachments = await loadAttachments(rows.map((r) => r.id))
  return rows.map((r) =>
    toPublicMessage(
      { ...r, kind: r.kind, authorRole: r.authorRole } as MessageRow,
      withAttachments.get(r.id.toString()) ?? [],
    ),
  )
}

// ─────────────────────────────────────────────────────────────
// 频道
// ─────────────────────────────────────────────────────────────

export type ChannelSummary = {
  id: number
  slug: string
  name: string
  type: string
  topic: string | null
  categoryId: number | null
  parentChannelId: number | null
  readOnly: boolean
  archived: boolean
  messageCount: number
  lastMessageAt: string | null
  forumTags: string[]
  unread: number
}

export async function listChannels(userId?: number | null): Promise<{
  categories: { id: number; name: string; slug: string; description: string | null }[]
  channels: ChannelSummary[]
}> {
  const [cats, chans, unread] = await Promise.all([
    db.query.categories.findMany({ orderBy: (c, { asc: a }) => [a(c.position), a(c.id)] }),
    db.query.channels.findMany({ orderBy: (c, { asc: a }) => [a(c.position), a(c.id)] }),
    countUnreadByChannel(userId ?? null),
  ])

  return {
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
    })),
    channels: chans
      // 顶层列表只展示非 thread；thread 从消息里进入
      .filter((c) => c.type !== 'thread' && !c.archived)
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        type: c.type,
        topic: c.topic,
        categoryId: c.categoryId,
        parentChannelId: c.parentChannelId,
        readOnly: c.readOnly,
        archived: c.archived,
        messageCount: c.messageCount,
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
        forumTags: c.forumTags ?? [],
        unread: unread.get(c.id) ?? 0,
      })),
  }
}

/**
 * 每个频道的未读数。
 *
 * ── 三个刻意的设计 ────────────────────────────────────────────────
 *
 * 1. **一条聚合查询覆盖所有频道**，不做 N+1。
 *    侧栏在每个页面都要渲染，N 条查询会让每个请求都多几十次往返。
 *
 * 2. **不把自己发的消息算作未读。** 用户刚发完就看到红点是很典型的体验 bug，
 *    而它恰恰只在"读位点未推进时"才暴露，容易漏测。
 *
 * 3. **没有 read_states 记录 = 0 未读**（而不是"全部未读"）。
 *    否则新用户一进站就看到满屏红点，第一印象直接崩掉。
 *    代价是"历史消息不会被提示"，这对新用户是正确的取舍。
 */
export async function countUnreadByChannel(
  userId: number | null,
): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  if (!userId) return result

  const rows = await db
    .select({
      channelId: channels.id,
      unread: sql<number>`count(${messages.id})`,
    })
    .from(channels)
    .leftJoin(
      readStates,
      and(eq(readStates.channelId, channels.id), eq(readStates.userId, userId)),
    )
    .leftJoin(
      messages,
      and(
        eq(messages.channelId, channels.id),
        eq(messages.isDeleted, false),
        sql`${messages.id} > coalesce(${readStates.lastReadMessageId}, 0)`,
        // 自己发的不算未读
        sql`(${messages.authorId} is null or ${messages.authorId} <> ${userId})`,
      ),
    )
    .where(eq(channels.archived, false))
    .groupBy(channels.id)

  for (const r of rows) {
    // count() 返回 bigint 字符串，必须显式转换
    const n = Number(r.unread ?? 0)
    if (Number.isFinite(n) && n > 0) result.set(r.channelId, n)
  }
  return result
}

export async function getChannelBySlug(slug: string) {
  const row = await db.query.channels.findFirst({ where: eq(channels.slug, slug) })
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    topic: row.topic,
    categoryId: row.categoryId,
    parentChannelId: row.parentChannelId,
    readOnly: row.readOnly,
    archived: row.archived,
    messageCount: row.messageCount,
    forumTags: row.forumTags ?? [],
  }
}

export async function getChannelById(id: number) {
  return db.query.channels.findFirst({ where: eq(channels.id, id) })
}

// ─────────────────────────────────────────────────────────────
// 搜索
// ─────────────────────────────────────────────────────────────

/**
 * 消息搜索。
 *
 * 用 pg_trgm 的相似度而不是 LIKE '%...%'：
 *   - LIKE 无法走索引（前导通配符），数据量上来后必然全表扫描
 *   - trgm 有 GIN 索引可走，且对中文按字符三元组切分，无需分词器
 *
 * 阈值 0.08 是经验值：太低会返回大量无关结果，太高会漏掉短词查询
 * （三个汉字以下的查询相似度天然偏低）。上线后应按实际召回情况调整。
 *
 * 排序刻意用 created_at DESC 而不是相似度：社区里"最近的讨论"比
 * "字面最像的旧帖"更有价值。
 */
export async function searchMessages(opts: {
  query: string
  limit?: number
  channelId?: number | null
}): Promise<PublicMessage[]> {
  const q = opts.query.trim()
  if (q.length < 2) return []

  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50)
  const conditions = [
    sql`similarity(${messages.contentMd}, ${q}) > 0.08`,
    eq(messages.isDeleted, false),
  ]
  if (opts.channelId) conditions.push(eq(messages.channelId, opts.channelId))

  const rows = await db
    .select(messageSelection)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit)

  return mapRows(rows as RawMessageRow[])
}

/**
 * 当前可见频道集合。
 *
 * P0 的可见性模型：公开社区 = 所有频道对所有人（含游客）可读，仅排除归档。
 * 将来要加"私密频道"时，**只需要改这一个函数**：
 *   - 库里加 channels.visibility / 或 channel_role_access 表
 *   - 这里按 userId 过滤
 * SSE 补齐、降级轮询、搜索都复用它，改动面因此是收敛的。
 */
export async function listVisibleChannelIds(): Promise<number[]> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.archived, false))
  return rows.map((r) => r.id)
}

// ─────────────────────────────────────────────────────────────
// 消息读取
// ─────────────────────────────────────────────────────────────

export type MessagePage = {
  messages: PublicMessage[]
  /** 下一页（更早的消息）游标；最老一条的 id */
  nextCursor: string | null
  hasMore: boolean
}

/**
 * 按频道取消息。
 *
 * @param before 传 id 表示取更早的消息（向上滚动加载历史）
 * @param after  传 id 表示取更新的消息（断线补齐 / 增量）
 *
 * 两者都不传时返回最新的一页。返回始终按时间升序，方便直接渲染。
 */
export async function listMessages(opts: {
  channelId: number
  limit?: number
  before?: bigint | null
  after?: bigint | null
}): Promise<MessagePage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const conditions = [eq(messages.channelId, opts.channelId)]

  if (opts.before) conditions.push(lt(messages.id, opts.before))
  if (opts.after) conditions.push(gt(messages.id, opts.after))

  const rows = await db
    .select(messageSelection)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(...conditions))
    // 取 limit+1 条来判断是否还有更多，避免额外的 COUNT(*)
    .orderBy(desc(messages.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const ordered = [...page].reverse()

  return {
    messages: await mapRows(ordered as RawMessageRow[]),
    nextCursor: hasMore && ordered.length > 0 ? ordered[0]!.id.toString() : null,
    hasMore,
  }
}

/**
 * SSE 断线补齐 / 降级轮询的共用查询。
 *
 * 刻意按 id 全局过滤而不是按频道：客户端可能同时订阅多个频道，
 * 用一条 SQL 拿到所有增量，比拼 N 次查询便宜得多。
 *
 * 上限由调用方（SSE_MAX_BACKLOG）控制，超出的部分由客户端重新拉首屏。
 */
export async function listMessagesSince(opts: {
  channelIds: number[]
  since: bigint
  limit: number
  /** 排除自己发的消息可减少回显（客户端本地已乐观插入） */
  excludeAuthorId?: number | null
}): Promise<PublicMessage[]> {
  if (opts.channelIds.length === 0) return []

  const conditions = [
    inArray(messages.channelId, opts.channelIds),
    gt(messages.id, opts.since),
  ]

  if (opts.excludeAuthorId != null) {
    conditions.push(
      or(isNull(messages.authorId), sql`${messages.authorId} <> ${opts.excludeAuthorId}`)!,
    )
  }

  const rows = await db
    .select(messageSelection)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(...conditions))
    .orderBy(asc(messages.id))
    .limit(opts.limit)

  return mapRows(rows as RawMessageRow[])
}

/** 游标推进用：某频道当前的全局最大 id。空频道返回 0n */
export async function latestMessageId(): Promise<bigint> {
  const rows = await db
    .select({ max: sql<string | null>`max(${messages.id})` })
    .from(messages)
    .limit(1)
  const raw = rows[0]?.max
  return raw ? BigInt(raw) : 0n
}

/**
 * 单条消息（带作者信息）。
 * 写路径插入后需要它来构造事件广播——不能用手头的用户对象拼，
 * 因为那样会漏掉 display_name/avatar 等字段，导致不同客户端渲染不一致。
 */
export async function getMessageById(id: bigint): Promise<PublicMessage | null> {
  const rows = await db
    .select(messageSelection)
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(eq(messages.id, id))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return (await mapRows([row as RawMessageRow]))[0]!
}

// ─────────────────────────────────────────────────────────────
// 已读位点
// ─────────────────────────────────────────────────────────────

export async function listReadStates(
  userId: number,
): Promise<{ channelId: number; lastReadMessageId: bigint; mentionCount: number }[]> {
  const rows = await db
    .select({
      channelId: readStates.channelId,
      lastReadMessageId: readStates.lastReadMessageId,
      mentionCount: readStates.mentionCount,
    })
    .from(readStates)
    .where(eq(readStates.userId, userId))
  return rows
}

/**
 * 推进已读位点。
 *
 * `where last_read_message_id < excluded.id` 这行是必需的：
 * 并发的两个请求（例如两个标签页）可能乱序到达，
 * 没有它就会出现"已读位点倒退"，用户会看到已经读过的消息重新变成未读。
 */
export async function markRead(
  userId: number,
  channelId: number,
  messageId: bigint,
): Promise<void> {
  await db
    .insert(readStates)
    .values({ userId, channelId, lastReadMessageId: messageId })
    .onConflictDoUpdate({
      target: [readStates.userId, readStates.channelId],
      set: {
        lastReadMessageId: sql`greatest(${readStates.lastReadMessageId}, excluded.last_read_message_id)`,
        updatedAt: new Date(),
      },
    })
}

// ─────────────────────────────────────────────────────────────
// 写入
// ─────────────────────────────────────────────────────────────

export type InsertMessageInput = {
  id: bigint
  channelId: number
  authorId: number | null
  contentMd: string
  contentHtml: string
  replyToId?: bigint | null
  threadId?: number | null
  kind?: 'text' | 'system'
  attachmentCount?: number
}

/**
 * 插入消息并同步维护频道的冗余计数。
 *
 * 必须在同一个事务里做两件事，理由：列表页排序依赖 channels.last_message_at。
 * 若分两次提交，进程崩在中间会让频道列表的顺序永久错乱，且很难发现。
 */
export async function insertMessage(input: InsertMessageInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(messages).values({
      id: input.id,
      channelId: input.channelId,
      authorId: input.authorId,
      kind: input.kind ?? 'text',
      contentMd: input.contentMd,
      contentHtml: input.contentHtml,
      replyToId: input.replyToId ?? null,
      threadId: input.threadId ?? null,
      attachmentCount: input.attachmentCount ?? 0,
    })

    await tx
      .update(channels)
      .set({
        messageCount: sql`${channels.messageCount} + 1`,
        lastMessageAt: new Date(),
      })
      .where(eq(channels.id, input.channelId))
  })
}

export async function softDeleteMessage(messageId: bigint, deletedBy: number): Promise<boolean> {
  const result = await db
    .update(messages)
    .set({ isDeleted: true, deletedBy, contentHtml: null })
    .where(and(eq(messages.id, messageId), eq(messages.isDeleted, false)))
  return (result.rowCount ?? 0) > 0
}

export { parseId }
