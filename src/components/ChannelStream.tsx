'use client'

/**
 * 频道消息流。
 *
 * 三个必须处理对的点，否则会以很难查的方式出错：
 *
 * 1. **去重**：SSE 推送、降级轮询、补齐重放三条路径可能送来同一条消息，
 *    必须按 id 去重（用 ref 保存 Set，避免每次 setState 都重建索引）。
 * 2. **乐观插入**：自己发的消息本地立即显示（带 pending 样式），
 *    收到服务端广播后按 id 替换。不做这步用户会感觉"发出去没反应"。
 * 3. **提交竞态**：服务端广播可能比 `await fetch` 的响应先到。
 *    因此乐观条目不绑定临时 id，而是靠「作者是自己 + 内容完全相同」来认领。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'
import { useEventStream, type StreamStatus } from '@/lib/useEventStream'
import { useSession } from '@/lib/session-context'
import type { PublicMessage } from '@/lib/serialize'

type Props = {
  channelId: number
  channelSlug: string
  initialMessages: PublicMessage[]
  initialCursor: string
  initialHasMore: boolean
  readOnly: boolean
}

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: '正在连接…',
  live: '实时已连接',
  polling: '降级为轮询（5 秒）',
  offline: '离线，请刷新页面',
}

export function ChannelStream({
  channelId,
  channelSlug,
  initialMessages,
  initialCursor,
  initialHasMore,
  readOnly,
}: Props) {
  const user = useSession()

  const [messages, setMessages] = useState<PublicMessage[]>(initialMessages)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [oldestCursor, setOldestCursor] = useState<string | null>(initialCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pending, setPending] = useState<PublicMessage[]>([])
  /** 正在上传附件的消息 id；用于在消息上显示上传中提示 */
  const [uploadingId, setUploadingId] = useState<string | null>(null)

  const seen = useRef<Set<string>>(new Set(initialMessages.map((m) => m.id)))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  // pending 同时存在 state（用于渲染）与 ref（用于在 useCallback 里读到最新值，
  // 避免把 pending 放进依赖数组导致回调每次渲染都重建、进而让 SSE 重连）
  const pendingRef = useRef<PublicMessage[]>([])
  const removePending = useCallback((id: string) => {
    pendingRef.current = pendingRef.current.filter((p) => p.id !== id)
    setPending(pendingRef.current)
  }, [])

  /** 刷新侧栏未读红点。失败静默——红点不准确不应打断阅读 */
  const refreshUnread = useCallback(() => {
    window.dispatchEvent(new Event('bbs:refresh-unread'))
  }, [])

  // ── 滚动跟随 ────────────────────────────────────────────────
  useEffect(() => {
    if (stickToBottom.current) {
      endRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [messages, pending])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 距底部 120px 内视为"正在看最新消息"，此时才自动滚动
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  // ── 接收消息 ────────────────────────────────────────────────
  const handleIncoming = useCallback(
    (incoming: PublicMessage[]) => {
      const fresh: PublicMessage[] = []
      // 每个批次只允许"认领"一个乐观条目，避免只有附件（content 为空）的消息
      // 把多条待确认条目一次全部误删
      let claimed = false

      for (const m of incoming) {
        // 服务端回显：与本地待确认条目是同一作者、同频道、同内容 → 视为同一条
        if (!claimed && user && m.author?.id === user.id && m.channel_id === channelId) {
          const idx = pending.some((p) => p.content_md === m.content_md)
          if (idx) {
            claimed = true
            const contentKey = m.content_md
            pendingRef.current = pendingRef.current.filter(
              (p) => !(p.channel_id === channelId && p.content_md === contentKey),
            )
            setPending(pendingRef.current)
            // 本地已乐观渲染，不再重复插入
            if (seen.current.has(m.id)) continue
            seen.current.add(m.id)
            setMessages((prev) => [...prev, m])
            continue
          }
        }

        if (seen.current.has(m.id)) continue
        seen.current.add(m.id)
        if (m.channel_id === channelId) fresh.push(m)
      }

      if (fresh.length === 0) return

      setMessages((prev) => [...prev, ...fresh])

      // 推进已读位点：失败不影响阅读，静默忽略
      const last = fresh[fresh.length - 1]
      if (last) {
        void fetch('/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_id: channelId, message_id: last.id }),
        })
          .then(() => refreshUnread())
          .catch(() => {})
      }
    },
    [channelId, user, pending, refreshUnread],
  )

  const handleResync = useCallback(async () => {
    // 服务端背压或补齐失败：重新拉取当前频道最后一页，并重置游标
    try {
      const res = await fetch(`/api/channels/${channelId}/messages?limit=50`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = (await res.json()) as {
        messages: PublicMessage[]
        has_more: boolean
        cursor: string | null
      }
      seen.current = new Set(data.messages.map((m) => m.id))
      setMessages(data.messages)
      setHasMore(data.has_more)
      setOldestCursor(data.cursor)
      stickToBottom.current = true
    } catch {
      /* 交给下一次 resync 或用户刷新 */
    }
  }, [channelId])

  const status = useEventStream({
    initialCursor,
    enabled: Boolean(user),
    onMessages: handleIncoming,
    onResync: handleResync,
  })

  // ── 加载更早的消息 ──────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!oldestCursor || loadingMore) return
    setLoadingMore(true)
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    try {
      const res = await fetch(
        `/api/channels/${channelId}/messages?before=${encodeURIComponent(oldestCursor)}&limit=50`,
        { cache: 'no-store' },
      )
      if (!res.ok) return
      const data = (await res.json()) as {
        messages: PublicMessage[]
        has_more: boolean
        cursor: string | null
      }
      for (const m of data.messages) seen.current.add(m.id)
      setMessages((prev) => [...data.messages, ...prev])
      setHasMore(data.has_more)
      setOldestCursor(data.cursor)
      // 保持视觉位置：插入内容后把滚动位置推回到原来的相对位置
      requestAnimationFrame(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = node.scrollHeight - prevHeight
      })
    } finally {
      setLoadingMore(false)
    }
  }, [channelId, oldestCursor, loadingMore])

  // ── 发送（含附件上传）───────────────────────────────────────
  const handleSend = useCallback(
    async (
      content: string,
      replyTo: PublicMessage | null,
      files: File[] = [],
    ): Promise<string | null> => {
      if (!user) return '请先登录'
      if (!content.trim() && files.length === 0) return '内容不能为空'

      const optimistic: PublicMessage = {
        // 负数 id 只用于本地 key，绝不会与服务端 Snowflake 冲突
        id: `-${Date.now()}`,
        channel_id: channelId,
        thread_id: null,
        reply_to_id: replyTo?.id ?? null,
        author: {
          id: user.id,
          handle: user.handle,
          display_name: user.displayName,
          avatar_url: user.avatarUrl,
          role: user.role,
        },
        kind: 'text',
        content_md: content,
        content_html: null,
        is_deleted: false,
        edited_at: null,
        created_at: new Date().toISOString(),
        attachment_count: 0,
        reaction_count: 0,
        attachments: [],
      }
      pendingRef.current = [...pendingRef.current, optimistic]
      setPending(pendingRef.current)
      stickToBottom.current = true

      // ── 1) 先创建消息 ────────────────────────────────────
      let created: PublicMessage
      try {
        const res = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel_id: channelId,
            content,
            reply_to_id: replyTo?.id ?? null,
          }),
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          removePending(optimistic.id)
          return data.error ?? `发送失败（${res.status}）`
        }
        const data = (await res.json()) as { message: PublicMessage }
        created = data.message
      } catch {
        removePending(optimistic.id)
        return '网络错误，请重试'
      }

      // 用真实消息替换乐观条目（服务端广播到达时会被去重跳过）
      seen.current.add(created.id)
      pendingRef.current = pendingRef.current.filter((p) => p.id !== optimistic.id)
      setPending(pendingRef.current)
      setMessages((prev) => [...prev, created])

      if (files.length === 0) return null

      // ── 2) 再逐个上传附件 ────────────────────────────────
      // 串行而非并发：低配服务器上并发上传多个 8MB 文件会同时占用
      // 大量内存与磁盘 IO，串行更稳且失败时容易定位是哪个文件
      setUploadingId(created.id)
      let uploaded = 0
      let firstError: string | null = null
      let latest: PublicMessage = created

      for (const file of files) {
        const fd = new FormData()
        fd.append('message_id', created.id)
        fd.append('file', file)

        try {
          const res = await fetch('/api/attachments', { method: 'POST', body: fd })
          const data = (await res.json().catch(() => ({}))) as {
            attachment?: PublicMessage['attachments'][number]
            error?: string
          }
          if (!res.ok || !data.attachment) {
            if (!firstError) firstError = data.error ?? `「${file.name}」上传失败`
            continue
          }
          uploaded += 1
          latest = {
            ...latest,
            attachment_count: uploaded,
            attachments: [...latest.attachments, data.attachment],
          }
          setMessages((prev) =>
            prev.map((m) => (m.id === created.id ? { ...m, ...latest } : m)),
          )
        } catch {
          if (!firstError) firstError = `「${file.name}」上传时网络中断`
        }
      }
      setUploadingId(null)

      // 全部失败时把消息内容也回滚掉：留下一条空消息只会让人困惑
      if (uploaded === 0 && firstError) {
        return firstError
      }
      // 部分失败要如实告知，否则用户以为都传上去了
      return firstError ? `部分附件未上传成功：${firstError}` : null
    },
    [channelId, user, removePending],
  )

  const composerDisabled = readOnly

  // 用 useMemo 避免每次渲染都生成新数组（会导致列表整体重渲染）
  const rendered = useMemo(() => [...messages], [messages])

  return (
    <>
      <div className="stream" ref={scrollRef} onScroll={handleScroll}>
        {user && (
          <div className={`stream-status ${status}`}>
            <span className="dot" />
            {STATUS_TEXT[status]}
          </div>
        )}

        {hasMore && (
          <button className="load-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '加载更早的消息'}
          </button>
        )}

        {rendered.length === 0 && pending.length === 0 && (
          <div className="stream-empty">
            这里还没有消息。
            {!user && ' 登录后即可参与讨论。'}
          </div>
        )}

        {rendered.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            uploading={uploadingId === m.id}
          />
        ))}

        {pending.map((m) => (
          <div key={m.id} className="is-pending" style={{ display: 'contents' }}>
            <MessageItem message={m} />
          </div>
        ))}

        <div ref={endRef} />
      </div>

      <Composer
        key={channelSlug}
        placeholder={
          composerDisabled
            ? '该频道为只读，仅管理员可发言'
            : `在 #${channelSlug} 发言，支持 Markdown 与代码块`
        }
        disabled={composerDisabled}
        onSend={handleSend}
      />
    </>
  )
}
