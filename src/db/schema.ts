/**
 * 数据模型 —— 频道制公开技术社区
 *
 * 三条硬性约定，改动前务必先读：
 *
 * 1. `messages.id` 是 Snowflake（bigint，全局单调递增）。
 *    - 时间有序 ⇒ 游标分页只需 `WHERE channel_id = ? AND id < ? ORDER BY id DESC`
 *    - JS 侧必须用 BigInt 处理，出 JSON 时序列化为字符串（见 src/lib/serialize.ts）
 *    - 禁止改成 bigserial：那会失去"ID 即时间序"，分页与 SSE 补齐都会退化
 *
 * 2. `messages` 只保留 `(channel_id, id DESC)` 这一个核心索引。
 *    这是全站增长最快的表，多一个索引就多一份写入开销。
 *
 * 3. 所有时间列统一 `timestamptz`，DB 侧存 UTC，展示时区在应用层处理。
 */
import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

// ─────────────────────────────────────────────────────────────
// 枚举
// ─────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['member', 'mod', 'admin'])
export const userStatusEnum = pgEnum('user_status', ['active', 'muted', 'banned'])
export const channelTypeEnum = pgEnum('channel_type', ['text', 'forum', 'announce', 'thread'])
export const reportStatusEnum = pgEnum('report_status', ['open', 'resolved', 'dismissed'])
export const reportTargetEnum = pgEnum('report_target', ['message', 'user'])
export const messageKindEnum = pgEnum('message_kind', ['text', 'system'])

// ─────────────────────────────────────────────────────────────
// 用户与角色
// ─────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    handle: varchar('handle', { length: 32 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 48 }),
    avatarUrl: text('avatar_url'),
    bio: varchar('bio', { length: 300 }),
    role: userRoleEnum('role').notNull().default('member'),
    status: userStatusEnum('status').notNull().default('active'),
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
    /** 信任等级：0=新人（受限流），1=已验证，2=活跃 */
    trustLevel: smallint('trust_level').notNull().default(0),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // citext 的替代：统一小写后唯一。写入前必须 lowercase
    uniqueIndex('users_handle_key').on(sql`lower(${t.handle})`),
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
  ],
)

export const roles = pgTable(
  'roles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: varchar('name', { length: 32 }).notNull().unique(),
    /** 权限位，见 src/lib/permissions.ts。应用层显式写入，不用 DB 默认值 */
    permissions: bigint('permissions', { mode: 'bigint' }).notNull(),
    position: integer('position').notNull().default(0),
    /** 是否可被管理员手动授予 */
    assignable: boolean('assignable').notNull().default(true),
  },
)

export const memberRoles = pgTable(
  'member_roles',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'number' })
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    grantedBy: bigint('granted_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
)

// ─────────────────────────────────────────────────────────────
// 频道结构
// ─────────────────────────────────────────────────────────────

export const categories = pgTable('categories', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 48 }).notNull(),
  slug: varchar('slug', { length: 48 }).notNull().unique(),
  description: varchar('description', { length: 200 }),
  position: integer('position').notNull().default(0),
})

export const channels = pgTable(
  'channels',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    categoryId: bigint('category_id', { mode: 'number' }).references(() => categories.id, {
      onDelete: 'set null',
    }),
    type: channelTypeEnum('type').notNull().default('text'),
    name: varchar('name', { length: 64 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull().unique(),
    topic: varchar('topic', { length: 300 }),
    position: integer('position').notNull().default(0),
    /** type='thread' 时指向宿主频道；forum 帖子的回复 thread 也挂在这里 */
    parentChannelId: bigint('parent_channel_id', { mode: 'number' }),
    /** forum 类型帖子的标签 */
    forumTags: text('forum_tags').array(),
    /** 只读频道（如 #规则）：仅特定权限可发言 */
    readOnly: boolean('read_only').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    /** 冗余计数，同事务更新，避免列表页 COUNT(*) */
    messageCount: integer('message_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('channels_category_pos_idx').on(t.categoryId, t.position),
    index('channels_parent_idx').on(t.parentChannelId),
    index('channels_last_message_idx').on(t.lastMessageAt),
  ],
)

// ─────────────────────────────────────────────────────────────
// 消息（核心表）
// ─────────────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    /** Snowflake。DB 侧为 bigint，Node 侧为 BigInt，JSON 侧为 string */
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: bigint('author_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    kind: messageKindEnum('kind').notNull().default('text'),
    contentMd: text('content_md').notNull().default(''),
    /** 渲染缓存。消毒后的 HTML，读取时直接用，避免每次重新解析 Markdown */
    contentHtml: text('content_html'),
    /** 引用回复 */
    replyToId: bigint('reply_to_id', { mode: 'bigint' }),
    /** 所属 thread 频道（用于把回复折叠到 thread 内） */
    threadId: bigint('thread_id', { mode: 'number' }),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedBy: bigint('deleted_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    editCount: smallint('edit_count').notNull().default(0),
    attachmentCount: smallint('attachment_count').notNull().default(0),
    reactionCount: integer('reaction_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ★ 游标分页唯一需要的索引。也是 SSE 补齐（id > cursor）的走法
    index('messages_channel_id_idx').on(t.channelId, sql`${t.id} DESC`),
    index('messages_thread_idx').on(t.threadId, t.id),
    index('messages_reply_idx').on(t.replyToId),
    index('messages_author_idx').on(t.authorId, sql`${t.id} DESC`),
    // 内置中英文搜索索引。由手写迁移 0001 创建（GIN + pg_trgm），
    // 这里声明出来是为了让 drizzle-kit 之后 diff schema 时不会把它删掉。
    index('messages_content_trgm_idx').using(
      'gin',
      sql`${t.contentMd} gin_trgm_ops`,
    ),
  ],
)

export const messageEdits = pgTable(
  'message_edits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    contentMd: text('content_md').notNull(),
    editedBy: bigint('edited_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('message_edits_message_idx').on(t.messageId, t.id)],
)

export const attachments = pgTable(
  'attachments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // NOT NULL：附件必须先挂到一条已存在的消息上（见 /api/attachments 的流程说明）。
    // 允许为空会引入"孤儿附件"这个状态，而它没有任何业务含义，只会让查询到处要判空。
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    uploaderId: bigint('uploader_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    filename: varchar('filename', { length: 255 }).notNull(),
    mime: varchar('mime', { length: 128 }).notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attachments_message_idx').on(t.messageId)],
)

export const reactions = pgTable(
  'reactions',
  {
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
)

// ─────────────────────────────────────────────────────────────
// 已读位点 / 用户偏好
// ─────────────────────────────────────────────────────────────

export const readStates = pgTable(
  'read_states',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'bigint' }).notNull().default(sql`0`),
    mentionCount: integer('mention_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
)

// ─────────────────────────────────────────────────────────────
// 会话
// ─────────────────────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    /** 存的是 token 的 SHA-256，不是 token 本身 */
    id: varchar('id', { length: 64 }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: varchar('user_agent', { length: 300 }),
    ip: varchar('ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)

// ─────────────────────────────────────────────────────────────
// 社区治理：举报 / 封禁 / 审计 / 限流
// ─────────────────────────────────────────────────────────────

export const reports = pgTable(
  'reports',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    reporterId: bigint('reporter_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    targetType: reportTargetEnum('target_type').notNull(),
    messageId: bigint('message_id', { mode: 'bigint' }),
    targetUserId: bigint('target_user_id', { mode: 'number' }),
    channelId: bigint('channel_id', { mode: 'number' }),
    reason: varchar('reason', { length: 500 }).notNull(),
    status: reportStatusEnum('status').notNull().default('open'),
    handledBy: bigint('handled_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    handledAt: timestamp('handled_at', { withTimezone: true }),
    resolutionNote: varchar('resolution_note', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reports_status_idx').on(t.status, t.createdAt)],
)

export const bans = pgTable(
  'bans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 500 }).notNull(),
    /** 参与审核留痕的举报单 */
    reportId: bigint('report_id', { mode: 'number' }),
    until: timestamp('until', { withTimezone: true }),
    createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bans_user_idx').on(t.userId)],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: bigint('actor_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** 受控词表见 src/lib/audit.ts，禁止自由文本 */
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: varchar('target_id', { length: 64 }).notNull(),
    meta: jsonb('meta'),
    ip: varchar('ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
  ],
)

/**
 * 速率限制的持久化兜底（进程内 LRU 是第一道，这里防重启绕过）
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: varchar('key', { length: 160 }).primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
  },
)

/**
 * 密码重置令牌。
 *
 * ── 三条不能省的约定 ────────────────────────────────────────────────
 *
 * 1. **只存 token 的 SHA-256，不存 token 本身。**
 *    与 `sessions` 同一个理由：数据库泄露时，攻击者拿到的是哈希，
 *    不能直接拿去重置别人的密码。这也意味着**令牌一旦生成就无法再读出**，
 *    所以邮件必须在那一次请求里发出去，不能"先入库、稍后补发"。
 *
 * 2. **一次性 + 限期。** `usedAt` 非空即视为已用尽；`expiresAt` 之后失效。
 *    校验逻辑在 `src/lib/reset-policy.ts`（纯函数，有单测）。
 *
 * 3. **一个用户同时只应有一个有效令牌。** 签发新令牌时会把旧的标记作废
 *    （见 `createPasswordReset()`）—— 否则用户点三次"发送重置邮件"，
 *    前两封里的链接依然有效，等于把攻击面乘了三倍。
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** token 的 SHA-256（hex，64 字符）。唯一索引保证不会撞车 */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** 申请时的来源 IP。多次申请来自同一 IP 是排查滥用的第一条线索 */
    requestedIp: varchar('requested_ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_resets_token_key').on(t.tokenHash),
    index('password_resets_user_idx').on(t.userId, t.createdAt),
  ],
)

// ─────────────────────────────────────────────────────────────
// 关联（供 drizzle relational query 使用）
// ─────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  messages: many(messages),
  roles: many(memberRoles),
}))

export const categoriesRelations = relations(categories, ({ many }) => ({
  channels: many(channels),
}))

export const channelsRelations = relations(channels, ({ one, many }) => ({
  category: one(categories, {
    fields: [channels.categoryId],
    references: [categories.id],
  }),
  parent: one(channels, {
    fields: [channels.parentChannelId],
    references: [channels.id],
    relationName: 'channel_threads',
  }),
  messages: many(messages),
}))

export const messagesRelations = relations(messages, ({ one, many }) => ({
  channel: one(channels, {
    fields: [messages.channelId],
    references: [channels.id],
  }),
  author: one(users, {
    fields: [messages.authorId],
    references: [users.id],
  }),
  attachments: many(attachments),
  reactions: many(reactions),
  edits: many(messageEdits),
}))
