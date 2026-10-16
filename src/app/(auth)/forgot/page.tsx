import type { Metadata } from 'next'
import { ForgotForm } from '@/components/ResetForms'

export const metadata: Metadata = {
  title: '忘记密码',
  // 与登录页同理：没有可索引内容，且会稀释站点权重
  robots: { index: false, follow: false },
}

/**
 * 刻意**不**在已登录时跳走（与登录页不同）：
 * 用户可能正处在"能登录但想改密码"的状态，把他们弹回首页毫无帮助。
 */
export default function ForgotPage() {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>忘记密码</h1>
        <p className="auth-sub">填入注册时用的邮箱，我们会发一封重置邮件给你</p>
        <ForgotForm />
      </div>
    </div>
  )
}
