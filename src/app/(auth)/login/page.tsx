import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthForm } from '@/components/AuthForm'
import { getCurrentUser } from '@/lib/session'

export const metadata: Metadata = {
  title: '登录',
  // 登录页没有可索引内容，且会稀释站点权重
  robots: { index: false, follow: false },
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const [{ next }, user] = await Promise.all([searchParams, getCurrentUser()])
  if (user) redirect('/')

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>登录</h1>
        <p className="auth-sub">参与讨论需要先登录</p>
        <AuthForm mode="login" next={next} />
      </div>
    </div>
  )
}
