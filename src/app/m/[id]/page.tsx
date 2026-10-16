/**
 * 消息永久链接页。
 *
 * 存在的意义有两个，都不是"锦上添花"：
 *   1. **引用与分享**：站内回复、外部聊天工具里贴出的链接要能落地到具体一条消息
 *   2. **SEO**：技术社区的长尾流量大量来自"某个具体问题的回答"，
 *      必须有独立 URL 才可能被搜索引擎收录
 *
 * 实现上刻意只展示这一条消息 + 上下文锚点，而不是把整个频道搬过来，
 * 避免与频道页产生大段重复内容（重复内容会互相稀释权重）。
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { MessageItem } from '@/components/MessageItem'
import { getChannelById, getMessageById } from '@/lib/queries'
import { markdownToPlainText } from '@/lib/markdown'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ id: string }> }

function parseMessageId(raw: string): bigint | null {
  if (!/^\d{1,20}$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const messageId = parseMessageId(id)
  if (messageId === null) return { title: '消息不存在' }

  const message = await getMessageById(messageId)
  if (!message) return { title: '消息不存在' }

  const plain = markdownToPlainText(message.content_md, 150)
  const title = message.author
    ? `${message.author.display_name ?? message.author.handle}：${plain.slice(0, 40)}`
    : plain.slice(0, 40)

  return {
    title,
    description: plain,
    alternates: { canonical: `/m/${id}` },
    openGraph: {
      title,
      description: plain,
      type: 'article',
      publishedTime: message.created_at,
    },
    // 已删除的消息不应出现在搜索结果里
    robots: message.is_deleted ? { index: false, follow: true } : { index: true, follow: true },
  }
}

export default async function MessagePage({ params }: Props) {
  const { id } = await params
  const messageId = parseMessageId(id)
  if (messageId === null) notFound()

  const message = await getMessageById(messageId)
  if (!message) notFound()

  const channel = await getChannelById(message.channel_id)

  // 结构化数据：让搜索引擎理解这是论坛里的一条发言，
  // 有助于在结果页展示作者与时间（提升点击率）。
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: markdownToPlainText(message.content_md, 110),
    datePublished: message.created_at,
    ...(message.edited_at ? { dateModified: message.edited_at } : {}),
    author: message.author
      ? { '@type': 'Person', name: message.author.display_name ?? message.author.handle }
      : undefined,
    isPartOf: channel ? { '@type': 'DiscussionForumPosting', name: channel.name } : undefined,
    url: `${process.env.SITE_URL ?? ''}/m/${message.id}`,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <header className="channel-header">
        <h1 style={{ fontSize: 15 }}>
          {channel ? (
            <Link href={`/c/${channel.slug}`}>#{channel.name}</Link>
          ) : (
            '频道已删除'
          )}
        </h1>
        <span className="channel-topic">消息详情</span>
      </header>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          maxWidth: 820,
          width: '100%',
          margin: '0 auto',
          paddingTop: 12,
        }}
      >
        <MessageItem message={message} />

        {channel && (
          <div style={{ padding: '16px 16px 40px 60px' }}>
            <Link href={`/c/${channel.slug}`} className="btn btn-ghost">
              查看完整讨论 →
            </Link>
          </div>
        )}
      </div>

      <script
        type="application/ld+json"
        // JSON.stringify 结果插入 <script> 前必须转义 <，否则内容里的
        // `</script>` 会提前闭合标签造成 XSS。这是 JSON-LD 的经典坑。
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />
    </div>
  )
}
