import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthForm } from '@/components/AuthForm'
import { getCurrentUser } from '@/lib/session'

export const metadata: Metadata = {
  title: '注册',
  robots: { index: false, follow: false },
}

export default async function RegisterPage() {
  const user = await getCurrentUser()
  if (user) redirect('/')

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>注册</h1>
        <p className="auth-sub">
          公开社区，注册即刻可发言。请勿发布违法或侵权内容，详见社区规则。
        </p>
        <AuthForm mode="register" />
      </div>
    </div>
  )
}
