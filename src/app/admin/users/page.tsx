/**
 * 用户管理。
 *
 * 权限：`MUTE_MEMBER`（版主及以上）。这是全站唯一成批展示邮箱的页面。
 *
 * 每行的"处置"按钮展开成一个小表单，动作按**当前账号实际拥有的能力**裁剪：
 * 版主看不到"封禁"和"修改角色"，因为服务端一定会拒 —— 与其让人点了才被
 * 拒绝，不如一开始就不显示。但真正拦住越权的是服务端，不是这里。
 */
import Link from 'next/link'
import { getCurrentUser } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { listUsersForAdmin } from '@/lib/admin-queries'
import { effectiveStatus, roleRank } from '@/lib/admin-policy'
import { UserActionForm } from '@/components/admin/AdminForms'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  active: '正常',
  muted: '禁言中',
  banned: '已封禁',
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const user = await getCurrentUser()
  if (!user) return null

  const { q } = await searchParams
  const query = (q ?? '').trim()
  const { users, total } = await listUsersForAdmin({ q: query, limit: 100 })

  const canMute = hasPerm(user.perms, PERM.MUTE_MEMBER)
  const canBan = hasPerm(user.perms, PERM.BAN_MEMBER)
  const canRole = hasPerm(user.perms, PERM.MANAGE_ROLE)

  return (
    <>
      <h1 className="admin-h1">用户</h1>

      <form className="admin-handle-row" action="/admin/users" method="get">
        <input
          className="admin-input grow"
          name="q"
          defaultValue={query}
          placeholder="按用户名或邮箱搜索"
        />
        <button type="submit" className="admin-btn primary">
          搜索
        </button>
        {query && (
          <Link href="/admin/users" className="admin-btn">
            清除
          </Link>
        )}
        <span className="admin-muted">
          共 {total} 个{query ? `匹配「${query}」的` : ''}账号，显示前 {users.length} 个
        </span>
      </form>

      <table className="admin-table">
        <thead>
          <tr>
            <th>用户</th>
            <th>邮箱</th>
            <th>角色</th>
            <th>状态</th>
            <th>信任</th>
            <th>发言</th>
            <th>注册</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const status = effectiveStatus(u)
            return (
              <tr key={u.id}>
                <td>
                  <Link href={`/u/${u.handle}`}>@{u.handle}</Link>
                  {u.displayName ? <span className="admin-muted"> {u.displayName}</span> : null}
                </td>
                <td className="admin-muted">{u.email}</td>
                <td>
                  <span className={`admin-tag role-${u.role}`}>{u.role}</span>
                </td>
                <td>
                  <span className={`admin-tag ${status}`}>{STATUS_LABEL[status] ?? status}</span>
                  {status === 'muted' && u.mutedUntil ? (
                    <div className="admin-muted">
                      至 {new Date(u.mutedUntil).toLocaleString('zh-CN')}
                    </div>
                  ) : null}
                </td>
                <td>{u.trustLevel}</td>
                <td>{u.messageCount}</td>
                <td className="admin-muted">
                  {new Date(u.createdAt).toLocaleDateString('zh-CN')}
                </td>
                <td>
                  <UserActionForm
                    userId={u.id}
                    status={status}
                    role={u.role}
                    trustLevel={u.trustLevel}
                    canMute={canMute}
                    canBan={canBan}
                    canRole={canRole}
                    // 自己：服务端会拒（self_target），这里也不给按钮
                    isSelf={u.id === user.id}
                  />
                  {/* 等级提示：点了才知道"不能处置同级"是最差的体验 */}
                  {roleRank(u.role) >= roleRank(user.role) && u.id !== user.id ? (
                    <div className="admin-muted">同级或更高，无法处置</div>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {users.length === 0 && <p className="admin-muted">没有匹配的账号。</p>}
    </>
  )
}
