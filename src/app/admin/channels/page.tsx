/**
 * 频道管理（仅管理员 · `MANAGE_CHANNEL`）。
 *
 * ── 为什么这里没有"删除频道"按钮 ────────────────────────────────────
 * 频道一旦有消息就有历史价值，而且外键是 `onDelete: cascade` —— 物理删除
 * 会连带删掉该频道下的**所有**消息、附件记录与修订历史，不可恢复。
 * 所以正确的动作是**归档**：从侧栏消失、不能再发帖，但内容仍可访问、
 * 仍可被搜索引擎收录。想"删掉"一个频道，就先想想那些内容该不该留。
 */
import Link from 'next/link'
import { getCurrentUser } from '@/lib/session'
import { PERM, hasPerm } from '@/lib/permissions'
import { listCategories, listChannelsForAdmin } from '@/lib/admin-queries'
import { ActionButton, ChannelCreateForm, ChannelEditForm } from '@/components/admin/AdminForms'

export const dynamic = 'force-dynamic'

const TYPE_LABEL: Record<string, string> = {
  text: 'text',
  forum: 'forum',
  announce: 'announce',
  thread: 'thread',
}

export default async function AdminChannelsPage() {
  const user = await getCurrentUser()
  if (!user) return null
  if (!hasPerm(user.perms, PERM.MANAGE_CHANNEL)) {
    return <p className="admin-muted">只有管理员可以管理频道。</p>
  }

  const [channels, categories] = await Promise.all([listChannelsForAdmin(), listCategories()])

  return (
    <>
      <h1 className="admin-h1">频道</h1>

      <div className="admin-handle-row">
        <ChannelCreateForm categories={categories} />
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>频道</th>
            <th>slug</th>
            <th>类型</th>
            <th>分类</th>
            <th>排序</th>
            <th>消息</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => (
            <tr key={c.id} className={c.archived ? 'is-archived' : ''}>
              <td>
                <Link href={`/c/${c.slug}`}>{c.name}</Link>
                {c.topic ? <div className="admin-muted">{c.topic}</div> : null}
              </td>
              <td className="admin-muted">{c.slug}</td>
              <td>
                <span className="admin-tag">{TYPE_LABEL[c.type] ?? c.type}</span>
                {c.readOnly ? <span className="admin-tag">只读</span> : null}
              </td>
              <td className="admin-muted">{c.categoryName ?? '—'}</td>
              <td>{c.position}</td>
              <td>{c.messageCount}</td>
              <td>
                {c.archived ? (
                  <span className="admin-tag dismissed">已归档</span>
                ) : (
                  <span className="admin-tag active">在用</span>
                )}
              </td>
              <td>
                <span className="admin-inline">
                  <ChannelEditForm
                    channelId={c.id}
                    name={c.name}
                    topic={c.topic}
                    type={c.type}
                  />
                  <ActionButton
                    path={`/api/admin/channels/${c.id}`}
                    method="PATCH"
                    body={{ archived: !c.archived }}
                  >
                    {c.archived ? '取消归档' : '归档'}
                  </ActionButton>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="admin-muted">
        归档的频道不会出现在侧栏，也不能再发帖，但历史内容仍可访问。
        本站不提供删除频道 —— 那会级联删掉该频道的全部消息。
      </p>
    </>
  )
}
