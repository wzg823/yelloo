/**
 * SSE 实时事件流 —— 单连接多路复用。
 *
 * ── 为什么是"一条连接"而不是"每频道一条" ───────────────────────────
 * 浏览器对同源 HTTP/1.1 连接有 6 条上限。若每个频道开一条 EventSource，
 * 用户切换 7 个频道就会把整个页面的其他请求全部饿死。因此：
 *   - 每个登录用户只维持 **1** 条 SSE 连接
 *   - 服务端按"该用户可见的频道集合"过滤后推送
 *
 * ── 断线补齐协议 ─────────────────────────────────────────────────
 * EventSource 在重连时会自动带上 `Last-Event-ID` 头。我们把它当游标：
 *   1. 命中 → 从 DB 补发该 id 之后的消息，再切到实时广播（期间不丢事件）
 *   2. 未命中（首次连接）→ 客户端显式传 `?since=<cursor>`；
 *      仍无 → 不下发历史，由客户端自行拉首屏
 *
 * ── 背压 ────────────────────────────────────────────────────────
 * 慢客户端会造成服务端内存堆积。每个连接维护一个待发队列：
 *   队列超限 → 丢弃积压并下发 `resync`，让客户端重新拉一页。
 * 这比"无限缓冲直到 OOM"和"直接断开"都好：用户只会看到一次短暂的重新加载。
 *
 * ── 必须配合的部署设置 ───────────────────────────────────────────
 * 任何中间层都不能缓冲这个响应（Caddyfile 里 `flush_interval -1`，
 * 并且要对 /api/events 关闭 gzip）。否则表现为"消息要等几十秒才出现"。
 */
import type { NextRequest } from 'next/server'
import { hubStats, formatSse, heartbeatChunk, registerSink } from '@/lib/realtime/hub'
import { getCurrentUser } from '@/lib/session'
import { listMessagesSince, listVisibleChannelIds } from '@/lib/queries'
import { parseId } from '@/lib/snowflake'
import { toJson } from '@/lib/serialize'

export const runtime = 'nodejs'
// SSE 必须动态执行，任何缓存都会破坏实时性
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS ?? 25_000)
const MAX_CONNS_PER_USER = Number(process.env.SSE_MAX_CONNS_PER_USER ?? 3)
const MAX_BACKLOG = Number(process.env.SSE_MAX_BACKLOG ?? 500)
/** 补齐时单次从 DB 取的最大条数，防止长时间离线后一次性拉爆内存 */
const REPLAY_BATCH = 200
/** 补齐最多循环的批次数，硬上限防止异常情况下死循环 */
const REPLAY_MAX_BATCHES = 10

/** 每个用户的活跃连接（用于执行连接上限，踢掉被遗忘的标签页） */
const globalForSse = globalThis as unknown as {
  __bbsSseConns?: Map<number, Set<() => void>>
}
const connsByUser: Map<number, Set<() => void>> = globalForSse.__bbsSseConns ?? new Map()
globalForSse.__bbsSseConns = connsByUser

function trackConnection(userId: number, close: () => void): () => void {
  let set = connsByUser.get(userId)
  if (!set) {
    set = new Set()
    connsByUser.set(userId, set)
  }

  while (set.size >= MAX_CONNS_PER_USER) {
    const oldest = set.values().next().value as (() => void) | undefined
    if (!oldest) break
    set.delete(oldest)
    oldest()
  }

  set.add(close)

  return () => {
    const current = connsByUser.get(userId)
    if (!current) return
    current.delete(close)
    if (current.size === 0) connsByUser.delete(userId)
  }
}

export async function GET(req: NextRequest) {
  /**
   * 跨源拒绝。
   *
   * `EventSource` 会跟随同源策略带上 Cookie，但**中间层一旦配置不当**
   * （例如给 /api 加了 `Access-Control-Allow-Origin: *` 且允许凭证），
   * 第三方站点就能用一条 <script>/EventSource 读到登录用户的全部实时消息。
   * 因此这里显式检查 Origin，而不是依赖中间层配置正确。
   */
  const origin = req.headers.get('origin')
  if (origin) {
    const siteUrl = process.env.SITE_URL ?? ''
    let allowed = false
    try {
      allowed = new URL(origin).origin === new URL(siteUrl).origin
    } catch {
      allowed = false
    }
    // 本地开发允许同机不同端口（localhost:3000 ↔ 127.0.0.1:3000）
    if (!allowed) {
      allowed = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    }
    if (!allowed) {
      return new Response('cross-origin not allowed', { status: 403 })
    }
  }

  const user = await getCurrentUser()
  if (!user) {
    return new Response('unauthorized', { status: 401 })
  }

  const channelIds = await listVisibleChannelIds()

  // 游标来源优先级：Last-Event-ID 头 > ?since= 查询参数
  const lastEventId = req.headers.get('last-event-id')
  const sinceParam = req.nextUrl.searchParams.get('since')
  const since = parseId(lastEventId) ?? parseId(sinceParam) ?? 0n

  const encoder = new TextEncoder()

  let closed = false
  let backlog = 0

  // 用闭包变量而非类成员，方便 cancel() 与 start() 共享状态
  let releaseConn: () => void = () => {}
  let releaseSink: () => void = () => {}
  let stopHeartbeat: () => void = () => {}

  const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    async start(streamController) {
      /** 释放所有资源。可重复调用（幂等）——这是避免连接泄漏的关键 */
      const cleanup = () => {
        if (closed) return
        closed = true
        releaseSink()
        releaseConn()
        stopHeartbeat()
      }

      /**
       * @param closeStream 正在 abort 时传 false：此时流已由运行时接管，
       *                    再调 streamController.close() 会抛错并刷日志。
       */
      const close = (closeStream = true) => {
        if (closed) return
        cleanup()
        if (!closeStream) return
        try {
          streamController.close()
        } catch {
          /* 已经关闭 */
        }
      }

      // 用 close 注册连接上限管理；超限时踢掉最旧的连接
      releaseConn = trackConnection(user.id, () => close())

      // 客户端主动断开（关闭标签页 / 路由跳转）会触发 abort
      req.signal.addEventListener('abort', () => close(false))
      if (req.signal.aborted) {
        cleanup()
        return
      }

      const send = (chunk: string): boolean => {
        if (closed) return false
        try {
          streamController.enqueue(encoder.encode(chunk))
          return true
        } catch {
          // 写入失败说明对端已断开，立即释放资源而不是等心跳超时
          close()
          return false
        }
      }

      // ── 1) 先注册订阅，再补齐历史 ────────────────────────────
      // 顺序至关重要：若先补历史再注册，两步之间到达的新消息会永久丢失。
      // 先注册后，补齐期间到达的事件进入 pending 队列，补齐结束后按序 flush。
      const pending: string[] = []
      let flushing = false

      releaseSink = registerSink(
        user.id,
        {
          send(chunk: string) {
            if (closed) return false
            if (flushing) return send(chunk)

            if (backlog >= MAX_BACKLOG) {
              // 背压：丢弃积压并让客户端重拉，好过无限缓冲到 OOM
              pending.length = 0
              backlog = 0
              return send(
                formatSse({
                  type: 'resync',
                  cursor: '0',
                  channelId: null,
                  payload: { reason: 'backpressure', max: MAX_BACKLOG },
                }),
              )
            }

            pending.push(chunk)
            backlog += 1
            return true
          },
        },
        channelIds,
      )

      // ── 2) 补齐断线期间的消息 ────────────────────────────────
      let cursor = since
      if (since > 0n) {
        try {
          for (let batch = 0; batch < REPLAY_MAX_BATCHES; batch += 1) {
            const missed = await listMessagesSince({
              channelIds,
              since: cursor,
              limit: REPLAY_BATCH,
            })
            if (missed.length === 0) break

            let broke = false
            for (const m of missed) {
              cursor = BigInt(m.id)
              const ok = send(
                formatSse({
                  type: 'message.created',
                  cursor: m.id,
                  channelId: m.channel_id,
                  payload: { message: toJson(m) },
                }),
              )
              if (!ok) {
                broke = true
                break
              }
            }
            if (broke) break
            if (missed.length < REPLAY_BATCH) break
          }
        } catch (err) {
          console.error('[sse] replay failed:', err)
          send(
            formatSse({
              type: 'resync',
              cursor: '0',
              channelId: null,
              payload: { reason: 'replay_failed' },
            }),
          )
        }
      }

      // ── 3) 切到实时模式，flush 补齐期间积压的事件 ─────────────
      flushing = true
      for (const chunk of pending) {
        if (!send(chunk)) break
      }
      pending.length = 0
      backlog = 0
      if (closed) return

      // ── 4) 握手：告知服务端就绪与当前游标，客户端据此校准本地游标 ──
      send(
        formatSse({
          type: 'resync',
          cursor: cursor.toString(),
          channelId: null,
          payload: {
            reason: 'ready',
            channels: channelIds.length,
            heartbeat_ms: HEARTBEAT_MS,
            stats: hubStats(),
          },
        }),
      )

      // ── 5) 心跳 ─────────────────────────────────────────────
      // 作用有二：让中间层认为连接活跃；在写失败时及时发现死连接。
      const timer = setInterval(() => {
        if (!send(heartbeatChunk())) clearInterval(timer)
      }, HEARTBEAT_MS)
      timer.unref?.()

      stopHeartbeat = () => clearInterval(timer)
    },

    cancel() {
      // 消费端（浏览器）取消订阅：资源由 cleanup 释放，不再 close 流
      closed = true
      releaseSink()
      releaseConn()
      stopHeartbeat()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      // 明确禁止中间层缓冲（Caddy/Nginx 都认这个头）
      'X-Accel-Buffering': 'no',
    },
  })
}
