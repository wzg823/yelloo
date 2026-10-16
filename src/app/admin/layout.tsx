/**
 * 管理后台外壳。
 *
 * ── 两道门 ──────────────────────────────────────────────────────────
 * 1. **未登录** → 跳登录页
 * 2. **登录了但不是管理/版主** → `notFound()`
 *
 * 第二道刻意用 404 而不是 403：403 等于告诉试探者"这里有个后台，只是你没权限"。
 * 404 什么信息都不给。
 *
 * ⚠️ 这一层只是**页面级**的门。每个写接口都在服务端重新判权限 ——
 * 绕过前端直接打 API 是最基本的攻击手法，页面守卫对它毫无作用。
 */
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { countOpenReports } from '@/lib/admin-queries'

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canReports = hasPerm(user.perms, PERM.MANAGE_REPORT)
  const canUsers = hasPerm(user.perms, PERM.MUTE_MEMBER)
  const canChannels = hasPerm(user.perms, PERM.MANAGE_CHANNEL)
  const canAudit = hasPerm(user.perms, PERM.VIEW_AUDIT_LOG)

  // 一个权限都没有 → 当作不存在
  if (!canReports && !canUsers && !canChannels && !canAudit) notFound()

  const openReports = canReports ? await countOpenReports() : 0

  const nav = [
    { href: '/admin', label: '概览', show: true },
    { href: '/admin/reports', label: '举报', show: canReports, badge: openReports },
    { href: '/admin/users', label: '用户', show: canUsers },
    { href: '/admin/channels', label: '频道', show: canChannels },
    { href: '/admin/audit', label: '审计', show: canAudit },
  ].filter((n) => n.show)

  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="admin-nav-title">管理后台</div>
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className="admin-nav-link">
            {item.label}
            {item.badge ? <span className="admin-badge">{item.badge}</span> : null}
          </Link>
        ))}
        <div className="admin-nav-foot">
          <Link href="/" className="admin-nav-link">
            ← 回到社区
          </Link>
          <div className="admin-muted">
            {user.handle} · {user.role}
          </div>
        </div>
      </nav>
      <main className="admin-main">{children}</main>
    </div>
  )
}
