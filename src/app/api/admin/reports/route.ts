/**
 * 举报队列（管理侧）。
 *
 *     GET /api/admin/reports?status=open&limit=50
 *
 * 需要 `MANAGE_REPORT`（版主及以上）。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm } from '@/lib/admin-auth'
import { countOpenReports, listReports } from '@/lib/admin-queries'
import { jsonResponse } from '@/lib/serialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_STATUS = new Set(['open', 'resolved', 'dismissed', 'all'])

export async function GET(req: NextRequest) {
  const gate = await requirePerm(PERM.MANAGE_REPORT)
  if (gate.denied) return gate.denied

  const sp = req.nextUrl.searchParams
  const statusRaw = sp.get('status') ?? 'open'
  const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'open'
  const limitRaw = Number(sp.get('limit') ?? 50)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50

  const [items, openCount] = await Promise.all([
    listReports({ status, limit }),
    countOpenReports(),
  ])

  return jsonResponse({ reports: items, open_count: openCount, status })
}
