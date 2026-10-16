/**
 * 用户举报入口。
 *
 *     POST /api/reports  { target_type: 'message'|'user', message_id?, user_id?, reason }
 *
 * ── 为什么必须登录才能举报 ──────────────────────────────────────────
 * 匿名举报无法追责，也无法挡住"一个人刷满队列"。而公开社区最怕的
 * 恰恰是审核队列被噪音淹没 —— 那会让真正的举报被埋掉。
 *
 * ── 同一目标重复举报会合并 ──────────────────────────────────────────
 * 同一个人重复举报同一条消息没有新增信息量，直接告诉他"已在队列中"。
 * 但**不同的人**举报同一条消息是重要信号，不能合并 —— 所以去重的键是
 * (举报人, 目标)，不是目标本身。
 */
import type { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/session'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { createReport, hasOpenReportFrom } from '@/lib/admin-queries'
import { getMessageById } from '@/lib/queries'
import { parseId } from '@/lib/snowflake'
import { AUDIT, audit } from '@/lib/audit'
import { asPositiveInt, asTrimmedString, readJsonObject } from '@/lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_REASON = 4
const MAX_REASON = 500

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录才能举报', 'unauthorized')

  const limit = consume(`report:user:${user.id}`, RATE_RULES.report)
  if (!limit.ok) {
    return jsonResponse(
      { error: '举报过于频繁，请稍后再试', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    )
  }

  const body = await readJsonObject(req)
  const targetType = body.target_type === 'user' ? 'user' : 'message'
  const reason = asTrimmedString(body.reason, MAX_REASON)

  if (reason.length < MIN_REASON) {
    return errorResponse(400, `请填写举报理由（至少 ${MIN_REASON} 个字）`, 'reason_too_short')
  }

  const ip = clientIp(req.headers)

  if (targetType === 'message') {
    const messageId = parseId(body.message_id)
    if (messageId === null) {
      return errorResponse(400, 'message_id 无效', 'invalid_message')
    }

    const message = await getMessageById(messageId)
    if (!message) return errorResponse(404, '消息不存在', 'message_not_found')
    // 举报一条已删除的消息没有意义：它已经不在任何人的视野里了
    if (message.is_deleted) {
      return errorResponse(409, '该消息已被删除', 'already_deleted')
    }
    // 自己举报自己通常是误操作，也可能被用来刷队列
    if (message.author?.id === user.id) {
      return errorResponse(400, '不能举报自己的消息', 'self_report')
    }

    if (await hasOpenReportFrom({ reporterId: user.id, messageId })) {
      return jsonResponse(
        { ok: true, deduplicated: true, message: '你已举报过这条消息，我们正在处理' },
        { status: 200 },
      )
    }

    const id = await createReport({
      reporterId: user.id,
      targetType: 'message',
      messageId,
      // 一并记下频道与作者：审核界面要按这两项展示与跳转，
      // 而且消息被删掉之后这两个字段仍然有助于追溯
      channelId: message.channel_id,
      targetUserId: message.author?.id ?? null,
      reason,
    })

    await audit({
      actorId: user.id,
      action: AUDIT.REPORT_CREATE,
      targetType: 'report',
      targetId: id,
      meta: { report_target: 'message', message_id: messageId.toString(), channel_id: message.channel_id },
      ip,
    })

    return jsonResponse({ ok: true, id }, { status: 201 })
  }

  // ── 举报用户 ────────────────────────────────────────────────────
  const userId = asPositiveInt(body.user_id)
  if (userId === null) return errorResponse(400, 'user_id 无效', 'invalid_user')
  if (userId === user.id) return errorResponse(400, '不能举报自己', 'self_report')

  if (await hasOpenReportFrom({ reporterId: user.id, targetUserId: userId })) {
    return jsonResponse(
      { ok: true, deduplicated: true, message: '你已举报过该用户，我们正在处理' },
      { status: 200 },
    )
  }

  const id = await createReport({
    reporterId: user.id,
    targetType: 'user',
    targetUserId: userId,
    reason,
  })

  await audit({
    actorId: user.id,
    action: AUDIT.REPORT_CREATE,
    targetType: 'report',
    targetId: id,
    meta: { report_target: 'user', target_user_id: userId },
    ip,
  })

  return jsonResponse({ ok: true, id }, { status: 201 })
}
