'use client'

/**
 * 登录 / 注册表单。
 *
 * 用 React 19 的 useActionState 驱动 Server Action：
 *   - 不用手写 fetch + 状态机
 *   - 提交期间自动获得 isPending，避免重复提交
 *
 * `next` 参数用于登录后回跳（例如从某个频道页被引导来登录）。
 */
import { useActionState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { loginAction, registerAction, type ActionResult } from '@/app/(auth)/actions'

type Mode = 'login' | 'register'

const INITIAL: ActionResult = { ok: false, error: '' }

export function AuthForm({ mode, next }: { mode: Mode; next?: string }) {
  const router = useRouter()
  const action = mode === 'login' ? loginAction : registerAction

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult, formData: FormData): Promise<ActionResult> => {
      const result = await action(formData)
      if (result.ok) {
        // 成功后刷新，让根布局重新读取会话（否则侧栏仍显示"未登录"）
        router.replace(next && next.startsWith('/') ? next : '/')
        router.refresh()
      }
      return result
    },
    INITIAL,
  )

  const isLogin = mode === 'login'

  return (
    <form action={formAction} noValidate>
      {!isLogin && (
        <div className="field">
          <label htmlFor="handle">用户名</label>
          <input
            id="handle"
            name="handle"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z0-9_-]{3,32}"
            placeholder="仅字母、数字、下划线、连字符"
          />
          <div className="field-hint">登录后不可修改，会出现在你的主页链接里</div>
        </div>
      )}

      <div className="field">
        <label htmlFor="email">邮箱</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
        />
      </div>

      <div className="field">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isLogin ? 'current-password' : 'new-password'}
          required
          minLength={isLogin ? undefined : 10}
          placeholder={isLogin ? '' : '至少 10 位'}
        />
      </div>

      {!state.ok && state.error && <div className="form-error">{state.error}</div>}

      <button type="submit" className="btn btn-primary auth-submit" disabled={isPending}>
        {isPending ? '处理中…' : isLogin ? '登录' : '注册并登录'}
      </button>

      <p className="auth-switch">
        {isLogin ? (
          <>
            还没有账号？<Link href="/register">注册</Link>
          </>
        ) : (
          <>
            已有账号？<Link href="/login">登录</Link>
          </>
        )}
      </p>
    </form>
  )
}
