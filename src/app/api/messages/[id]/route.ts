/**
 * 编辑 / 删除单条消息。
 *
 *     PATCH  /api/messages/<id>   { content }
 *     DELETE /api/messages/<id>
 *
 * ── 权限模型：两个刻意的决定 ────────────────────────────────────────
 *
 * 1. **只有作者能编辑自己的消息，版主也不行。**
 *    编辑的语义是"改内容"。允许管理改别人的话，等于可以替他人发言，
 *    而且事后从数据上分辨不出那句话到底是谁写的。管理权的边界是
 *    **让内容消失**（删除 / 封禁 / 隐藏），不是改写它。
 *
 * 2. **删除分两种**：作者删自己的（`DELETE_OWN_MESSAGE`），
 *    或有 `MANAGE_MESSAGE` 的人删任何人的。
 *
 * 两种能力都在服务端重新判定 —— 前端隐藏按钮只是体验，不是防线。
 *
 * ── 为什么不套新人限流门卡 ──────────────────────────────────────────
 * `src/lib/trust.ts` 约束的是"内容产出量"，而编辑/删除都不产出新内容。
 * 给它们套新人台阶会造成荒诞的结果：一个刚注册的用户打错字却要等
 * 30 秒才能改。这里改用专门的基础限流（见 RATE_RULES.editMessage）——
 * 编辑会广播 `message.updated`，反复改同一条消息同样是一种刷屏方式。
 *
 * ── 校验顺序（从便宜到昂贵）────────────────────────────────────────
 *   登录 → id 合法性 → 限流 → 读消息 → 权限 → 内容 → 写库 → 审计 → 广播
 */
import type { NextRequest } from 'next/server'
import { deleteUpload } from '@/lib/storage'
import { renderMarkdown } from '@/lib/markdown'
import { deliver } from '@/lib/realtime/hub'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { getCurrentUser, isMuted } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { getMessageById, softDeleteMessage, updateMessage } from '@/lib/queries'
import { parseId } from '@/lib/snowflake'
import { audit, AUDIT } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CONTENT_LENGTH = 8000

/** 统一的限流拒绝响应（含 Retry-After，供客户端倒计时） */
function rateLimited(retryAfterMs: number, message: string): Response {
  return jsonResponse(
    { error: message, code: 'rate_limited' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
  )
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录', 'unauthorized')

  const { id } = await ctx.params
  const messageId = parseId(id)
  if (messageId === null) return errorResponse(400, '消息 ID 无效', 'invalid_message')

  if (!hasPerm(user.perms, PERM.EDIT_OWN_MESSAGE)) {
    return errorResponse(403, '你没有编辑消息的权限', 'forbidden')
  }
  if (isMuted(user)) {
    return errorResponse(403, '禁言期间不能编辑消息', 'muted')
  }

  const limit = consume(`editMessage:user:${user.id}`, RATE_RULES.editMessage)
  if (!limit.ok) {
    return rateLimited(limit.retryAfterMs, '编辑过于频繁，请稍后再试')
  }

  const existing = await getMessageById(messageId)
  if (!existing) return errorResponse(404, '消息不存在', 'message_not_found')

  // ★ 作者限定 ★ 管理不能改别人的话，见文件头说明
  if (existing.author?.id !== user.id) {
    return errorResponse(403, '只能编辑自己发送的消息', 'not_author')
  }
  // 已删除的消息不能编辑：它的正文已经清空，编辑等于从墓碑里复活内容
  if (existing.is_deleted) {
    return errorResponse(409, '已删除的消息不能编辑', 'message_deleted')
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, '请求体不是合法 JSON', 'bad_json')
  }

  const content =
    typeof (body as { content?: unknown })?.content === 'string'
      ? ((body as { content: string }).content).trim()
      : ''

  if (content.length === 0) {
    return errorResponse(400, '消息内容不能为空（要删除请用删除）', 'empty_content')
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return errorResponse(
      400,
      `消息过长（上限 ${MAX_CONTENT_LENGTH} 字符）`,
      'content_too_long',
    )
  }

  const ip = clientIp(req.headers)
  const ok = await updateMessage({
    id: messageId,
    contentMd: content,
    contentHtml: renderMarkdown(content),
    editedBy: user.id,
  })
  if (!ok) {
    // updateMessage 在"不存在或已删除"时返回 false。前面已经查过一次，
    // 走到这里说明这中间被人删了 —— 属于并发，按冲突回更准确
    return errorResponse(409, '消息已被删除，无法编辑', 'message_deleted')
  }

  await audit({
    actorId: user.id,
    action: AUDIT.MESSAGE_EDIT,
    targetType: 'message',
    targetId: messageId,
    meta: { channel_id: existing.channel_id, length: content.length },
    ip,
  })

  // 重新读取：把新的 content_html / edited_at 一并广播出去，
  // 否则其他客户端只能拿到正文，渲染出来与刷新后不一致
  const updated = await getMessageById(messageId)
  if (updated) {
    deliver({
      // 复用 message.updated：客户端关心的是"这条消息变了"，
      // 附件补充与编辑走同一条语义，没必要再加一种事件
      type: 'message.updated',
      cursor: updated.id,
      channelId: updated.channel_id,
      payload: { message: updated },
    })
  }

  return jsonResponse({ message: updated })
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录', 'unauthorized')

  const { id } = await ctx.params
  const messageId = parseId(id)
  if (messageId === null) return errorResponse(400, '消息 ID 无效', 'invalid_message')

  const limit = consume(`deleteMessage:user:${user.id}`, RATE_RULES.deleteMessage)
  if (!limit.ok) {
    return rateLimited(limit.retryAfterMs, '操作过于频繁，请稍后再试')
  }

  const existing = await getMessageById(messageId)
  if (!existing) return errorResponse(404, '消息不存在', 'message_not_found')

  const isAuthor = existing.author?.id === user.id
  const canModerate = hasPerm(user.perms, PERM.MANAGE_MESSAGE)

  // 权限：作者需要 DELETE_OWN_MESSAGE；删别人的需要 MANAGE_MESSAGE
  if (isAuthor) {
    if (!hasPerm(user.perms, PERM.DELETE_OWN_MESSAGE)) {
      return errorResponse(403, '你没有删除消息的权限', 'forbidden')
    }
    // 刻意**不检查禁言**：禁言限制的是"发布新内容"，不是"撤回旧内容"。
    // 被禁言的人往往正想撤回引发禁言的那条消息，拦住它只会把矛盾放大；
    // 而"删了就查不到"的顾虑也不成立 —— 删除前的正文已经进了 message_edits，
    // 管理侧仍可还原（见 queries.softDeleteMessage）。
  } else if (!canModerate) {
    return errorResponse(403, '只能删除自己发送的消息', 'not_author')
  }

  const ip = clientIp(req.headers)
  const result = await softDeleteMessage(messageId, user.id)

  if (!result.ok) {
    if (result.reason === 'already_deleted') {
      // 幂等：两个标签页同时点删除，第二个不该报错。
      // 返回当前墓碑状态，客户端照常更新界面
      return jsonResponse({ message: existing, already_deleted: true })
    }
    return errorResponse(404, '消息不存在', 'message_not_found')
  }

  await audit({
    actorId: user.id,
    action: AUDIT.MESSAGE_DELETE,
    targetType: 'message',
    targetId: messageId,
    meta: {
      channel_id: existing.channel_id,
      // 区分"自己撤回"与"管理处置"：申诉复盘时这两件事性质完全不同
      moderation: !isAuthor,
      attachments: result.attachmentKeys.length,
      length: existing.content_md.length,
    },
    ip,
  })

  // 附件文件删除放在事务提交之后。反过来做的话，一旦事务回滚就会留下
  // "数据库里还有记录、文件却没了"的 404 附件 —— 那比留下孤儿文件糟糕得多
  for (const key of result.attachmentKeys) {
    try {
      await deleteUpload(key)
    } catch (err) {
      console.error(`[messages] 附件文件删除失败（数据库记录已删）: ${key}`, err)
    }
  }

  const tombstone = await getMessageById(messageId)
  if (tombstone) {
    deliver({
      type: 'message.deleted',
      cursor: tombstone.id,
      channelId: tombstone.channel_id,
      payload: { message: tombstone },
    })
  }

  return jsonResponse({
    message: tombstone,
    removed_attachments: result.attachmentKeys.length,
  })
}
