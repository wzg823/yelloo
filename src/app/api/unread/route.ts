/**
 * GET /api/unread —— 各频道未读数。
 *
 * 用途：客户端在收到实时消息、或从后台切回前台时刷新侧栏红点，
 * 不需要整页重载（整页重载会打断正在阅读的滚动位置）。
 *
 * 未登录返回空对象而不是 401：游客的"未读"就是没有，
 * 返回 401 会迫使客户端为匿名场景写一条分支，没有意义。
 */
import { countUnreadByChannel } from '@/lib/queries'
import { safeQuery } from '@/lib/safe-query'
import { jsonResponse } from '@/lib/serialize'
import { getCurrentUser } from '@/lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return jsonResponse({ unread: {}, total: 0 })

  const map = await safeQuery(
    () => countUnreadByChannel(user.id),
    new Map<number, number>(),
    'api.unread:countUnreadByChannel',
  )

  const unread: Record<string, number> = {}
  let total = 0
  for (const [channelId, count] of map) {
    unread[String(channelId)] = count
    total += count
  }

  return jsonResponse({ unread, total })
}
