'use client'

/**
 * SSE 客户端 hook —— 单连接多路复用 + 自动降级轮询。
 *
 * ── 关键行为 ────────────────────────────────────────────────────
 * 1. 全站只维持 **一条** EventSource（浏览器对同源 HTTP/1.1 有 6 连接上限）
 * 2. 游标持久化在 ref 里，重连时通过 `?since=` 传给服务端补齐
 *    （EventSource 自身也会带 Last-Event-ID，服务端优先取该头，两者互为兜底）
 * 3. 收到 `resync` 事件表示服务端要求重新拉取——交给页面自行处理（通常是
 *    调用一个 refresh 回调重新取当前频道首屏）
 * 4. 连续失败达阈值后切换到轮询 `/api/sync`，并指数退避尝试恢复 SSE
 *
 * ── 为什么"新增"和"变更"必须是两个回调 ──────────────────────────────
 *
 * 早期版本把 `message.created` / `message.updated` / `message.deleted`
 * 三种事件都塞进 `onMessages`，而那条路径按 id 去重：
 *
 *     if (seen.has(m.id)) continue
 *
 * 于是"已存在消息的变更"被无条件丢弃，表现为：别人看不到你的编辑、
 * 看不到附件被补上、也看不到消息被删除。它不报错、连接状态还显示
 * "实时已连接"，所以从外部完全看不出问题。
 *
 * 新增要**按 id 去重**，变更必须**按 id 覆盖** —— 两个相反的语义，
 * 不能共用一个入口。归并逻辑本身在 `src/lib/message-list.ts`（纯函数、有单测）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicMessage } from '@/lib/serialize'

export type StreamStatus = 'connecting' | 'live' | 'polling' | 'offline'

type Options = {
  /** 初始游标。首次渲染时由服务端传入"当前最大消息 id" */
  initialCursor: string
  /** 是否启用（未登录时不启用，避免 401 重连风暴） */
  enabled: boolean
  /** 收到**新消息**时回调。多条按 id 升序依次回调 */
  onMessages: (messages: PublicMessage[]) => void
  /**
   * 收到**已存在消息的变更**时回调（编辑 / 附件补充 / 删除）。
   * 调用方应当按 id 覆盖，**不要**再去重跳过。
   */
  onUpdates?: (messages: PublicMessage[]) => void
  /**
   * 重新建立连接（或进入降级轮询）后回调。
   *
   * 用途：SSE 的补齐流是按 id 的增量（`id > cursor`），而编辑与删除
   * **不产生新 id**，所以断线期间发生的变更根本不在补齐范围内。
   * 客户端必须借这个机会把可见窗口重取一遍，否则那些消息会永远停在旧内容。
   */
  onReconnected?: () => void
  /** 服务端要求重新同步（背压/补齐失败） */
  onResync?: () => void
}

/** SSE 连续失败多少次后降级为轮询 */
const FAILURES_BEFORE_POLLING = 3
/** 降级轮询间隔 */
const POLL_INTERVAL_MS = 5_000
/** SSE 重连尝试间隔上限 */
const MAX_RECONNECT_DELAY_MS = 30_000
/**
 * 降级轮询模式下，每多少次轮询做一次"窗口刷新"。
 *
 * `/api/sync` 同样只返回新增消息，所以轮询模式下编辑与删除也不会到达。
 * 每 6 次（约 30 秒）重取一次可见窗口来兜住这种情况 —— 比每次轮询都重取
 * 便宜 6 倍，又不会让降级用户永远看到旧内容。
 */
const POLLS_PER_WINDOW_REFRESH = 6

export function useEventStream({
  initialCursor,
  enabled,
  onMessages,
  onUpdates,
  onReconnected,
  onResync,
}: Options): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting')

  // 用 ref 保存游标与回调：它们的更新不应触发重连
  const cursorRef = useRef<string>(initialCursor)
  const onMessagesRef = useRef(onMessages)
  const onUpdatesRef = useRef(onUpdates)
  const onReconnectedRef = useRef(onReconnected)
  const onResyncRef = useRef(onResync)

  useEffect(() => {
    onMessagesRef.current = onMessages
  }, [onMessages])
  useEffect(() => {
    onUpdatesRef.current = onUpdates
  }, [onUpdates])
  useEffect(() => {
    onReconnectedRef.current = onReconnected
  }, [onReconnected])
  useEffect(() => {
    onResyncRef.current = onResync
  }, [onResync])

  // 服务端可能在初始渲染后产生新消息，这里同步游标（只前进，不回退）
  useEffect(() => {
    if (BigIntSafeGreater(initialCursor, cursorRef.current)) {
      cursorRef.current = initialCursor
    }
  }, [initialCursor])

  const applyMessages = useCallback((list: PublicMessage[]) => {
    if (list.length === 0) return
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const m of sorted) {
      if (BigIntSafeGreater(m.id, cursorRef.current)) cursorRef.current = m.id
    }
    onMessagesRef.current(sorted)
  }, [])

  /**
   * 变更事件：**不**推进游标，也**不**排序。
   * 更新的通常是旧消息，推进游标会把它误当成"已补齐"。
   */
  const applyUpdates = useCallback((list: PublicMessage[]) => {
    if (list.length === 0) return
    onUpdatesRef.current?.(list)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setStatus('offline')
      return
    }
    let disposed = false
    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let mode: 'sse' | 'poll' = 'sse'
    /** 首次连接不算"重连"：此时页面刚由服务端渲染，数据是新的 */
    let everConnected = false
    let pollsSinceRefresh = 0

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const pollOnce = async () => {
      try {
        const res = await fetch(
          `/api/sync?since=${encodeURIComponent(cursorRef.current)}`,
          { cache: 'no-store' },
        )
        if (res.status === 401) {
          if (!disposed) setStatus('offline')
          return
        }
        if (!res.ok) throw new Error(`sync ${res.status}`)
        const data = (await res.json()) as { messages: PublicMessage[] }
        if (disposed) return
        applyMessages(data.messages ?? [])
        setStatus('polling')

        // 轮询流里同样没有"变更"事件（按 id 增量），定期重取窗口兜住编辑与删除
        pollsSinceRefresh += 1
        if (pollsSinceRefresh >= POLLS_PER_WINDOW_REFRESH) {
          pollsSinceRefresh = 0
          onReconnectedRef.current?.()
        }
      } catch {
        if (!disposed) setStatus('offline')
      }
    }

    const startPolling = () => {
      if (pollTimer) return
      setStatus('polling')
      // 立刻拉一次，让用户马上看到积压的消息
      void pollOnce()
      pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS)
    }

    const scheduleReconnect = () => {
      if (disposed) return
      failures += 1
      if (failures >= FAILURES_BEFORE_POLLING) {
        // SSE 明显不可用（多半是中间层拦截 text/event-stream），先保证可用性
        startPolling()
      }
      const delay = Math.min(1000 * 2 ** failures, MAX_RECONNECT_DELAY_MS)
      reconnectTimer = setTimeout(() => {
        if (disposed) return
        connect()
      }, delay)
    }

    const connect = () => {
      if (disposed) return
      if (mode === 'poll' && pollTimer) return // 轮询模式仍会尝试升级回 SSE

      setStatus((s) => (s === 'live' ? s : 'connecting'))

      const url = `/api/events?since=${encodeURIComponent(cursorRef.current)}`
      es = new EventSource(url)

      es.addEventListener('open', () => {
        if (disposed) return
        failures = 0
        mode = 'sse'
        stopPolling()
        setStatus('live')

        // 重连（非首次）后重取可见窗口：断线期间的编辑/删除不在补齐范围内
        if (everConnected) onReconnectedRef.current?.()
        everConnected = true
      })

      const ingestNew = (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as { message?: PublicMessage }
          if (parsed.message) applyMessages([parsed.message])
        } catch {
          /* 单条事件解析失败不应中断整个流 */
        }
      }

      const ingestUpdate = (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as { message?: PublicMessage }
          if (parsed.message) applyUpdates([parsed.message])
        } catch {
          /* 忽略 */
        }
      }

      es.addEventListener('message.created', ingestNew)
      // ★ 变更走另一条回调 ★ 见文件头说明：走 onMessages 会被去重丢掉
      es.addEventListener('message.updated', ingestUpdate)
      es.addEventListener('message.deleted', ingestUpdate)

      es.addEventListener('resync', (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent<string>).data) as {
            reason?: string
            cursor?: string
          }
          // 握手事件会带 cursor，用于校准；背压事件要求整页重拉
          if (parsed.reason === 'ready' && parsed.cursor) {
            if (BigIntSafeGreater(parsed.cursor, cursorRef.current)) {
              cursorRef.current = parsed.cursor
            }
            return
          }
          onResyncRef.current?.()
        } catch {
          onResyncRef.current?.()
        }
      })

      es.addEventListener('error', () => {
        if (disposed) return
        // EventSource 会自动重连，但它的退避策略不可控且不感知"被中间层拦截"，
        // 因此这里主动关闭并自行调度，以便切换到轮询。
        es?.close()
        es = null
        if (!disposed) setStatus('connecting')
        scheduleReconnect()
      })
    }

    connect()

    return () => {
      disposed = true
      es?.close()
      stopPolling()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [enabled, applyMessages, applyUpdates])

  return status
}

/**
 * 字符串形式的 Snowflake id 比较。
 * 等长数字串的字典序与数值序一致；长度不同时长者更大。
 * 不直接 BigInt() 是为了避免在非数字游标（如 '0'）上抛异常。
 */
function BigIntSafeGreater(a: string, b: string): boolean {
  if (a === b) return false
  if (a.length !== b.length) return a.length > b.length
  return a > b
}
