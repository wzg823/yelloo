/**
 * 序列化工具。
 *
 * 唯一的目的是：把数据库行安全地变成 JSON。
 * 两个必须处理的类型：
 *   - BigInt（Snowflake 主键）：JSON.stringify 直接抛 TypeError，必须转字符串
 *   - Date：统一转 ISO 8601 字符串，避免前后端时区理解不一致
 *
 * 前端约定：所有 ID 以 string 传输，需要比较/排序时用 BigInt() 或直接字符串比较
 * （Snowflake 定长且单调，等长数字的字符串比较与数值比较等价）。
 */

export function toJson<T>(value: T): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((v) => toJson(v))
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJson(v)
    }
    return out
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  return null
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** JSON 响应助手：自动处理 BigInt/Date */
export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(toJson(data)), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}

export function errorResponse(status: number, message: string, code?: string): Response {
  return jsonResponse({ error: message, code }, { status })
}

/**
 * 附件对外形状。
 *
 * `url` 指向 Caddy 直出的 `/_uploads/<storageKey>`，**不经过 Node**。
 * 这样大文件下载不会占用应用的事件循环，也是本方案把附件流量摘出应用的关键。
 */
export type PublicAttachment = {
  id: number
  message_id: string
  filename: string
  mime: string
  size: number
  url: string
  is_image: boolean
}

/**
 * 消息对外形状。显式列出字段而不是把整行丢出去，
 * 避免将来加了敏感列（如 ip、内部标记）时被意外泄露。
 */
export type PublicMessage = {
  id: string
  channel_id: number
  thread_id: number | null
  reply_to_id: string | null
  author: {
    id: number
    handle: string
    display_name: string | null
    avatar_url: string | null
    role: string
  } | null
  kind: string
  content_md: string
  content_html: string | null
  is_deleted: boolean
  edited_at: string | null
  created_at: string
  attachment_count: number
  reaction_count: number
  /** 批量预取后填充；为空数组而不是 undefined，省去前端判断 */
  attachments: PublicAttachment[]
}

export type MessageRow = {
  id: bigint
  channelId: number
  threadId: number | null
  replyToId: bigint | null
  kind: string
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
  authorRole: string | null
}

export function toPublicMessage(
  row: MessageRow,
  attachments: PublicAttachment[] = [],
): PublicMessage {
  return {
    id: row.id.toString(),
    channel_id: row.channelId,
    thread_id: row.threadId,
    reply_to_id: row.replyToId ? row.replyToId.toString() : null,
    author:
      row.authorId == null
        ? null
        : {
            id: row.authorId,
            handle: row.authorHandle ?? '已注销',
            display_name: row.authorDisplayName,
            avatar_url: row.authorAvatarUrl,
            role: row.authorRole ?? 'member',
          },
    kind: row.kind,
    // 软删除后正文必须清空：不能只靠前端隐藏
    content_md: row.isDeleted ? '' : row.contentMd,
    content_html: row.isDeleted ? null : row.contentHtml,
    is_deleted: row.isDeleted,
    edited_at: row.editedAt ? row.editedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    attachment_count: row.attachmentCount,
    // 已删除的消息连附件也不返回：否则内容通过附件绕过了删除
    attachments: row.isDeleted ? [] : attachments,
    reaction_count: row.reactionCount,
  }
}
