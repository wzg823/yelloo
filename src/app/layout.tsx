import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import './globals.css'
import { getCurrentUser } from '@/lib/session'
import { listChannels, type ChannelSummary } from '@/lib/queries'
import { safeQuery } from '@/lib/safe-query'
import { SessionProvider } from '@/lib/session-context'
import { THEME_COOKIE, htmlThemeAttribute } from '@/lib/theme'
import { AppShell } from '@/components/AppShell'
import { CodeEnhancer } from '@/components/CodeEnhancer'

export const metadata: Metadata = {
  title: {
    default: process.env.SITE_NAME ?? '技术社区',
    template: `%s · ${process.env.SITE_NAME ?? '技术社区'}`,
  },
  description: '一个面向中文开发者的公开技术社区：讨论、问答与作品分享。',
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    siteName: process.env.SITE_NAME ?? '技术社区',
    locale: 'zh_CN',
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  // 与两套配色对应：浏览器 UI（地址栏、状态栏）跟着系统走，
  // 显式选了主题则由 <html data-theme> 决定实际配色
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f5' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1b1e' },
  ],
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1,
}

type Nav = {
  categories: { id: number; name: string; slug: string; description: string | null }[]
  channels: ChannelSummary[]
}

const EMPTY_NAV: Nav = { categories: [], channels: [] }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // 两个查询都做了容错：构建期无数据库、运行期数据库抖动时，
  // 侧栏降级为空，而不是让整站白屏或让构建失败。原因详见 safe-query.ts
  // ⚠️ 顺序有依赖：未读数需要 userId，因此必须先拿到用户再查频道。
  // getCurrentUser 的容错仍要保留：构建期无数据库时它返回 null，
  // 页面照常渲染（侧栏为空），整站不会白屏。原因详见 safe-query.ts
  const user = await safeQuery(() => getCurrentUser(), null, 'getCurrentUser')

  const nav = await safeQuery(
    () => listChannels(user?.id ?? null),
    EMPTY_NAV,
    'listChannels',
  )

  // ★ 主题必须在服务端读出来写进 <html>，否则首帧会闪白 ★
  //
  // cookies() 在构建期不可用（静态生成时），与 getCurrentUser 一样需要容错：
  // 读不到就当"用户没选过"，让 CSS 按系统偏好走。
  let themeAttr: 'light' | 'dark' | undefined
  try {
    const store = await cookies()
    themeAttr = htmlThemeAttribute(store.get(THEME_COOKIE)?.value)
  } catch {
    themeAttr = undefined
  }

  return (
    <html lang="zh-CN" data-theme={themeAttr}>
      <body>
        <SessionProvider
          user={
            user
              ? {
                  id: user.id,
                  handle: user.handle,
                  displayName: user.displayName,
                  avatarUrl: user.avatarUrl,
                  role: user.role,
                }
              : null
          }
        >
          <AppShell categories={nav.categories} channels={nav.channels}>
            {children}
          </AppShell>
          {/* 全站一个实例，用 MutationObserver 给所有代码块挂"复制"按钮 */}
          <CodeEnhancer />
        </SessionProvider>
      </body>
    </html>
  )
}
