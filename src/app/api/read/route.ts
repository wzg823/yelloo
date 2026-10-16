/**
 * 推进已读位点。
 *
 * 单独做一个轻量端点（而不是塞进消息列表响应里）的理由：
 * 读取接口必须无副作用，否则任何预取/爬虫访问都会污染用户的未读状态。
 */
import type { NextRequest } from 'next/server'
import { markRead } from '@/lib/queries'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { getCurrentUser } from '@/lib/session'
import { parseId } from '@/lib/snowflake'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录', 'unauthorized')

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, '请求体不是合法 JSON', 'bad_json')
  }

  const payload = body as { channel_id?: unknown; message_id?: unknown }
  const channelId = Number(payload.channel_id)
  const messageId = parseId(payload.message_id)

  if (!Number.isInteger(channelId) || channelId <= 0) {
    return errorResponse(400, 'channel_id 无效', 'invalid_channel')
  }
  if (messageId === null) {
    return errorResponse(400, 'message_id 无效', 'invalid_message')
  }

  await markRead(user.id, channelId, messageId)

  return jsonResponse({ ok: true })
}
