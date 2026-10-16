/**
 * 降级轮询端点。
 *
 * SSE 在企业代理/老旧网关下可能被拦截或缓冲失效，此时客户端降级为轮询本接口。
 * 它与 SSE 补齐共用同一段逻辑（listMessagesSince），因此两条路径的数据形状完全一致，
 * 前端不需要区分处理。
 *
 * 客户端契约：
 *   GET /api/sync?since=<cursor>
 *   → { messages: [...], cursor: "<新的游标>" }
 * 首次连接（无游标）不要调用本接口，直接读频道首屏即可。
 */
import type { NextRequest } from 'next/server'
import { listMessagesSince, listVisibleChannelIds } from '@/lib/queries'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { getCurrentUser } from '@/lib/session'
import { parseId } from '@/lib/snowflake'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 一次最多返回多少条。超出的部分客户端会看到 has_more，需重新拉首屏 */
const MAX_LIMIT = 200

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录', 'unauthorized')

  const sinceRaw = req.nextUrl.searchParams.get('since')
  const since = parseId(sinceRaw)
  if (since === null) {
    return errorResponse(400, 'since 必须是有效的消息 ID', 'invalid_cursor')
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? MAX_LIMIT)
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_LIMIT)
    : MAX_LIMIT

  const channelIds = await listVisibleChannelIds()

  const messages = await listMessagesSince({
    channelIds,
    since,
    limit,
    // 自己发的消息客户端已乐观渲染，不必回显
    excludeAuthorId: user.id,
  })

  const cursor = messages.length > 0 ? messages[messages.length - 1]!.id : since.toString()

  return jsonResponse({
    messages,
    cursor,
    // 提示客户端：增量过多，建议直接重新拉取当前频道首屏
    has_more: messages.length >= limit,
  })
}
