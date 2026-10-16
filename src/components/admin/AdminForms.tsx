'use client'

/**
 * 管理后台的交互组件。
 *
 * 全部集中在一个文件里，因为它们共享同一套"提交 → 显示错误 → 刷新"的模式。
 * 分散成六七个文件只会让这套模式被复制六遍，然后逐渐出现细微差异
 * （有的刷新、有的不刷新，有的显示错误、有的静默失败）。
 *
 * ★ 客户端按钮不代表权限 ★
 * 这里只负责"把用户的意图发出去"。每个请求的权限都由服务端重新判定，
 * 前端隐藏按钮只是避免让人点了才被拒。`canBan` / `canRole` 这类开关
 * 传的是**服务端算好的**权限结果，而不是客户端自己推的。
 */
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'

async function send(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) return data.error ?? `失败（HTTP ${res.status}）`
    return null
  } catch {
    return '网络错误，请重试'
  }
}

function useSubmit() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(path: string, method: 'POST' | 'PATCH', body: unknown) {
    setBusy(true)
    setError(null)
    const err = await send(path, method, body)
    setBusy(false)
    if (err) {
      setError(err)
      return false
    }
    router.refresh()
    return true
  }

  return { busy, error, run, setError }
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="admin-error">{error}</div>
}

/** 一步到位的动作按钮（用于归档、解禁这类不需要额外输入的操作） */
export function ActionButton({
  path,
  method = 'POST',
  body = {},
  children,
  confirm,
  danger,
}: {
  path: string
  method?: 'POST' | 'PATCH'
  body?: unknown
  children: ReactNode
  /** 危险操作的两段式确认文案 */
  confirm?: string
  danger?: boolean
}) {
  const { busy, error, run } = useSubmit()
  const [armed, setArmed] = useState(false)

  if (armed) {
    return (
      <span className="admin-inline">
        <button
          type="button"
          className="admin-btn danger"
          disabled={busy}
          onClick={async () => {
            const ok = await run(path, method, body)
            if (ok) setArmed(false)
          }}
        >
          {busy ? '执行中…' : (confirm ?? '确认')}
        </button>
        <button
          type="button"
          className="admin-btn"
          disabled={busy}
          onClick={() => setArmed(false)}
        >
          取消
        </button>
        <ErrorLine error={error} />
      </span>
    )
  }

  return (
    <span className="admin-inline">
      <button
        type="button"
        className={`admin-btn${danger ? ' danger' : ''}`}
        disabled={busy}
        onClick={() => (confirm ? setArmed(true) : void run(path, method, body))}
      >
        {busy ? '执行中…' : children}
      </button>
      <ErrorLine error={error} />
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// 举报处置
// ─────────────────────────────────────────────────────────────

const MUTE_OPTIONS = [
  ['none', '不禁言'],
  ['1h', '禁言 1 小时'],
  ['24h', '禁言 24 小时'],
  ['7d', '禁言 7 天'],
  ['forever', '永久禁言'],
] as const

const BAN_OPTIONS = [
  ['none', '不封禁'],
  ['1d', '封禁 1 天'],
  ['7d', '封禁 7 天'],
  ['forever', '永久封禁'],
] as const

export function ReportHandleForm({
  reportId,
  canDeleteMessage,
  canMute,
  canBan,
  targetLabel,
}: {
  reportId: number
  canDeleteMessage: boolean
  canMute: boolean
  canBan: boolean
  targetLabel: string | null
}) {
  const { busy, error, run } = useSubmit()
  const [action, setAction] = useState<'resolve' | 'dismiss'>('resolve')
  const [note, setNote] = useState('')
  const [deleteMessage, setDeleteMessage] = useState(false)
  const [mute, setMute] = useState('none')
  const [ban, setBan] = useState('none')

  const canPunish = Boolean(targetLabel)

  return (
    <div className="admin-handle">
      <div className="admin-handle-row">
        <select
          className="admin-input"
          value={action}
          onChange={(e) => setAction(e.target.value as 'resolve' | 'dismiss')}
          disabled={busy}
        >
          <option value="resolve">判定违规（已处理）</option>
          <option value="dismiss">判定无问题（驳回）</option>
        </select>

        {canDeleteMessage && (
          <label className="admin-check">
            <input
              type="checkbox"
              checked={deleteMessage}
              onChange={(e) => setDeleteMessage(e.target.checked)}
              disabled={busy}
            />
            删除该消息
          </label>
        )}

        {canMute && canPunish && (
          <select
            className="admin-input"
            value={mute}
            onChange={(e) => setMute(e.target.value)}
            disabled={busy}
          >
            {MUTE_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}

        {canBan && canPunish && (
          <select
            className="admin-input"
            value={ban}
            onChange={(e) => setBan(e.target.value)}
            disabled={busy}
          >
            {BAN_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="admin-handle-row">
        <input
          className="admin-input grow"
          placeholder="处理说明（会写进审计日志，建议填写）"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="admin-btn primary"
          disabled={busy}
          onClick={() =>
            void run(`/api/admin/reports/${reportId}`, 'POST', {
              action,
              note,
              reason: note,
              delete_message: deleteMessage,
              mute_user: mute === 'none' ? null : mute,
              ban_user: ban === 'none' ? null : ban,
            })
          }
        >
          {busy ? '提交中…' : '提交处置'}
        </button>
      </div>

      <ErrorLine error={error} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 用户处置
// ─────────────────────────────────────────────────────────────

export function UserActionForm({
  userId,
  status,
  role,
  trustLevel,
  canMute,
  canBan,
  canRole,
  isSelf,
}: {
  userId: number
  status: string
  role: string
  trustLevel: number
  canMute: boolean
  canBan: boolean
  canRole: boolean
  isSelf: boolean
}) {
  const { busy, error, run } = useSubmit()
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState('mute')
  const [duration, setDuration] = useState('24h')
  const [newRole, setNewRole] = useState(role)
  const [trust, setTrust] = useState(String(trustLevel))

  if (isSelf) {
    // 服务端也会拒（self_target），但没必要让人点了才知道
    return <span className="admin-muted">（当前账号）</span>
  }

  if (!open) {
    return (
      <button type="button" className="admin-btn" onClick={() => setOpen(true)}>
        处置
      </button>
    )
  }

  const submit = async () => {
    const body: Record<string, unknown> = { action }
    if (action === 'mute' || action === 'ban') body.duration = duration
    if (action === 'set_role') body.role = newRole
    if (action === 'set_trust') body.trust_level = Number(trust)
    const ok = await run(`/api/admin/users/${userId}`, 'PATCH', body)
    if (ok) setOpen(false)
  }

  return (
    <div className="admin-handle">
      <div className="admin-handle-row">
        <select
          className="admin-input"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          disabled={busy}
        >
          {canMute && <option value="mute">禁言</option>}
          {status === 'muted' && <option value="unmute">解除禁言</option>}
          {canBan && <option value="ban">封禁</option>}
          {status === 'banned' && <option value="unban">解封</option>}
          {canRole && <option value="set_role">修改角色</option>}
          <option value="set_trust">修改信任等级</option>
        </select>

        {(action === 'mute' || action === 'ban') && (
          <select
            className="admin-input"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            disabled={busy}
          >
            {MUTE_OPTIONS.filter(([v]) => v !== 'none').map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            <option value="forever">永久</option>
          </select>
        )}

        {action === 'set_role' && (
          <select
            className="admin-input"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            disabled={busy}
          >
            <option value="member">member</option>
            <option value="mod">mod</option>
          </select>
        )}

        {action === 'set_trust' && (
          <select
            className="admin-input"
            value={trust}
            onChange={(e) => setTrust(e.target.value)}
            disabled={busy}
          >
            <option value="0">0 · 新人（受限流）</option>
            <option value="1">1 · 已验证（不受限）</option>
            <option value="2">2 · 活跃</option>
          </select>
        )}

        <button type="button" className="admin-btn primary" disabled={busy} onClick={submit}>
          {busy ? '执行中…' : '执行'}
        </button>
        <button
          type="button"
          className="admin-btn"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 频道
// ─────────────────────────────────────────────────────────────

export function ChannelCreateForm({
  categories,
}: {
  categories: { id: number; name: string }[]
}) {
  const { busy, error, run } = useSubmit()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [type, setType] = useState('text')
  const [topic, setTopic] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [open, setOpen] = useState(false)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  if (!open) {
    return (
      <button type="button" className="admin-btn primary" onClick={() => setOpen(true)}>
        + 新建频道
      </button>
    )
  }

  return (
    <div className="admin-card">
      <div className="admin-handle-row">
        <input
          className="admin-input"
          placeholder="显示名（可中文）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <input
          className="admin-input"
          placeholder="slug（英文，会出现在 URL 里）"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={busy}
        />
        <select
          className="admin-input"
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={busy}
        >
          <option value="text">text · 滚动流</option>
          <option value="forum">forum · 一帖一题</option>
          <option value="announce">announce · 公告（强制只读）</option>
        </select>
        <select
          className="admin-input"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          disabled={busy}
        >
          <option value="">（无分类）</option>
          {categories.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="admin-handle-row">
        <input
          className="admin-input grow"
          placeholder="话题（一句话说明这个频道用来做什么）"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="admin-btn primary"
          disabled={busy}
          onClick={async () => {
            setOkMsg(null)
            const ok = await run('/api/admin/channels', 'POST', {
              name,
              slug,
              type,
              topic,
              category_id: categoryId === '' ? null : Number(categoryId),
            })
            if (ok) {
              setOkMsg(`已创建 #${slug}`)
              setName('')
              setSlug('')
              setTopic('')
              setOpen(false)
            }
          }}
        >
          {busy ? '创建中…' : '创建'}
        </button>
        <button
          type="button"
          className="admin-btn"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
      <ErrorLine error={error} />
      {okMsg && <div className="admin-ok">{okMsg}</div>}
    </div>
  )
}

export function ChannelEditForm({
  channelId,
  name,
  topic,
  type,
}: {
  channelId: number
  name: string
  topic: string | null
  type: string
}) {
  const { busy, error, run } = useSubmit()
  const [open, setOpen] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [nextTopic, setNextTopic] = useState(topic ?? '')

  if (!open) {
    return (
      <button type="button" className="admin-btn" onClick={() => setOpen(true)}>
        编辑
      </button>
    )
  }

  return (
    <div className="admin-handle">
      <div className="admin-handle-row">
        <input
          className="admin-input"
          value={nextName}
          onChange={(e) => setNextName(e.target.value)}
          disabled={busy}
        />
        <input
          className="admin-input grow"
          placeholder="话题"
          value={nextTopic}
          onChange={(e) => setNextTopic(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="admin-btn primary"
          disabled={busy}
          onClick={async () => {
            const ok = await run(`/api/admin/channels/${channelId}`, 'PATCH', {
              name: nextName,
              topic: nextTopic,
              // announce 会被服务端强制回只读，这里不必特判
            })
            if (ok) setOpen(false)
          }}
        >
          保存
        </button>
        <button
          type="button"
          className="admin-btn"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
      </div>
      <div className="admin-muted">
        类型 {type} · slug 不可修改（它是对外 URL，改了会让已收录的链接全部 404）
      </div>
      <ErrorLine error={error} />
    </div>
  )
}
