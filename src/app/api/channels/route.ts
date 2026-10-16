/**
 * 公开频道列表。
 *
 * 为什么单独提供：`/api/events` 只推消息、不推频道结构，
 * 因此任何非页面客户端（移动端、桌面端、集成脚本、冒烟测试）
 * 都需要一个"先告诉我有哪些频道"的入口，否则只能去解析 HTML。
 *
 * 只返回公开字段。游客即可访问——这些信息在首页本来就是公开的。
 */
import { listChannels } from '@/lib/queries'
import { safeQuery } from '@/lib/safe-query'
import { jsonResponse } from '@/lib/serialize'
import { getCurrentUser } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  // 带上 userId 才能算未读数；游客传 null 得到全 0
  const user = await getCurrentUser()

  const nav = await safeQuery(
    () => listChannels(user?.id ?? null),
    { categories: [], channels: [] },
    'api.channels:listChannels',
  )

  return jsonResponse({
    categories: nav.categories,
    // thread 类型不在此列出：它需要从宿主频道的消息里进入，直接列出来会让导航失去层次
    channels: nav.channels
      .filter((c) => c.type !== 'thread')
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        type: c.type,
        topic: c.topic,
        category_id: c.categoryId,
        read_only: c.readOnly,
        message_count: c.messageCount,
        last_message_at: c.lastMessageAt,
        unread: c.unread,
      })),
  })
}
