/**
 * 处置一条举报。
 *
 *     POST /api/admin/reports/<id>
 *     {
 *       "action": "resolve" | "dismiss",
 *       "note": "处理说明",
 *       "delete_message": true,             // 可选：同时删掉被举报的消息
 *       "mute_user": "24h",                 // 可选：同时禁言作者
 *       "ban_user":  "7d" | "forever",      // 可选：同时封禁作者
 *       "reason": "处置理由"
 *     }
 *
 * ── 为什么把"处置"做成一次请求而不是三次 ────────────────────────────
 * 审核的真实动作是连在一起发生的：看到违规内容 → 删掉 → 封人 → 结案。
 * 拆成三个请求的话，中间任何一步失败都会留下"删了但没结案"的中间态，
 * 而管理员往往以为已经处理完了。一次请求 + 每一步单独记账，能保证
 * 至少**每一项处置都有审计留痕**，即使后面某一步失败。
 *
 * ── 三项权限分开判，且**拒绝时要明说** ──────────────────────────────
 * 删消息要 `MANAGE_MESSAGE`，禁言要 `MUTE_MEMBER`，封禁要 `BAN_MEMBER`。
 * 版主有前两者但没有 `BAN_MEMBER`。传了越权的动作必须**明确报错**，
 * 不能静默忽略 —— 静默忽略最危险：管理员以为人已经被封了。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm, asBoolean, asTrimmedString, readJsonObject } from '@/lib/admin-auth'
import { canModerateTarget, parseDuration } from '@/lib/admin-policy'
import {
  getReportById,
  getReportTargets,
  getUserForAdmin,
  insertBan,
  resolveReport,
  updateUserModeration,
} from '@/lib/admin-queries'
import { softDeleteMessage } from '@/lib/queries'
import { deleteUpload } from '@/lib/storage'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { clientIp } from '@/lib/ratelimit'
import { AUDIT, audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** `false` / `null` / `undefined` 都表示"不做这个动作" */
function wantsAction(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== ''
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  // 入口只需要"能处理举报"；具体处置动作在下面各自再判一次权限
  const gate = await requirePerm(PERM.MANAGE_REPORT)
  if (gate.denied) return gate.denied
  const actor = gate.user

  const { id } = await ctx.params
  const reportId = Number(id)
  if (!Number.isInteger(reportId) || reportId <= 0) {
    return errorResponse(400, '举报 ID 无效', 'invalid_report')
  }

  const report = await getReportById(reportId)
  if (!report) return errorResponse(404, '举报不存在', 'report_not_found')
  if (report.status !== 'open') {
    return errorResponse(409, '该举报已被处理', 'already_handled')
  }

  const targets = await getReportTargets(reportId)
  if (!targets) return errorResponse(404, '举报不存在', 'report_not_found')

  const body = await readJsonObject(req)
  const action = body.action === 'dismiss' ? 'dismiss' : 'resolve'
  const note = asTrimmedString(body.note, 500) || null
  const reason = asTrimmedString(body.reason, 500)
  const ip = clientIp(req.headers)

  const wantDelete = asBoolean(body.delete_message)
  const wantMute = wantsAction(body.mute_user)
  const wantBan = wantsAction(body.ban_user)

  const applied: string[] = []

  // ── 1) 删除被举报的消息 ─────────────────────────────────────────
  if (wantDelete) {
    const perm = await requirePerm(PERM.MANAGE_MESSAGE)
    if (perm.denied) return perm.denied

    if (!targets.messageId) {
      return errorResponse(400, '该举报没有关联消息，无法删除', 'no_message')
    }

    const result = await softDeleteMessage(targets.messageId, actor.id)
    if (result.ok) {
      // 文件删除放在事务提交之后，理由见 api/messages/[id]/route.ts
      for (const key of result.attachmentKeys) {
        try {
          await deleteUpload(key)
        } catch (err) {
          console.error(`[admin] 附件文件删除失败（记录已删）: ${key}`, err)
        }
      }
      applied.push('delete_message')

      await audit({
        actorId: actor.id,
        action: AUDIT.MESSAGE_DELETE,
        targetType: 'message',
        targetId: targets.messageId,
        meta: {
          channel_id: targets.channelId,
          moderation: true,
          report_id: reportId,
          attachments: result.attachmentKeys.length,
        },
        ip,
      })
    } else if (result.reason === 'already_deleted') {
      // 消息可能已经被作者自己删了。这不影响继续结案
      applied.push('delete_message_already_deleted')
    }
  }

  // ── 2) 禁言 / 封禁 ──────────────────────────────────────────────
  if (wantMute || wantBan) {
    if (!targets.targetUserId) {
      return errorResponse(400, '该举报没有关联用户，无法禁言或封禁', 'no_target_user')
    }

    // 只取一次：两次处置用的是同一个对象，重复查询还可能读到中间状态
    const target = await getUserForAdmin(targets.targetUserId)
    if (!target) return errorResponse(404, '被处置的用户不存在', 'target_missing')

    if (wantMute) {
      const perm = await requirePerm(PERM.MUTE_MEMBER)
      if (perm.denied) return perm.denied

      // ★ 能力位之外还要判等级关系 ★ 否则版主之间可以互相禁言
      const policy = canModerateTarget(actor, target, 'mute')
      if (!policy.ok) return errorResponse(403, policy.error, policy.code)

      const duration = parseDuration(typeof body.mute_user === 'string' ? body.mute_user : '24h')
      if (!duration.ok) return errorResponse(400, duration.error, 'invalid_duration')

      const until = duration.ms === null ? null : new Date(Date.now() + duration.ms)
      await updateUserModeration({ id: target.id, patch: { status: 'muted', mutedUntil: until } })
      applied.push('mute_user')

      await audit({
        actorId: actor.id,
        action: AUDIT.USER_MUTE,
        targetType: 'user',
        targetId: target.id,
        meta: {
          until: until ? until.toISOString() : null,
          report_id: reportId,
          reason: reason || null,
        },
        ip,
      })
    }

    if (wantBan) {
      const perm = await requirePerm(PERM.BAN_MEMBER)
      if (perm.denied) {
        return errorResponse(403, '你没有封禁的权限（版主只能禁言）', 'forbidden')
      }

      const policy = canModerateTarget(actor, target, 'ban')
      if (!policy.ok) return errorResponse(403, policy.error, policy.code)

      const duration = parseDuration(typeof body.ban_user === 'string' ? body.ban_user : 'forever')
      if (!duration.ok) return errorResponse(400, duration.error, 'invalid_duration')

      const until = duration.ms === null ? null : new Date(Date.now() + duration.ms)
      await updateUserModeration({ id: target.id, patch: { status: 'banned', mutedUntil: null } })
      await insertBan({
        userId: target.id,
        reason: reason || '举报处置',
        until,
        createdBy: actor.id,
        reportId,
      })
      applied.push('ban_user')

      await audit({
        actorId: actor.id,
        action: AUDIT.USER_BAN,
        targetType: 'user',
        targetId: target.id,
        meta: {
          until: until ? until.toISOString() : null,
          report_id: reportId,
          reason: reason || null,
        },
        ip,
      })
    }
  }

  // ── 3) 结案 ─────────────────────────────────────────────────────
  const closed = await resolveReport({
    id: reportId,
    handledBy: actor.id,
    status: action === 'dismiss' ? 'dismissed' : 'resolved',
    note,
  })
  if (!closed) {
    // 只有并发时才会走到这里：另一个人刚好处理了同一张单子
    return errorResponse(409, '该举报已被其他人处理', 'already_handled')
  }

  await audit({
    actorId: actor.id,
    action: action === 'dismiss' ? AUDIT.REPORT_DISMISS : AUDIT.REPORT_RESOLVE,
    targetType: 'report',
    targetId: reportId,
    meta: { note, applied },
    ip,
  })

  return jsonResponse({
    ok: true,
    status: action === 'dismiss' ? 'dismissed' : 'resolved',
    applied,
  })
}
