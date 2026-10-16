/**
 * 举报队列。
 *
 * 每条举报都要能让审核**当场做判断**，所以卡片里必须同时有：
 *   · 举报理由（举报人写了什么）
 *   · 被举报内容本身（不是链接，是正文）
 *   · 是谁发的、在哪个频道
 *   · 已删除时的**删除前版本**（否则就是对着墓碑做判断）
 *
 * 权限：`MANAGE_REPORT`。
 */
import Link from 'next/link'
import { getCurrentUser } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { listReports } from '@/lib/admin-queries'
import { ReportHandleForm } from '@/components/admin/AdminForms'
import { excerpt } from '@/lib/admin-policy'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  resolved: '已处理',
  dismissed: '已驳回',
}

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const user = await getCurrentUser()
  if (!user) return null

  const { status: statusRaw } = await searchParams
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(statusRaw ?? '')
    ? (statusRaw as string)
    : 'open'

  const reports = await listReports({ status, limit: 100 })

  const canDeleteMessage = hasPerm(user.perms, PERM.MANAGE_MESSAGE)
  const canMute = hasPerm(user.perms, PERM.MUTE_MEMBER)
  const canBan = hasPerm(user.perms, PERM.BAN_MEMBER)

  const tabs = [
    ['open', '待处理'],
    ['resolved', '已处理'],
    ['dismissed', '已驳回'],
    ['all', '全部'],
  ] as const

  return (
    <>
      <h1 className="admin-h1">举报队列</h1>

      <div className="admin-tabs">
        {tabs.map(([value, label]) => (
          <Link
            key={value}
            href={`/admin/reports?status=${value}`}
            className={`admin-tab${status === value ? ' active' : ''}`}
          >
            {label}
          </Link>
        ))}
      </div>

      {reports.length === 0 && <p className="admin-muted">这个筛选条件下没有举报。</p>}

      <div className="admin-cards">
        {reports.map((r) => {
          const targetLabel = r.message
            ? `消息作者 @${r.message.authorHandle ?? '已注销'}`
            : r.targetUser
              ? `用户 @${r.targetUser.handle}`
              : null

          return (
            <div key={r.id} className="admin-card">
              <div className="admin-card-head">
                <span className={`admin-tag ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                <span className="admin-muted">
                  #{r.id} · {r.targetType === 'message' ? '消息举报' : '用户举报'} ·{' '}
                  {new Date(r.createdAt).toLocaleString('zh-CN')}
                </span>
                <span className="admin-muted" style={{ marginLeft: 'auto' }}>
                  举报人 @{r.reporter.handle ?? '已注销'}
                </span>
              </div>

              <div className="admin-quote">
                <div className="admin-quote-label">举报理由</div>
                {r.reason}
              </div>

              {r.message && (
                <div className="admin-quote">
                  <div className="admin-quote-label">
                    被举报内容
                    {r.message.channelSlug && (
                      <>
                        {' · '}
                        <Link href={`/c/${r.message.channelSlug}#m${r.message.id}`}>
                          #{r.message.channelSlug}
                        </Link>
                      </>
                    )}
                    {' · '}
                    <Link href={`/m/${r.message.id}`}>永久链接</Link>
                  </div>
                  {r.message.isDeleted ? (
                    <>
                      <div className="admin-muted">（该消息已被删除）</div>
                      {r.message.deletedRevision ? (
                        <div className="admin-deleted-rev">
                          删除前的内容：{excerpt(r.message.deletedRevision, 300)}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    excerpt(r.message.content ?? '', 300)
                  )}
                </div>
              )}

              {r.targetUser && (
                <div className="admin-quote">
                  <div className="admin-quote-label">被举报用户</div>
                  @{r.targetUser.handle} · 状态 {r.targetUser.status}
                </div>
              )}

              {r.status === 'open' ? (
                <ReportHandleForm
                  reportId={r.id}
                  canDeleteMessage={canDeleteMessage}
                  canMute={canMute}
                  canBan={canBan}
                  targetLabel={targetLabel}
                />
              ) : (
                <div className="admin-muted">
                  由 @{r.handledBy?.handle ?? '未知'} 于{' '}
                  {r.handledAt ? new Date(r.handledAt).toLocaleString('zh-CN') : '—'} 处理
                  {r.resolutionNote ? `：${r.resolutionNote}` : ''}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
