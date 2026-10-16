/**
 * 审计日志查询。
 *
 *     GET /api/admin/audit?limit=100&action=user.ban&target_type=user
 *
 * 需要 `VIEW_AUDIT_LOG`（版主及以上）。
 *
 * 审计是要**给监管看**的东西，所以这里只读不写、不提供任何删除入口 ——
 * 一个能改审计日志的后台，等于没有审计日志。
 */
import type { NextRequest } from 'next/server'
import { PERM } from '@/lib/permissions'
import { requirePerm } from '@/lib/admin-auth'
import { listAuditActions, listAuditLogs } from '@/lib/admin-queries'
import { jsonResponse } from '@/lib/serialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const gate = await requirePerm(PERM.VIEW_AUDIT_LOG)
  if (gate.denied) return gate.denied

  const sp = req.nextUrl.searchParams
  const limitRaw = Number(sp.get('limit') ?? 100)
  const action = (sp.get('action') ?? '').slice(0, 64)
  const targetType = (sp.get('target_type') ?? '').slice(0, 32)

  const [logs, actions] = await Promise.all([
    listAuditLogs({
      limit: Number.isFinite(limitRaw) ? limitRaw : 100,
      action: action || undefined,
      targetType: targetType || undefined,
    }),
    listAuditActions(),
  ])

  return jsonResponse({ logs, actions })
}
