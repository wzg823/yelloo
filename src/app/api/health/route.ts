/**
 * 健康检查与运行时自检。
 *
 * 供容器 HEALTHCHECK、负载均衡器与外部监控（如 Uptime Kuma）使用。
 *
 * 刻意返回 503 而不是 200 当数据库不可用时：负载均衡器需要据此把实例摘掉。
 * 若恒返回 200，一个连不上库的实例会持续接收流量，表现为全站 500。
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { hubStats } from '@/lib/realtime/hub'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Check = { ok: boolean; detail?: string; ms?: number }

export async function GET() {
  const started = Date.now()

  let database: Check
  const dbStart = Date.now()
  try {
    await db.execute(sql`select 1`)
    database = { ok: true, ms: Date.now() - dbStart }
  } catch (err) {
    database = {
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
      ms: Date.now() - dbStart,
    }
  }

  const stats = hubStats()

  const body = {
    status: database.ok ? 'ok' : 'degraded',
    uptime_s: Math.round(process.uptime()),
    version: process.env.APP_VERSION ?? 'dev',
    checks: { database },
    realtime: stats,
    took_ms: Date.now() - started,
  }

  return new Response(JSON.stringify(body, null, 2), {
    status: database.ok ? 200 : 503,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
