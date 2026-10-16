/**
 * 发送消息。
 *
 * 校验顺序刻意如此（从便宜到昂贵，且先鉴权后落库）：
 *   1. 登录   2. 权限   3. 禁言   4. 限流   5. 内容   6. 写库   7. 广播
 *
 * 广播放在写库成功之后。若广播失败，消息仍在库里（用户刷新可见），
 * 这比"广播成功但没入库"要好得多——后者会造成"看到过但找不回"的幽灵消息。
 */
import type { NextRequest } from 'next/server'
import { getChannelById, insertMessage, getMessageById } from '@/lib/queries'
import { renderMarkdown } from '@/lib/markdown'
import { deliver } from '@/lib/realtime/hub'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { getCurrentUser, isMuted } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { nextId } from '@/lib/snowflake'
import { audit, AUDIT } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CONTENT_LENGTH = 8000

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录', 'unauthorized')

  if (!hasPerm(user.perms, PERM.SEND_MESSAGE)) {
    return errorResponse(403, '你没有发言权限', 'forbidden')
  }

  if (isMuted(user)) {
    const until = user.mutedUntil ? `，解禁时间 ${user.mutedUntil.toISOString()}` : ''
    return errorResponse(403, `你当前处于禁言状态${until}`, 'muted')
  }

  const ip = clientIp(req.headers)
  const limit = consume(`postMessage:user:${user.id}`, RATE_RULES.postMessage)
  if (!limit.ok) {
    return jsonResponse(
      { error: '发送过于频繁，请稍后再试', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, '请求体不是合法 JSON', 'bad_json')
  }

  const payload = body as {
    channel_id?: unknown
    content?: unknown
    reply_to_id?: unknown
  }

  const channelId = Number(payload.channel_id)
  if (!Number.isInteger(channelId) || channelId <= 0) {
    return errorResponse(400, 'channel_id 无效', 'invalid_channel')
  }

  const content = typeof payload.content === 'string' ? payload.content.trim() : ''
  if (content.length === 0) {
    return errorResponse(400, '消息内容不能为空', 'empty_content')
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return errorResponse(
      400,
      `消息过长（上限 ${MAX_CONTENT_LENGTH} 字符，代码请用附件或代码块）`,
      'content_too_long',
    )
  }

  const channel = await getChannelById(channelId)
  if (!channel || channel.archived) {
    return errorResponse(404, '频道不存在或已归档', 'channel_not_found')
  }
  if (channel.readOnly && !hasPerm(user.perms, PERM.MANAGE_MESSAGE)) {
    return errorResponse(403, '该频道为只读', 'read_only')
  }

  let replyToId: bigint | null = null
  if (payload.reply_to_id != null && payload.reply_to_id !== '') {
    try {
      replyToId = BigInt(String(payload.reply_to_id))
    } catch {
      return errorResponse(400, 'reply_to_id 无效', 'invalid_reply')
    }
  }

  const id = nextId()
  const contentHtml = renderMarkdown(content)

  await insertMessage({
    id,
    channelId,
    authorId: user.id,
    contentMd: content,
    contentHtml,
    replyToId,
  })

  await audit({
    actorId: user.id,
    action: AUDIT.MESSAGE_CREATE,
    targetType: 'message',
    targetId: id,
    meta: { channel_id: channelId, length: content.length },
    ip,
  })

  // 重新读取以拿到完整的作者字段（display_name/avatar/role），保证各客户端渲染一致
  const message = await getMessageById(id)

  if (message) {
    deliver({
      type: 'message.created',
      cursor: message.id,
      channelId,
      payload: { message },
    })
  }

  return jsonResponse({ message }, { status: 201 })
}

/** 供客户端探测 SSE 可用性的轻量端点 */
export async function GET() {
  return jsonResponse({ ok: true, hint: 'POST 此路径以发送消息' })
}
