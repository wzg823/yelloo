import type { Metadata } from 'next'
import { ResetForm } from '@/components/ResetForms'

export const metadata: Metadata = {
  title: '重置密码',
  robots: { index: false, follow: false },
}

/**
 * 令牌从查询串里取，交给客户端表单。
 *
 * 刻意**不做服务端校验**（比如提前查一下令牌有没有过期）：
 * 那会让"令牌有效"变成一个可以被渲染结果区分的状态，而这页面的内容
 * 本来就不含任何私密信息。真正的校验只在提交时发生一次 ——
 * 由 `POST /api/auth/reset` 原子地抢占令牌。
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>重置密码</h1>
        <ResetForm token={(token ?? '').trim()} />
      </div>
    </div>
  )
}
