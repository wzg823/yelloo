import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChannelStream } from '@/components/ChannelStream'
import { getChannelBySlug, latestMessageId, listMessages } from '@/lib/queries'
import { parseId } from '@/lib/snowflake'

/**
 * 频道页。
 *
 * SEO 的关键设计：首屏 50 条消息**服务端渲染成真实 HTML**。
 * 如果改成客户端 fetch，爬虫只会看到一个空壳，这个公开社区就失去了自然流量。
 *
 * force-dynamic 的原因见 src/app/page.tsx 的说明：构建期无数据库可连，
 * 不能依赖静态预渲染。SSR 输出对爬虫依然完整。
 */
export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ before?: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const channel = await getChannelBySlug(slug)
  if (!channel) return { title: '频道不存在' }

  const title = `${channel.name}`
  const description =
    channel.topic ?? `${channel.name} 频道的最新讨论，来自 ${process.env.SITE_NAME ?? '技术社区'}`

  return {
    title,
    description,
    alternates: { canonical: `/c/${channel.slug}` },
    openGraph: { title, description, type: 'website' },
  }
}

export default async function ChannelPage({ params, searchParams }: Props) {
  const [{ slug }, { before }] = await Promise.all([params, searchParams])

  const channel = await getChannelBySlug(slug)
  if (!channel || channel.archived) notFound()

  const [{ messages, hasMore, nextCursor }, maxId] = await Promise.all([
    listMessages({
      channelId: channel.id,
      limit: 50,
      // 用户可控的查询参数必须校验，否则 BigInt('abc') 会直接抛异常变成 500
      before: parseId(before),
    }),
    latestMessageId(),
  ])

  // 游标 = 全局最大 id，而不是本页最后一条。
  // 用它做 SSE 起点可以避免重连时把"自己没看到但已存在的"消息重复补发。
  const initialCursor = maxId.toString()

  return (
    <>
      <header className="channel-header">
        <h1>
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {channel.type === 'forum' ? '▤' : channel.type === 'announce' ? '📢' : '#'}
          </span>
          {channel.name}
        </h1>
        {channel.topic && <span className="channel-topic">{channel.topic}</span>}
        {channel.readOnly && (
          <span className="channel-topic" style={{ color: 'var(--warning)' }}>
            只读
          </span>
        )}
      </header>

      <ChannelStream
        channelId={channel.id}
        channelSlug={channel.slug}
        initialMessages={messages}
        initialCursor={initialCursor}
        initialHasMore={hasMore}
        readOnly={channel.readOnly}
      />

      {/* 供爬虫发现更早内容：分页 URL 必须可被索引，否则历史消息永远进不了搜索 */}
      {hasMore && nextCursor && (
        <link rel="prev" href={`/c/${channel.slug}?before=${nextCursor}`} />
      )}
    </>
  )
}
