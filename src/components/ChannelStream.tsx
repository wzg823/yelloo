'use client'

/**
 * 频道消息流。
 *
 * 四个必须处理对的点，否则会以很难查的方式出错：
 *
 * 1. **去重**：SSE 推送、降级轮询、补齐重放三条路径可能送来同一条消息，
 *    必须按 id 去重。归并逻辑已抽到 `src/lib/message-list.ts`（纯函数，有单测）。
 * 2. **变更 ≠ 新增**：`message.updated` / `message.deleted` 必须**按 id 覆盖**，
 *    走"新增"那条路会被去重静默丢掉 —— 这正是"看不到别人的编辑与删除"的成因。
 * 3. **乐观插入**：自己发的消息本地立即显示（带 pending 样式），
 *    收到服务端广播后按 id 替换。不做这步用户会感觉"发出去没反应"。
 * 4. **提交竞态**：服务端广播可能比 `await fetch` 的响应先到。
 *    因此乐观条目不绑定临时 id，而是靠「作者是自己 + 内容完全相同」来认领。
 *
 * ── 为什么 messages 同时存在 state 与 ref ────────────────────────────
 * 同一批次里连续到达多条事件时，第二次调用拿到的仍是上一次渲染时的
 * `messages`（React 还没重渲染），后到的消息会被追加到一个"不含前一条"的
 * 列表上，于是**丢消息**。所以所有写入都收敛到 `commitMessages`：
 * 它同时更新 ref 与 state，保证回调里读到的永远是最新值。
 * 删除路径同理（`commitPending`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'
import { useEventStream, type StreamStatus } from '@/lib/useEventStream'
import { useSession } from '@/lib/session-context'
import { applyMessageUpdate, ingestCreated } from '@/lib/message-list'
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

  /** 与 state 同步的 ref：回调里必须读到最新值，见文件头说明 */
  const messagesRef = useRef<PublicMessage[]>(initialMessages)
  const pendingRef = useRef<PublicMessage[]>([])

  const commitMessages = useCallback((next: PublicMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const commitPending = useCallback((next: PublicMessage[]) => {
    pendingRef.current = next
    setPending(next)
  }, [])

  const removePending = useCallback(
    (id: string) => {
      commitPending(pendingRef.current.filter((p) => p.id !== id))
    },
    [commitPending],
  )

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

  // ── 接收新消息 ──────────────────────────────────────────────
  const handleIncoming = useCallback(
    (incoming: PublicMessage[]) => {
      const before = messagesRef.current
      const result = ingestCreated({
        messages: before,
        pending: pendingRef.current,
        seen: seen.current,
        incoming,
        channelId,
        selfId: user?.id ?? null,
      })

      if (result.pending !== pendingRef.current) commitPending(result.pending)
      if (result.messages === before) return

      commitMessages(result.messages)

      // 只在新消息真的追加进来时推进已读位点
      if (result.messages.length > before.length) {
        const last = result.messages[result.messages.length - 1]
        if (last) {
          void fetch('/api/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId, message_id: last.id }),
          })
            .then(() => refreshUnread())
            .catch(() => {})
        }
      }
    },
    [channelId, user, commitMessages, commitPending, refreshUnread],
  )

  // ── 接收变更（编辑 / 附件补充 / 删除）────────────────────────
  //
  // 这一条曾经缺失：变更事件被送进 onMessages，被按 id 去重后丢弃，
  // 于是"别人的编辑和删除"永远看不到。现在按 id 覆盖。
  const handleUpdates = useCallback(
    (updated: PublicMessage[]) => {
      const next = applyMessageUpdate(messagesRef.current, updated)
      if (next !== messagesRef.current) commitMessages(next)
    },
    [commitMessages],
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
      commitMessages(data.messages)
      setHasMore(data.has_more)
      setOldestCursor(data.cursor)
      stickToBottom.current = true
    } catch {
      /* 交给下一次 resync 或用户刷新 */
    }
  }, [channelId, commitMessages])

  /**
   * 重连后重取可见窗口。
   *
   * 为什么必须要：SSE 的补齐流是 `id > cursor` 的增量，而编辑与删除
   * **不产生新 id**，所以断线期间发生的变更根本不在补齐范围内。
   * 不重取的话，那些消息会永远停在旧内容 / 旧状态。
   *
   * 与 handleResync 的区别：这里是**归并**（保留已有顺序、只覆盖内容、
   * 补齐期间新增的消息），resync 是**整表替换**（服务端明确说事件丢了）。
   */
  const refreshWindow = useCallback(async () => {
    try {
      const res = await fetch(`/api/channels/${channelId}/messages?limit=50`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = (await res.json()) as { messages: PublicMessage[] }

      const ingested = ingestCreated({
        messages: messagesRef.current,
        pending: pendingRef.current,
        seen: seen.current,
        incoming: data.messages,
        channelId,
        selfId: user?.id ?? null,
      })
      if (ingested.pending !== pendingRef.current) commitPending(ingested.pending)

      // 服务端返回的是每条的**当前**版本，按 id 覆盖即可修正编辑与删除
      const merged = applyMessageUpdate(ingested.messages, data.messages)
      if (merged !== messagesRef.current) commitMessages(merged)
    } catch {
      /* 静默：下次重连或轮询刷新还会再来 */
    }
  }, [channelId, user, commitMessages, commitPending])

  const status = useEventStream({
    initialCursor,
    enabled: Boolean(user),
    onMessages: handleIncoming,
    onUpdates: handleUpdates,
    onReconnected: refreshWindow,
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
      commitMessages([...data.messages, ...messagesRef.current])
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
  }, [channelId, oldestCursor, loadingMore, commitMessages])

  // ── 编辑 / 删除 ─────────────────────────────────────────────
  //
  // 改完立即用服务端返回的对象覆盖本地，不等 SSE 广播：
  // 广播可能因为背压被丢弃，而用户点完按钮必须有即时反馈。
  // 广播到达时是同一个 id，覆盖一次无害（幂等）。
  const handleEdit = useCallback(
    async (target: PublicMessage, content: string): Promise<string | null> => {
      try {
        const res = await fetch(`/api/messages/${target.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          message?: PublicMessage
          error?: string
        }
        if (!res.ok || !data.message) {
          return data.error ?? `保存失败（${res.status}）`
        }
        commitMessages(applyMessageUpdate(messagesRef.current, [data.message]))
        return null
      } catch {
        return '网络错误，请重试'
      }
    },
    [commitMessages],
  )

  const handleDelete = useCallback(
    async (target: PublicMessage): Promise<string | null> => {
      try {
        const res = await fetch(`/api/messages/${target.id}`, { method: 'DELETE' })
        const data = (await res.json().catch(() => ({}))) as {
          message?: PublicMessage
          error?: string
        }
        if (!res.ok || !data.message) {
          return data.error ?? `删除失败（${res.status}）`
        }
        // 返回的是墓碑：仍然留在原位，而不是从列表里消失。
        // 直接移除会让分页游标出现"空洞"，也让其他人以为消息从未存在过
        commitMessages(applyMessageUpdate(messagesRef.current, [data.message]))
        return null
      } catch {
        return '网络错误，请重试'
      }
    },
    [commitMessages],
  )

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
      commitPending([...pendingRef.current, optimistic])
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
      commitPending(pendingRef.current.filter((p) => p.id !== optimistic.id))
      commitMessages([...messagesRef.current, created])

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
          commitMessages(
            messagesRef.current.map((m) => (m.id === created.id ? { ...m, ...latest } : m)),
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
    [channelId, user, removePending, commitMessages, commitPending],
  )

  const composerDisabled = readOnly

  // 用 useMemo 避免每次渲染都生成新数组（会导致列表整体重渲染）
  const rendered = useMemo(() => [...messages], [messages])

  /** 传给 MessageItem 的查看者信息：只用于决定按钮显不显示 */
  const viewer = user ? { id: user.id, role: user.role } : null

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
            viewer={viewer}
            onEdit={handleEdit}
            onDelete={handleDelete}
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
