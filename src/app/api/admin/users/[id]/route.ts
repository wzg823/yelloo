/**
 * 处置单个用户。
 *
 *     PATCH /api/admin/users/<id>
 *     { "action": "mute",     "duration": "24h", "reason": "..." }
 *     { "action": "unmute" }
 *     { "action": "ban",      "duration": "7d" | "forever", "reason": "..." }
 *     { "action": "unban" }
 *     { "action": "set_role", "role": "mod" | "member" }
 *     { "action": "set_trust","trust_level": 0 | 1 | 2 }
 *
 * ── 为什么用显式的 action 而不是"看哪些字段存在" ────────────────────
 * 靠字段推断动作的话，一个手写的请求体同时带上 `duration` 和 `role`
 * 就会触发两个动作，而调用方可能只想做其中一个。显式 action 让
 * "这次要做什么"只有一个答案，也便于把每个动作的权限单独列出来。
 *
 * ── 每个动作三道关，缺一不可 ────────────────────────────────────────
 *   1. 能力位（hasPerm）—— "这个人有没有禁言这个能力"
 *   2. 等级关系（canModerateTarget/canAssignRole）—— "他能不能对**这个**人用"
 *   3. 审计 —— 每一次都留痕
 * 第 2 关是防横向提权的关键：位运算永远判不出"版主封版主"。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm, asPositiveInt, asTrimmedString, readJsonObject } from '@/lib/admin-auth'
import { canAssignRole, canModerateTarget, parseDuration, roleRank } from '@/lib/admin-policy'
import {
  clearActiveBans,
  getUserForAdmin,
  insertBan,
  updateUserModeration,
} from '@/lib/admin-queries'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { clientIp } from '@/lib/ratelimit'
import { AUDIT, audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ACTIONS = ['mute', 'unmute', 'ban', 'unban', 'set_role', 'set_trust'] as const
type Action = (typeof ACTIONS)[number]
const VALID_ROLES = ['member', 'mod', 'admin'] as const

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const userId = Number(id)
  if (!Number.isInteger(userId) || userId <= 0) {
    return errorResponse(400, '用户 ID 无效', 'invalid_user')
  }

  const body = await readJsonObject(req)
  const action = body.action as Action
  if (!ACTIONS.includes(action)) {
    return errorResponse(
      400,
      `action 必须是 ${ACTIONS.join(' / ')} 之一`,
      'invalid_action',
    )
  }

  // 入口门槛：能走到这里至少是版主。具体动作的权限在下面各自再判
  const gate = await requirePerm(PERM.MUTE_MEMBER)
  if (gate.denied) return gate.denied
  const actor = gate.user

  const target = await getUserForAdmin(userId)
  if (!target) return errorResponse(404, '用户不存在', 'user_not_found')

  const ip = clientIp(req.headers)
  const reason = asTrimmedString(body.reason, 500) || null

  // ── 等级关系（所有动作共用）──────────────────────────────────────
  // 即使解禁也要判：否则一个版主可以解掉另一个管理员刚下的封禁，
  // 变成两个管理员互相拆台。
  //
  // 解禁按被解的那个动作归类（unmute → mute、unban → ban），这样
  // "版主不能解管理员的封"这条规则自然成立，不需要单独再写一遍。
  const policyAction: 'mute' | 'ban' | 'set_role' | 'set_trust' =
    action === 'mute' || action === 'unmute'
      ? 'mute'
      : action === 'ban' || action === 'unban'
        ? 'ban'
        : action === 'set_role'
          ? 'set_role'
          : 'set_trust'

  const policy = canModerateTarget(actor, target, policyAction)
  if (!policy.ok) return errorResponse(403, policy.error, policy.code)

  switch (action) {
    // ── 禁言 ──────────────────────────────────────────────────────
    case 'mute': {
      const perm = await requirePerm(PERM.MUTE_MEMBER)
      if (perm.denied) return perm.denied

      const duration = parseDuration(
        typeof body.duration === 'string' ? body.duration : '24h',
      )
      if (!duration.ok) return errorResponse(400, duration.error, 'invalid_duration')

      // status 与 mutedUntil 必须一起写，否则会出现"界面显示禁言、实际能发言"
      // 或反之（见 admin-queries.updateUserModeration 的说明）
      const until = duration.ms === null ? null : new Date(Date.now() + duration.ms)
      await updateUserModeration({ id: userId, patch: { status: 'muted', mutedUntil: until } })

      await audit({
        actorId: actor.id,
        action: AUDIT.USER_MUTE,
        targetType: 'user',
        targetId: userId,
        meta: { until: until ? until.toISOString() : null, reason },
        ip,
      })

      return jsonResponse({
        ok: true,
        status: 'muted',
        muted_until: until ? until.toISOString() : null,
      })
    }

    // ── 解除禁言 ──────────────────────────────────────────────────
    case 'unmute': {
      await updateUserModeration({ id: userId, patch: { status: 'active', mutedUntil: null } })
      await audit({
        actorId: actor.id,
        action: AUDIT.USER_UNMUTE,
        targetType: 'user',
        targetId: userId,
        meta: { reason },
        ip,
      })
      return jsonResponse({ ok: true, status: 'active' })
    }

    // ── 封禁 ──────────────────────────────────────────────────────
    case 'ban': {
      const perm = await requirePerm(PERM.BAN_MEMBER)
      if (perm.denied) {
        // 明确说明原因：版主点"封禁"时最需要知道的就是自己没这个权限，
        // 而不是收到一个含糊的 403
        return errorResponse(403, '你没有封禁的权限（版主只能禁言）', 'forbidden')
      }

      const duration = parseDuration(
        typeof body.duration === 'string' ? body.duration : 'forever',
      )
      if (!duration.ok) return errorResponse(400, duration.error, 'invalid_duration')

      const until = duration.ms === null ? null : new Date(Date.now() + duration.ms)
      await updateUserModeration({ id: userId, patch: { status: 'banned', mutedUntil: null } })
      await insertBan({
        userId,
        reason: reason || '未填写理由',
        until,
        createdBy: actor.id,
      })

      await audit({
        actorId: actor.id,
        action: AUDIT.USER_BAN,
        targetType: 'user',
        targetId: userId,
        meta: { until: until ? until.toISOString() : null, reason },
        ip,
      })

      return jsonResponse({
        ok: true,
        status: 'banned',
        banned_until: until ? until.toISOString() : null,
      })
    }

    // ── 解封 ──────────────────────────────────────────────────────
    case 'unban': {
      const perm = await requirePerm(PERM.BAN_MEMBER)
      if (perm.denied) return errorResponse(403, '你没有解封的权限', 'forbidden')

      await updateUserModeration({ id: userId, patch: { status: 'active', mutedUntil: null } })
      // bans 表是留痕：解封时清掉未到期的记录，这样"当前是否被封"只看那张表也对
      const cleared = await clearActiveBans(userId)

      await audit({
        actorId: actor.id,
        action: AUDIT.USER_UNBAN,
        targetType: 'user',
        targetId: userId,
        meta: { cleared_bans: cleared, reason },
        ip,
      })

      return jsonResponse({ ok: true, status: 'active', cleared_bans: cleared })
    }

    // ── 改角色 ────────────────────────────────────────────────────
    case 'set_role': {
      const perm = await requirePerm(PERM.MANAGE_ROLE)
      if (perm.denied) return errorResponse(403, '你没有修改角色的权限', 'forbidden')

      const role = body.role
      if (typeof role !== 'string' || !VALID_ROLES.includes(role as 'member')) {
        return errorResponse(400, `role 必须是 ${VALID_ROLES.join(' / ')}`, 'invalid_role')
      }

      // ★ 第二道关：不能把人提到与自己同级或更高 ★
      // 否则一个被盗的管理员账号可以立刻造出第二个管理员，把一次入侵变成永久占领
      const assign = canAssignRole(actor, target, role)
      if (!assign.ok) return errorResponse(403, assign.error, assign.code)

      const previousRole = target.role
      await updateUserModeration({ id: userId, patch: { role: role as 'member' } })

      await audit({
        actorId: actor.id,
        action:
          roleRank(role) < roleRank(previousRole)
            ? AUDIT.USER_ROLE_REVOKE
            : AUDIT.USER_ROLE_GRANT,
        targetType: 'user',
        targetId: userId,
        meta: { from: previousRole, to: role, reason },
        ip,
      })

      return jsonResponse({ ok: true, role, previous_role: previousRole })
    }

    // ── 改信任等级 ────────────────────────────────────────────────
    case 'set_trust': {
      // 不用 asPositiveInt：它把 0 当成"无效"，而 0（新人）恰恰是最常用的值。
      // 这里自己解析，数字与字符串两种写法都接受
      const rawLevel =
        typeof body.trust_level === 'string' ? Number(body.trust_level) : body.trust_level
      if (
        typeof rawLevel !== 'number' ||
        !Number.isInteger(rawLevel) ||
        rawLevel < 0 ||
        rawLevel > 2
      ) {
        return errorResponse(400, 'trust_level 必须是 0 / 1 / 2', 'invalid_trust_level')
      }
      const value = rawLevel

      await updateUserModeration({ id: userId, patch: { trustLevel: value } })

      await audit({
        actorId: actor.id,
        action: AUDIT.USER_TRUST_SET,
        targetType: 'user',
        targetId: userId,
        meta: { from: target.trustLevel, to: value, reason },
        ip,
      })

      return jsonResponse({ ok: true, trust_level: value, previous: target.trustLevel })
    }

    default:
      return errorResponse(400, 'action 无效', 'invalid_action')
  }
}
