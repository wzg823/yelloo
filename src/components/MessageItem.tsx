'use client'

/**
 * 单条消息。服务端渲染首屏与客户端实时追加共用同一个组件，
 * 避免出现"历史消息和实时消息样式不一致"这类经典问题。
 *
 * ── 编辑 / 删除按钮的权限判定 ────────────────────────────────────────
 *
 * 这里只决定**按钮显不显示**，判定依据是"这条消息是不是我的"与"我是不是版主"。
 * 真正的权限（`EDIT_OWN_MESSAGE` / `DELETE_OWN_MESSAGE` / `MANAGE_MESSAGE`）
 * 一律在服务端重新算 —— 前端隐藏按钮不是防线，见 `src/lib/session-context.tsx`。
 *
 * 服务端的规则比按钮更严：**编辑只有作者本人能做，版主也不行**。
 * 也就是说版主看到别人消息上的"删除"按钮是正常的，但不会有"编辑"。
 */
import { useCallback, useState } from 'react'
import { avatarHue, formatDateTime, initials, messagePermalink, relativeTime } from '@/lib/format'
import { isModeratorRole } from '@/lib/permissions'
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

export type ViewerInfo = { id: number; role: string }

export function MessageItem({
  message,
  onReply,
  uploading = false,
  viewer = null,
  onEdit,
  onDelete,
}: {
  message: PublicMessage
  onReply?: (m: PublicMessage) => void
  /** 该消息的附件正在上传中 */
  uploading?: boolean
  /** 当前查看者。为 null 表示未登录或该页面不提供操作（如永久链接页） */
  viewer?: ViewerInfo | null
  /** 返回错误信息表示失败，null 表示成功 */
  onEdit?: (m: PublicMessage, content: string) => Promise<string | null>
  onDelete?: (m: PublicMessage) => Promise<string | null>
}) {
  // 相对时间只在客户端算，避免 SSR/CSR 因时间差导致 hydration 不一致
  const [showRelative, setShowRelative] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content_md)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const author = message.author
  // 注意：PublicMessage 是"传输形状"，字段一律 snake_case。
  // 不要在客户端组件里直接用 camelCase，那会静默拿到 undefined。
  const name = author?.display_name ?? author?.handle ?? '已注销用户'
  const roleClass =
    author?.role === 'admin' ? 'role-admin' : author?.role === 'mod' ? 'role-mod' : ''

  const isMine = Boolean(viewer && author && author.id === viewer.id)
  const canEdit = Boolean(isMine && onEdit && !message.is_deleted)
  // 删自己的靠 DELETE_OWN_MESSAGE，删别人的靠 MANAGE_MESSAGE（版主/管理员）。
  // 这里只做按钮显示，服务端会用真正的权限位重新判定
  const canDelete = Boolean(
    !message.is_deleted && onDelete && (isMine || isModeratorRole(viewer?.role)),
  )

  const startEdit = useCallback(() => {
    setDraft(message.content_md)
    setError(null)
    setEditing(true)
  }, [message.content_md])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const save = useCallback(async () => {
    if (!onEdit || busy) return
    const content = draft.trim()
    if (content.length === 0) {
      setError('内容不能为空（要删除请用「删除」）')
      return
    }
    if (content === message.content_md) {
      // 没改动就直接退出，别为一次空操作写一条修订历史
      setEditing(false)
      return
    }
    setBusy(true)
    setError(null)
    const err = await onEdit(message, content)
    setBusy(false)
    if (err) setError(err)
    else setEditing(false)
  }, [onEdit, busy, draft, message])

  const doDelete = useCallback(async () => {
    if (!onDelete || busy) return
    setBusy(true)
    setError(null)
    const err = await onDelete(message)
    setBusy(false)
    setConfirmingDelete(false)
    if (err) setError(err)
  }, [onDelete, busy, message])

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

          {!editing && (onReply || canEdit || canDelete) && (
            <span className="msg-actions">
              {onReply && !message.is_deleted && (
                <button type="button" className="icon-btn" onClick={() => onReply(message)}>
                  回复
                </button>
              )}
              {canEdit && (
                <button type="button" className="icon-btn" onClick={startEdit}>
                  编辑
                </button>
              )}
              {canDelete &&
                (confirmingDelete ? (
                  <>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={doDelete}
                      disabled={busy}
                    >
                      {busy ? '删除中…' : '确认删除'}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    删除
                  </button>
                ))}
            </span>
          )}
        </div>

        {editing ? (
          <div className="msg-edit">
            <textarea
              className="msg-edit-input"
              value={draft}
              autoFocus
              rows={Math.min(Math.max(draft.split('\n').length, 2), 14)}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Esc 取消、Ctrl/Cmd+Enter 保存 —— 与发帖框保持一致的手感
                if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelEdit()
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void save()
                }
              }}
            />
            <div className="msg-edit-bar">
              <span className="msg-edit-hint">Markdown 可用 · Esc 取消 · Ctrl/⌘+Enter 保存</span>
              <button type="button" className="icon-btn" onClick={cancelEdit} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="icon-btn primary"
                onClick={save}
                disabled={busy}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        ) : (
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
        )}

        {error && <div className="msg-action-error">{error}</div>}

        {!message.is_deleted && !editing && (
          <AttachmentList items={message.attachments ?? []} />
        )}
      </div>
    </article>
  )
}
