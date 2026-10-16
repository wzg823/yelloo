/**
 * 管理后台概览。
 *
 * 只回答一个问题：**现在有没有事需要我处理**。
 * 所以最显眼的是待处理举报数，其余都是背景信息。
 */
import Link from 'next/link'
import { getCurrentUser } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import {
  countOpenReports,
  listAuditActions,
  listChannelsForAdmin,
  listUsersForAdmin,
} from '@/lib/admin-queries'

export const dynamic = 'force-dynamic'

export default async function AdminOverviewPage() {
  const user = await getCurrentUser()
  if (!user) return null

  const canReports = hasPerm(user.perms, PERM.MANAGE_REPORT)
  const canUsers = hasPerm(user.perms, PERM.MUTE_MEMBER)
  const canChannels = hasPerm(user.perms, PERM.MANAGE_CHANNEL)

  const [openReports, usersStat, channels, actions] = await Promise.all([
    canReports ? countOpenReports() : Promise.resolve(0),
    canUsers ? listUsersForAdmin({ limit: 1 }) : Promise.resolve({ users: [], total: 0 }),
    canChannels ? listChannelsForAdmin() : Promise.resolve([]),
    hasPerm(user.perms, PERM.VIEW_AUDIT_LOG) ? listAuditActions() : Promise.resolve([]),
  ])

  const archived = channels.filter((c) => c.archived).length

  return (
    <>
      <h1 className="admin-h1">概览</h1>

      <div className="admin-stats">
        {canReports && (
          <Link href="/admin/reports" className={`admin-stat${openReports > 0 ? ' alert' : ''}`}>
            <div className="admin-stat-n">{openReports}</div>
            <div className="admin-stat-label">待处理举报</div>
          </Link>
        )}
        {canUsers && (
          <Link href="/admin/users" className="admin-stat">
            <div className="admin-stat-n">{usersStat.total}</div>
            <div className="admin-stat-label">注册用户</div>
          </Link>
        )}
        {canChannels && (
          <Link href="/admin/channels" className="admin-stat">
            <div className="admin-stat-n">
              {channels.length - archived}
              <span className="admin-stat-sub">/{channels.length}</span>
            </div>
            <div className="admin-stat-label">在用频道（含已归档）</div>
          </Link>
        )}
      </div>

      {openReports === 0 && canReports && (
        <p className="admin-muted">当前没有待处理的举报。</p>
      )}

      {actions.length > 0 && (
        <>
          <h2 className="admin-h2">最近的审计动作</h2>
          <div className="admin-chips">
            {actions.slice(0, 12).map((a) => (
              <Link key={a.action} href={`/admin/audit?action=${encodeURIComponent(a.action)}`} className="admin-chip">
                {a.action}
                <span className="admin-chip-n">{a.n}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="admin-h2">这一套能做什么</h2>
      <ul className="admin-list">
        {canReports && (
          <li>
            <strong>举报处置</strong>：看队列 → 判断 → 删消息 / 禁言 / 封禁 → 结案，全过程写审计。
          </li>
        )}
        {canUsers && (
          <li>
            <strong>用户处置</strong>：禁言（带时长）、封禁、改角色、改信任等级。
            封禁会让已登录的会话**当场失效**，不需要等 Cookie 过期。
          </li>
        )}
        {canChannels && (
          <li>
            <strong>频道管理</strong>：新建、改名/话题、归档。slug 不可改（它是对外 URL）。
          </li>
        )}
        <li className="admin-muted">
          所有写操作都会在服务端重新校验权限与等级关系 —— 页面上的按钮只是便利，
          不是防线。
        </li>
      </ul>
    </>
  )
}
