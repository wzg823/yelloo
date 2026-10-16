import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 40, margin: '0 0 8px' }}>404</h1>
        <p className="auth-sub">这里什么都没有，或者内容已被移除。</p>
        <Link href="/" className="btn btn-primary" style={{ display: 'inline-block' }}>
          返回首页
        </Link>
      </div>
    </div>
  )
}
