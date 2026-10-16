'use client'

/**
 * 忘记密码 / 重置密码的表单。
 *
 * 两个模式共用一套样式与提交逻辑（都打 REST 端点，不用 Server Action）：
 * 与 `MessageItem` 的举报、管理后台的动作保持同一种做法 ——
 * 需要"就地显示服务端返回的具体错误"的表单，用 REST 更直接。
 */
import { useState } from 'react'
import Link from 'next/link'

export function ForgotForm() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const res = await fetch('/api/auth/forgot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
          const data = (await res.json().catch(() => ({}))) as {
            message?: string
            error?: string
          }
          if (!res.ok) setError(data.error ?? `提交失败（${res.status}）`)
          else setDone(data.message ?? '如果该邮箱已注册，我们已发送重置邮件')
        } catch {
          setError('网络错误，请重试')
        } finally {
          setBusy(false)
        }
      }}
    >
      {done ? (
        <>
          <p className="auth-sub">{done}</p>
          <p className="auth-sub">
            没收到？检查垃圾邮件目录，或稍后重新申请（同一账号只有最新一封里的链接有效）。
          </p>
          <Link href="/login" className="btn btn-ghost" style={{ textAlign: 'center' }}>
            返回登录
          </Link>
        </>
      ) : (
        <>
          <label>
            邮箱
            <input
              type="email"
              value={email}
              autoComplete="email"
              required
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy || !email}>
            {busy ? '提交中…' : '发送重置邮件'}
          </button>
          <Link href="/login" className="auth-link">
            想起密码了？返回登录
          </Link>
        </>
      )}
    </form>
  )
}

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 两次输入不一致就本地拦住。服务端不需要这个字段 —— 它只收一个 password，
  // 二次确认纯粹是"防止手滑打错"的客户端体验
  const mismatch = confirm.length > 0 && password !== confirm

  if (!token) {
    return (
      <div className="auth-form">
        <div className="auth-error">这个链接缺少令牌，请从邮件里重新打开。</div>
        <Link href="/forgot" className="btn btn-primary" style={{ textAlign: 'center' }}>
          重新申请
        </Link>
      </div>
    )
  }

  if (done) {
    return (
      <div className="auth-form">
        <p className="auth-sub">密码已重置。出于安全考虑，该账号在所有设备上的登录都已失效。</p>
        <Link href="/login" className="btn btn-primary" style={{ textAlign: 'center' }}>
          用新密码登录
        </Link>
      </div>
    )
  }

  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy || mismatch) return
        setBusy(true)
        setError(null)
        try {
          const res = await fetch('/api/auth/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password }),
          })
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          if (!res.ok) setError(data.error ?? `提交失败（${res.status}）`)
          else setDone(true)
        } catch {
          setError('网络错误，请重试')
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        新密码
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          required
          minLength={10}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        再输一次
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          required
          disabled={busy}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <p className="auth-sub">至少 10 位。长度比大小写混合更重要，可以用一句话。</p>
      {mismatch && <div className="auth-error">两次输入不一致</div>}
      {error && <div className="auth-error">{error}</div>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || mismatch || password.length === 0}
      >
        {busy ? '提交中…' : '设置新密码'}
      </button>
    </form>
  )
}
