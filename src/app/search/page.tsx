import type { Metadata } from 'next'
import Link from 'next/link'
import { MessageItem } from '@/components/MessageItem'
import { searchMessages } from '@/lib/queries'
import { safeQuery } from '@/lib/safe-query'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '搜索',
  // 搜索结果页不应被收录：内容随查询串变化，收录会造成大量低质页面，
  // 反而拉低整个站点的权重。具体消息由 /m/[id] 独立页面承担收录职责。
  robots: { index: false, follow: true },
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const query = (q ?? '').trim()

  const results = await safeQuery(
    () => (query.length >= 2 ? searchMessages({ query, limit: 30 }) : Promise.resolve([])),
    [],
    'search:searchMessages',
  )

  return (
    <div className="main" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header className="channel-header">
        <h1 style={{ fontSize: 16 }}>搜索</h1>
        {query && (
          <span className="channel-topic">
            “{query}” 找到 {results.length} 条结果
          </span>
        )}
      </header>

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 12 }}>
        <form
          action="/search"
          method="get"
          style={{ display: 'flex', gap: 8, padding: '0 16px 16px' }}
        >
          <input
            name="q"
            defaultValue={query}
            placeholder="搜索消息内容（至少 2 个字符）"
            style={{
              flex: 1,
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              padding: '9px 11px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
          <button type="submit" className="btn btn-primary">
            搜索
          </button>
        </form>

        {query.length > 0 && query.length < 2 && (
          <p className="stream-empty">请输入至少 2 个字符。</p>
        )}

        {query.length >= 2 && results.length === 0 && (
          <p className="stream-empty">没有找到匹配的消息。</p>
        )}

        {results.map((m) => (
          <div key={m.id}>
            <MessageItem message={m} />
            <div style={{ padding: '0 16px 10px 60px' }}>
              <Link href={`/m/${m.id}`} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                查看此消息 →
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
