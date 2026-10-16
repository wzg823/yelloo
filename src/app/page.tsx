import type { Metadata } from 'next'
import Link from 'next/link'
import { listChannels, type ChannelSummary } from '@/lib/queries'
import { safeQuery } from '@/lib/safe-query'
import { formatDateTime } from '@/lib/format'

/**
 * 首页。
 *
 * 公开技术社区的首页要回答两个问题：
 *   1. 这里在讨论什么（频道 + 最近活跃时间）
 *   2. 我该从哪里开始（分类分组）
 * 因此刻意做成服务端渲染的静态列表，而不是需要 JS 才能看到的 SPA。
 *
 * ★ 关于 force-dynamic ★
 * 页面依赖数据库，而构建环境（尤其是 Docker builder 阶段）没有数据库可连。
 * 如果依赖 ISR/静态预渲染，`next build` 会在预渲染时连库失败，直接导致构建中断。
 * 因此这里显式声明为动态渲染：每次请求实时查询，HTML 仍是完整的服务端渲染结果，
 * 爬虫抓到的内容与用户看到的完全一致（SEO 不受影响）。
 * 后续要降低数据库压力时，正确做法是给查询加 unstable_cache + tag 失效，
 * 而不是退回静态预渲染。
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  alternates: { canonical: '/' },
}

export default async function HomePage() {
  const { categories, channels } = await safeQuery(
    () => listChannels(),
    { categories: [], channels: [] as ChannelSummary[] },
    'home:listChannels',
  )

  const byCategory = new Map<number | null, typeof channels>()
  for (const ch of channels) {
    const list = byCategory.get(ch.categoryId) ?? []
    list.push(ch)
    byCategory.set(ch.categoryId, list)
  }

  // 站点还没初始化时给出明确指引，避免出现"空白站点让人以为坏了"
  if (channels.length === 0) {
    return (
      <div className="home">
        <h1>{process.env.SITE_NAME ?? '技术社区'}</h1>
        <p className="home-sub">站点尚未初始化。</p>
        <div className="notice">
          <p style={{ margin: '0 0 8px' }}>在服务器上依次执行：</p>
          <p style={{ margin: 0 }}>
            <code>npm run db:migrate</code> 然后 <code>npm run db:seed</code>
          </p>
          <p style={{ margin: '8px 0 0', fontSize: 12 }}>
            如需创建管理员，请先在 <code>.env</code> 中设置{' '}
            <code>SEED_ADMIN_EMAIL</code> 与 <code>SEED_ADMIN_PASSWORD</code>。
          </p>
        </div>
      </div>
    )
  }

  const sorted = [...channels].sort((a, b) => {
    const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0
    const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0
    return bt - at
  })
  const recent = sorted.filter((c) => c.lastMessageAt).slice(0, 6)

  const card = (ch: (typeof channels)[number]) => (
    <Link key={ch.id} href={`/c/${ch.slug}`} className="chan-card">
      <div className="chan-card-name">
        <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {ch.type === 'forum' ? '▤' : ch.type === 'announce' ? '📢' : '#'}
        </span>
        {ch.name}
      </div>
      {ch.topic && <div className="chan-card-topic">{ch.topic}</div>}
      <div className="chan-card-meta">
        {ch.messageCount} 条消息
        {ch.lastMessageAt ? ` · 最后活动 ${formatDateTime(ch.lastMessageAt)}` : ' · 尚无消息'}
      </div>
    </Link>
  )

  return (
    <div className="home">
      <h1>{process.env.SITE_NAME ?? '技术社区'}</h1>
      <p className="home-sub">
        面向中文开发者的公开技术社区 —— 讨论、问答与作品分享。游客可直接浏览，登录后参与讨论。
      </p>

      {recent.length > 0 && (
        <>
          <div className="home-section-title">最近活跃</div>
          <div className="chan-grid">{recent.map(card)}</div>
        </>
      )}

      {categories.map((cat) => {
        const list = byCategory.get(cat.id) ?? []
        if (list.length === 0) return null
        return (
          <div key={cat.id}>
            <div className="home-section-title">
              {cat.name}
              {cat.description ? ` · ${cat.description}` : ''}
            </div>
            <div className="chan-grid">{list.map(card)}</div>
          </div>
        )
      })}

      {(byCategory.get(null) ?? []).length > 0 && (
        <>
          <div className="home-section-title">其他</div>
          <div className="chan-grid">{(byCategory.get(null) ?? []).map(card)}</div>
        </>
      )}
    </div>
  )
}
