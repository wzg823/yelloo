'use client'

/**
 * 单条消息。服务端渲染首屏与客户端实时追加共用同一个组件，
 * 避免出现"历史消息和实时消息样式不一致"这类经典问题。
 */
import { useState } from 'react'
import { avatarHue, formatDateTime, initials, messagePermalink, relativeTime } from '@/lib/format'
import type { PublicAttachment, PublicMessage } from '@/lib/serialize'

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 附件列表。
 *
 * 图片渲染成缩略图（用 <img> 加载 Caddy 直出的 URL，不经过 Node 进程），
 * 其他类型渲染成下载链接。
 *
 * 注意：Caddy 下发的是 `Content-Disposition: inline`（图片缩略图必须内联才能显示），
 * 安全性不靠这个头，而是靠**上传时的类型白名单**：SVG/HTML/JS 一律不收。
 * 若将来放开这些类型，必须同步改回 `attachment` 并补 CSP，否则就是存储型 XSS。
 */
function AttachmentList({ items }: { items: PublicAttachment[] }) {
  if (items.length === 0) return null

  return (
    <div className="msg-attachments">
      {items.map((a) =>
        a.is_image ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="msg-image"
            title={`${a.filename} · ${humanSize(a.size)}`}
          >
            {/* 用原生 img：附件走 Caddy 直出，不经过 next/image 的优化管线 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.filename} loading="lazy" decoding="async" />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            className="msg-file"
            download={a.filename}
            rel="noopener noreferrer"
          >
            <span className="msg-file-icon" aria-hidden>
              ▤
            </span>
            <span className="msg-file-name" title={a.filename}>
              {a.filename}
            </span>
            <span className="msg-file-size">{humanSize(a.size)}</span>
          </a>
        ),
      )}
    </div>
  )
}

export function MessageItem({
  message,
  onReply,
  uploading = false,
}: {
  message: PublicMessage
  onReply?: (m: PublicMessage) => void
  /** 该消息的附件正在上传中 */
  uploading?: boolean
}) {
  // 相对时间只在客户端算，避免 SSR/CSR 因时间差导致 hydration 不一致
  const [showRelative, setShowRelative] = useState(false)

  const author = message.author
  // 注意：PublicMessage 是"传输形状"，字段一律 snake_case。
  // 不要在客户端组件里直接用 camelCase，那会静默拿到 undefined。
  const name = author?.display_name ?? author?.handle ?? '已注销用户'
  const roleClass =
    author?.role === 'admin' ? 'role-admin' : author?.role === 'mod' ? 'role-mod' : ''

  return (
    <article
      className={`msg${message.is_deleted ? ' is-deleted' : ''}`}
      id={`m${message.id}`}
    >
      <div
        className="avatar"
        style={{ background: `hsl(${avatarHue(author?.id ?? 0)} 45% 42%)` }}
      >
        {author?.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={author.avatar_url} alt="" />
        ) : (
          initials(name)
        )}
      </div>

      <div>
        <div className="msg-head">
          <span className={`msg-author ${roleClass}`}>{name}</span>
          <time
            className="msg-time"
            dateTime={message.created_at}
            title={formatDateTime(message.created_at)}
            onMouseEnter={() => setShowRelative(true)}
          >
            {showRelative ? relativeTime(message.created_at) : formatDateTime(message.created_at)}
          </time>
          {message.edited_at && <span className="msg-edited">（已编辑）</span>}
          {uploading && <span className="msg-uploading">附件上传中…</span>}
          <a className="msg-anchor" href={messagePermalink(message.id)}>
            #{message.id.slice(-6)}
          </a>
          {onReply && !message.is_deleted && (
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 'auto', fontSize: 11 }}
              onClick={() => onReply(message)}
            >
              回复
            </button>
          )}
        </div>

        <div className="msg-body">
          {message.is_deleted ? (
            <em>该消息已被删除</em>
          ) : message.content_html ? (
            // content_html 由服务端 renderMarkdown 在白名单内生成，已做转义。
            // 若将来换成第三方渲染器，必须同时引入 HTML 消毒步骤。
            <div dangerouslySetInnerHTML={{ __html: message.content_html }} />
          ) : message.content_md ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{message.content_md}</p>
          ) : null}
        </div>

        {!message.is_deleted && <AttachmentList items={message.attachments ?? []} />}
      </div>
    </article>
  )
}
