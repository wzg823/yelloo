/**
 * 修改 / 归档单个频道。
 *
 *     PATCH /api/admin/channels/<id>
 *     { "name"?, "topic"?, "read_only"?, "archived"?, "position"?, "category_id"? }
 *
 * 需要 `MANAGE_CHANNEL`（仅管理员）。
 *
 * ── 两个刻意的限制 ──────────────────────────────────────────────────
 * 1. **不允许改 slug**。它是对外 URL（`/c/<slug>`）与 sitemap 的一部分，
 *    改了会让所有已被搜索引擎收录的链接、以及用户收藏的链接全部 404。
 *    确实需要换名字时，正确做法是新建频道再归档旧的。
 * 2. **归档代替删除**。频道一旦有消息就有历史价值，物理删除会连带
 *    级联删掉所有消息（外键是 onDelete: cascade）。归档让它从侧栏消失、
 *    不能再发帖，但内容仍可访问、可回溯。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm, asBoolean, asPositiveInt, asTrimmedString, readJsonObject } from '@/lib/admin-auth'
import { normalizeChannelInput } from '@/lib/admin-policy'
import { getChannelForAdmin, updateChannel } from '@/lib/admin-queries'
import { deliver } from '@/lib/realtime/hub'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { clientIp } from '@/lib/ratelimit'
import { AUDIT, audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await requirePerm(PERM.MANAGE_CHANNEL)
  if (gate.denied) return gate.denied
  const actor = gate.user

  const { id } = await ctx.params
  const channelId = Number(id)
  if (!Number.isInteger(channelId) || channelId <= 0) {
    return errorResponse(400, '频道 ID 无效', 'invalid_channel')
  }

  const channel = await getChannelForAdmin(channelId)
  if (!channel) return errorResponse(404, '频道不存在', 'channel_not_found')

  const body = await readJsonObject(req)
  const patch: {
    name?: string
    topic?: string | null
    readOnly?: boolean
    archived?: boolean
    position?: number
    categoryId?: number | null
  } = {}

  if (body.name !== undefined) {
    const name = asTrimmedString(body.name, 48)
    if (name.length === 0) return errorResponse(400, '频道名不能为空', 'invalid_name')
    patch.name = name
  }

  if (body.topic !== undefined) {
    const topic = asTrimmedString(body.topic, 200)
    if (topic.length > 200) return errorResponse(400, '话题最长 200 字符', 'invalid_topic')
    patch.topic = topic || null
  }

  if (body.position !== undefined) {
    const pos = asPositiveInt(body.position)
    patch.position = pos === null ? 0 : pos
  }

  if (body.category_id !== undefined) {
    patch.categoryId = asPositiveInt(body.category_id)
  }

  if (body.archived !== undefined) {
    patch.archived = asBoolean(body.archived)
  }

  if (body.read_only !== undefined) {
    // announce 必须只读 —— 复用规范化函数里那条耦合，避免在这里再判一次
    // 而判漏（发送接口只看 readOnly，漏了就等于人人能在公告频道发言）
    const check = normalizeChannelInput({
      name: channel.name,
      slug: channel.slug,
      type: channel.type,
      readOnly: asBoolean(body.read_only),
    })
    if (!check.ok) return errorResponse(400, check.error, check.code)
    patch.readOnly = check.value.readOnly
  }

  if (Object.keys(patch).length === 0) {
    return errorResponse(400, '没有需要修改的字段', 'nothing_to_update')
  }

  const ok = await updateChannel(channelId, patch)
  if (!ok) return errorResponse(404, '频道不存在', 'channel_not_found')

  // 归档 / 改名会影响所有人的侧栏，广播让在线客户端刷新
  const updated = await getChannelForAdmin(channelId)
  if (updated) {
    deliver({
      type: 'channel.updated',
      cursor: '0',
      channelId: null,
      payload: { channel: updated },
    })
  }

  await audit({
    actorId: actor.id,
    action: patch.archived === true ? AUDIT.CHANNEL_ARCHIVE : AUDIT.CHANNEL_UPDATE,
    targetType: 'channel',
    targetId: channelId,
    meta: { fields: Object.keys(patch), patch },
    ip: clientIp(req.headers),
  })

  return jsonResponse({ ok: true, channel: updated })
}
