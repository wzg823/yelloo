/**
 * 用户列表（管理侧）。
 *
 *     GET /api/admin/users?q=<handle 或邮箱>&limit=50&offset=0
 *
 * 需要 `MUTE_MEMBER`（版主及以上）。这是本站唯一会成批暴露**邮箱**的接口，
 * 所以门槛按"能禁言"来定，而不是"登录了就能看"。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm } from '@/lib/admin-auth'
import { listUsersForAdmin } from '@/lib/admin-queries'
import { jsonResponse } from '@/lib/serialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const gate = await requirePerm(PERM.MUTE_MEMBER)
  if (gate.denied) return gate.denied

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').slice(0, 100)
  const limitRaw = Number(sp.get('limit') ?? 50)
  const offsetRaw = Number(sp.get('offset') ?? 0)

  const { users, total } = await listUsersForAdmin({
    q,
    limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
  })

  return jsonResponse({ users, total, q })
}
