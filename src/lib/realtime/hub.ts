/**
 * 实时扇出（Fanout）。
 *
 * ── 当前实现：进程内 ────────────────────────────────────────────────
 * 单实例部署（P0~P2 的正确选择）。用户连接存在 Map 里，发布消息时遍历其频道集合。
 *
 * ── 扩展到多实例时怎么办 ───────────────────────────────────────────
 * 关键取舍：**不需要引入 Redis**。Postgres 自带的 LISTEN/NOTIFY 就能满足：
 *
 *   publish():  写库后 `SELECT pg_notify('bbs_events', json)`
 *   启动时:     建一个专用连接执行 `LISTEN bbs_events`
 *   收到通知:   调用本地 hub.deliver() 分发给本实例上的连接
 *
 * 只需替换本文件的 publish/deliver 两个函数，路由与前端代码零改动。
 * 注意 NOTIFY 载荷上限 8000 字节 ⇒ 只广播"有新消息 + 频道 id + 消息 id"，
 * 客户端收到后按 id 拉取，不要把消息正文塞进通知。
 *
 * ── 生产注意 ───────────────────────────────────────────────────────
 * `next start` 默认单进程。若将来用 PM2/cluster 或 Node cluster 起多进程，
 * 进程内 Map 就会失效（用户连到 A 进程，消息从 B 进程发出）。
 * 那时必须切换到上述 LISTEN/NOTIFY 方案。
 */

export type ServerEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'channel.updated'
  | 'typing'
  /** 服务端要求客户端重新拉取（背压丢弃、被踢下线等场景） */
  | 'resync'

export type ServerEvent = {
  type: ServerEventType
  /**
   * 事件游标。用 message.id（Snowflake）而非自增序号，
   * 因为 SSE 的 Last-Event-ID 需要它来做断线补齐。
   */
  cursor: string
  channelId: number | null
  payload: unknown
}

export type Sink = {
  /** 返回 false 表示发送失败（连接已断），hub 会立即清理该连接 */
  send(chunk: string): boolean
}

type Entry = {
  /** 同一用户可开多个标签页 */
  sinks: Set<Sink>
  /** 该连接关心的频道集合 */
  channels: Set<number>
}

const globalForHub = globalThis as unknown as {
  __bbsHub?: Map<number, Entry>
}

const hub: Map<number, Entry> = globalForHub.__bbsHub ?? new Map()
globalForHub.__bbsHub = hub

/**
 * 注册一个用户连接。
 * @returns 清理函数——**必须在连接关闭时调用**，否则 Map 会随用户操作无限增长。
 */
export function registerSink(
  userId: number,
  sink: Sink,
  channels: Iterable<number> = [],
): () => void {
  let entry = hub.get(userId)
  if (!entry) {
    entry = { sinks: new Set(), channels: new Set() }
    hub.set(userId, entry)
  }
  entry.sinks.add(sink)
  for (const c of channels) entry.channels.add(c)

  return () => {
    const current = hub.get(userId)
    if (!current) return
    current.sinks.delete(sink)
    if (current.sinks.size === 0) hub.delete(userId)
  }
}

/** 客户端滚动到新频道时，扩大该连接的订阅范围 */
export function addChannels(userId: number, channels: Iterable<number>): void {
  const entry = hub.get(userId)
  if (!entry) return
  for (const c of channels) entry.channels.add(c)
}

/** 把事件投递给"关心该频道"的所有本地连接 */
export function deliver(event: ServerEvent): number {
  const chunk = formatSse(event)
  let delivered = 0

  for (const [userId, entry] of hub) {
    // channelId 为 null 表示全局事件（如 resync），投给所有人
    if (event.channelId !== null && !entry.channels.has(event.channelId)) continue

    for (const sink of entry.sinks) {
      if (!sink.send(chunk)) {
        entry.sinks.delete(sink)
      } else {
        delivered += 1
      }
    }
    if (entry.sinks.size === 0) hub.delete(userId)
  }

  return delivered
}

/** 强制断开某用户的所有连接（封禁、改密码时使用） */
export function disconnectUser(userId: number, reason = 'session_revoked'): void {
  const entry = hub.get(userId)
  if (!entry) return
  const chunk = formatSse({
    type: 'resync',
    cursor: '0',
    channelId: null,
    payload: { reason },
  })
  for (const sink of entry.sinks) sink.send(chunk)
  hub.delete(userId)
}

/** 运维观测用 */
export function hubStats(): { users: number; connections: number } {
  let connections = 0
  for (const entry of hub.values()) connections += entry.sinks.size
  return { users: hub.size, connections }
}

/**
 * SSE 报文格式。注意 `data` 里不能出现裸换行（会截断事件），
 * 因此统一 JSON.stringify 后再发送——JSON 字符串内的换行会被转义为 \n。
 */
export function formatSse(event: ServerEvent): string {
  const payload =
    event.payload === undefined ? '{}' : JSON.stringify(event.payload) ?? '{}'
  return [
    `event: ${event.type}`,
    `id: ${event.cursor}`,
    `data: ${payload}`,
    '',
    '',
  ].join('\n')
}

/** 心跳：SSE 注释行，用于保持连接并探测死连接 */
export function heartbeatChunk(): string {
  return `: hb ${Date.now()}\n\n`
}
