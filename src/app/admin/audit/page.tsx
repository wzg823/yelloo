/**
 * 审计日志（`VIEW_AUDIT_LOG`，版主及以上）。
 *
 * 只读，且**不提供任何删除/修改入口** —— 一个能改审计日志的后台
 * 等于没有审计日志。这是给监管与事后复盘看的，不是日常运维界面。
 */
import Link from 'next/link'
import { getCurrentUser } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { listAuditActions, listAuditLogs } from '@/lib/admin-queries'

export const dynamic = 'force-dynamic'

/** 动作词表 → 人话。未列出的动作直接显示原始词条（受控词表本身就是可读的） */
const ACTION_LABEL: Record<string, string> = {
  'user.register': '注册',
  'user.login': '登录',
  'user.logout': '登出',
  'user.ban': '封禁用户',
  'user.unban': '解封用户',
  'user.mute': '禁言用户',
  'user.unmute': '解除禁言',
  'user.role_grant': '授予角色',
  'user.role_revoke': '降级角色',
  'user.trust_set': '调整信任等级',
  'message.create': '发消息',
  'message.edit': '编辑消息',
  'message.delete': '删除消息',
  'message.restore': '恢复消息',
  'channel.create': '新建频道',
  'channel.update': '修改频道',
  'channel.archive': '归档频道',
  'report.create': '提交举报',
  'report.resolve': '处理举报',
  'report.dismiss': '驳回举报',
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; target_type?: string }>
}) {
  const user = await getCurrentUser()
  if (!user) return null
  if (!hasPerm(user.perms, PERM.VIEW_AUDIT_LOG)) {
    return <p className="admin-muted">你没有查看审计日志的权限。</p>
  }

  const sp = await searchParams
  const action = (sp.action ?? '').trim()
  const targetType = (sp.target_type ?? '').trim()

  const [logs, actions] = await Promise.all([
    listAuditLogs({ limit: 200, action: action || undefined, targetType: targetType || undefined }),
    listAuditActions(),
  ])

  return (
    <>
      <h1 className="admin-h1">审计日志</h1>

      <div className="admin-chips">
        <Link href="/admin/audit" className={`admin-chip${!action ? ' active' : ''}`}>
          全部
        </Link>
        {actions.slice(0, 20).map((a) => (
          <Link
            key={a.action}
            href={`/admin/audit?action=${encodeURIComponent(a.action)}`}
            className={`admin-chip${action === a.action ? ' active' : ''}`}
          >
            {ACTION_LABEL[a.action] ?? a.action}
            <span className="admin-chip-n">{a.n}</span>
          </Link>
        ))}
      </div>

      {targetType && (
        <p className="admin-muted">
          按 target_type={targetType} 过滤 · <Link href="/admin/audit">清除</Link>
        </p>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>动作</th>
            <th>经办人</th>
            <th>对象</th>
            <th>详情</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="admin-muted">
                {new Date(l.createdAt).toLocaleString('zh-CN')}
              </td>
              <td>
                <span className="admin-tag">{ACTION_LABEL[l.action] ?? l.action}</span>
              </td>
              <td>{l.actor?.handle ? `@${l.actor.handle}` : <span className="admin-muted">系统</span>}</td>
              <td className="admin-muted">
                {l.targetType}#{l.targetId}
              </td>
              <td className="admin-meta">
                {l.meta ? <code>{JSON.stringify(l.meta)}</code> : <span className="admin-muted">—</span>}
              </td>
              <td className="admin-muted">{l.ip ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {logs.length === 0 && <p className="admin-muted">没有符合条件的记录。</p>}

      <p className="admin-muted">
        显示最近 {logs.length} 条。审计日志只读 —— 这个界面没有任何删除或修改入口。
      </p>
    </>
  )
}
