/**
 * 频道消息读取端点（供客户端向上加载历史 / resync 重拉）。
 *
 * 与 SSR 首屏共用 listMessages，保证两条路径返回的数据形状完全一致。
 */
import type { NextRequest } from 'next/server'
import { getChannelById, listMessages } from '@/lib/queries'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { parseId } from '@/lib/snowflake'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const channelId = Number(id)
  if (!Number.isInteger(channelId) || channelId <= 0) {
    return errorResponse(400, '频道 ID 无效', 'invalid_channel')
  }

  const channel = await getChannelById(channelId)
  if (!channel || channel.archived) {
    return errorResponse(404, '频道不存在', 'channel_not_found')
  }

  const sp = req.nextUrl.searchParams
  const limitParam = Number(sp.get('limit') ?? 50)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 100) : 50

  const before = parseId(sp.get('before'))
  const after = parseId(sp.get('after'))

  // 同时传 before 与 after 会让 SQL 条件自相矛盾导致空结果，直接拒绝更清晰
  if (before && after) {
    return errorResponse(400, 'before 与 after 不能同时使用', 'conflicting_cursor')
  }

  const page = await listMessages({ channelId, limit, before, after })

  return jsonResponse({
    messages: page.messages,
    has_more: page.hasMore,
    cursor: page.nextCursor,
  })
}
