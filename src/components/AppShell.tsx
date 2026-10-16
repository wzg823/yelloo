'use client'

/**
 * 应用外壳：左侧频道导航 + 内容区。
 *
 * 做成客户端组件的原因是它需要 usePathname 判断高亮频道。
 * 数据仍由服务端 layout 查询后作为 props 传入——不在客户端发额外请求。
 *
 * ── 未读红点的刷新机制 ──────────────────────────────────────────
 * 服务端首屏已经算好未读数（走 props）。运行时的变化有两条来源：
 *   1. ChannelStream 收到实时消息 / 推进已读位点后 dispatch 一个自定义事件
 *   2. 浏览器标签页重新可见时（用户从别的窗口切回来）
 * 两者都触发一次 `/api/unread` 拉取，而不是整页刷新 ——
 * 整页刷新会丢失正在阅读的滚动位置，这在长频道里非常恼人。
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from '@/lib/session-context'
import { avatarHue, initials } from '@/lib/format'
import { logoutAction } from '@/app/(auth)/actions'
import type { ChannelSummary } from '@/lib/queries'

type Category = { id: number; name: string; slug: string; description: string | null }

const TYPE_PREFIX: Record<string, string> = {
  text: '#',
  forum: '▤',
  announce: '📢',
  thread: '↳',
}

/** 红点最多显示到 99+，避免宽度被撑开 */
function formatBadge(n: number): string {
  return n > 99 ? '99+' : String(n)
}

export function AppShell({
  categories,
  channels,
  children,
}: {
  categories: Category[]
  channels: ChannelSummary[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const user = useSession()

  // 初始值来自服务端渲染，避免首屏红点闪一下才出现
  const [unread, setUnread] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {}
    for (const c of channels) if (c.unread > 0) init[c.id] = c.unread
    return init
  })

  const refreshUnread = useCallback(async () => {
    if (!user) return
    try {
      const res = await fetch('/api/unread', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { unread: Record<string, number> }
      const next: Record<number, number> = {}
      for (const [k, v] of Object.entries(data.unread ?? {})) {
        const id = Number(k)
        if (Number.isFinite(id) && v > 0) next[id] = v
      }
      setUnread(next)
    } catch {
      // 红点不准确不应打断阅读，静默失败
    }
  }, [user])

  useEffect(() => {
    const onCustom = () => void refreshUnread()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshUnread()
    }

    window.addEventListener('bbs:refresh-unread', onCustom)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('bbs:refresh-unread', onCustom)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshUnread])

  // 切换频道后立刻重算：刚进入的频道其未读应归零
  useEffect(() => {
    if (!user) return
    const t = setTimeout(() => void refreshUnread(), 400)
    return () => clearTimeout(t)
  }, [pathname, user, refreshUnread])

  const byCategory = new Map<number | null, ChannelSummary[]>()
  for (const ch of channels) {
    const list = byCategory.get(ch.categoryId) ?? []
    list.push(ch)
    byCategory.set(ch.categoryId, list)
  }

  const uncategorized = byCategory.get(null) ?? []

  const renderChannel = (ch: ChannelSummary) => {
    const href = `/c/${ch.slug}`
    const active = pathname === href || pathname.startsWith(`${href}/`)
    const count = unread[ch.id] ?? 0

    return (
      <Link
        key={ch.id}
        href={href}
        className={`chan-link${active ? ' is-active' : ''}`}
        title={ch.topic ?? ch.name}
      >
        <span className="chan-prefix">{TYPE_PREFIX[ch.type] ?? '#'}</span>
        <span className="chan-name">{ch.name}</span>
        {/* 未聚焦的频道才显示红点：正在看的频道不该提示"你有未读" */}
        {!active && count > 0 && (
          <span className="chan-badge" title={`${count} 条未读`}>
            {formatBadge(count)}
          </span>
        )}
      </Link>
    )
  }

  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0)

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-header">
          <Link href="/" className="sidebar-title" style={{ color: 'inherit' }}>
            {/* 客户端组件读不到非 NEXT_PUBLIC_ 前缀的服务端变量，
                因此这里必须用 NEXT_PUBLIC_SITE_NAME（与 layout.tsx 的 metadata 分开配置） */}
            {process.env.NEXT_PUBLIC_SITE_NAME ?? '技术社区'}
          </Link>
          {totalUnread > 0 && (
            <span className="sidebar-unread-total" title={`${totalUnread} 条未读`}>
              {formatBadge(totalUnread)}
            </span>
          )}
        </div>

        <div className="sidebar-scroll">
          {categories.map((cat) => {
            const list = byCategory.get(cat.id) ?? []
            if (list.length === 0) return null
            return (
              <div key={cat.id}>
                <div className="cat-label">{cat.name}</div>
                {list.map(renderChannel)}
              </div>
            )
          })}

          {uncategorized.length > 0 && (
            <div>
              <div className="cat-label">其他</div>
              {uncategorized.map(renderChannel)}
            </div>
          )}

          {channels.length === 0 && (
            <p style={{ padding: '8px', fontSize: 13, color: 'var(--text-muted)' }}>
              还没有频道。执行 <code>npm run db:seed</code> 初始化数据。
            </p>
          )}

          <div style={{ padding: '14px 8px 0' }}>
            <Link href="/search" className="chan-link">
              <span className="chan-prefix">⌕</span>
              <span className="chan-name">搜索</span>
            </Link>
          </div>
        </div>

        <div className="sidebar-footer">
          {user ? (
            <>
              <div className="user-chip">
                <div
                  className="avatar"
                  style={{
                    width: 30,
                    height: 30,
                    fontSize: 12,
                    background: `hsl(${avatarHue(user.id)} 45% 42%)`,
                  }}
                >
                  {user.avatarUrl ? (
                    // 用户头像来自外部 URL，用原生 img 以避免配置 next/image 远程域名
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={user.avatarUrl} alt="" />
                  ) : (
                    initials(user.displayName ?? user.handle)
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="name">{user.displayName ?? user.handle}</div>
                  <div className="role">
                    {user.role === 'admin' ? '管理员' : user.role === 'mod' ? '版主' : '成员'}
                  </div>
                </div>
              </div>
              <form action={logoutAction}>
                <button type="submit" className="icon-btn" title="退出登录">
                  退出
                </button>
              </form>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <Link href="/login" className="btn btn-ghost" style={{ flex: 1, textAlign: 'center' }}>
                登录
              </Link>
              <Link href="/register" className="btn btn-primary" style={{ flex: 1, textAlign: 'center' }}>
                注册
              </Link>
            </div>
          )}
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  )
}
