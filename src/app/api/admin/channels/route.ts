/**
 * 频道管理。
 *
 *     GET  /api/admin/channels        列出全部频道（含已归档）
 *     POST /api/admin/channels        新建频道
 *
 * 需要 `MANAGE_CHANNEL`（仅管理员）。版主能管内容，但改频道结构会直接影响
 * 所有人的侧栏与已有链接，属于站长的决定。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm, asBoolean, asPositiveInt, asTrimmedString, readJsonObject } from '@/lib/admin-auth'
import { normalizeChannelInput } from '@/lib/admin-policy'
import { createChannel, listCategories, listChannelsForAdmin } from '@/lib/admin-queries'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { clientIp } from '@/lib/ratelimit'
import { AUDIT, audit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = await requirePerm(PERM.MANAGE_CHANNEL)
  if (gate.denied) return gate.denied

  const [channels, categories] = await Promise.all([listChannelsForAdmin(), listCategories()])
  return jsonResponse({ channels, categories })
}

export async function POST(req: NextRequest) {
  const gate = await requirePerm(PERM.MANAGE_CHANNEL)
  if (gate.denied) return gate.denied
  const actor = gate.user

  const body = await readJsonObject(req)
  const parsed = normalizeChannelInput({
    name: asTrimmedString(body.name, 48),
    slug: asTrimmedString(body.slug, 32),
    type: asTrimmedString(body.type, 16) || 'text',
    topic: asTrimmedString(body.topic, 200) || null,
    readOnly: asBoolean(body.read_only),
    categoryId: asPositiveInt(body.category_id),
    position: asPositiveInt(body.position) ?? 0,
  })
  if (!parsed.ok) return errorResponse(400, parsed.error, parsed.code)

  // slug 是对外 URL 的一部分。重名会撞唯一索引，提前给出可读的提示，
  // 而不是把 Postgres 的约束名抛给管理员
  const existing = await listChannelsForAdmin()
  if (existing.some((c) => c.slug === parsed.value.slug)) {
    return errorResponse(409, `slug "${parsed.value.slug}" 已被占用`, 'slug_taken')
  }

  let id: number
  try {
    id = await createChannel({
      slug: parsed.value.slug,
      name: parsed.value.name,
      type: parsed.value.type as 'text' | 'forum' | 'announce' | 'thread',
      topic: parsed.value.topic,
      readOnly: parsed.value.readOnly,
      categoryId: parsed.value.categoryId,
      position: parsed.value.position,
    })
  } catch (err) {
    console.error('[admin] 创建频道失败:', err)
    return errorResponse(500, '创建频道失败', 'db_error')
  }

  await audit({
    actorId: actor.id,
    action: AUDIT.CHANNEL_CREATE,
    targetType: 'channel',
    targetId: id,
    meta: { slug: parsed.value.slug, type: parsed.value.type, read_only: parsed.value.readOnly },
    ip: clientIp(req.headers),
  })

  return jsonResponse(
    {
      ok: true,
      id,
      // ★ 显式映射成 snake_case，不要直接把 parsed.value 丢出去 ★
      // 内部表示用的是 camelCase（readOnly / categoryId），而对外约定一律
      // snake_case（见 PublicMessage）。直接透传会让同一个接口在不同字段上
      // 混用两种风格，客户端只能靠猜 —— 而且这种不一致不会报错，只会静默取到
      // undefined（这个 bug 就是被验证脚本抓出来的）。
      channel: {
        id,
        slug: parsed.value.slug,
        name: parsed.value.name,
        type: parsed.value.type,
        topic: parsed.value.topic,
        read_only: parsed.value.readOnly,
        category_id: parsed.value.categoryId,
        position: parsed.value.position,
      },
    },
    { status: 201 },
  )
}
