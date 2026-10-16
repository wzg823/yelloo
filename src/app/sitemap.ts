import type { MetadataRoute } from 'next'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { channels, messages } from '@/db/schema'

/**
 * 站点地图。
 *
 * 收录范围优先级：
 *   1. 首页与频道页 —— 必须收录
 *   2. 频道历史分页（?before=）—— 让老内容也能被发现，只取前若干页避免 sitemap 爆炸
 *   3. 消息永久链接 —— 长尾流量主力，只取最近 N 条（搜索引擎会自行深入抓取）
 *
 * 规模提醒：单个 sitemap 上限 50,000 条 URL。超过后必须拆分并在
 * sitemap index 中引用，否则会被判为无效。
 *
 * force-dynamic：sitemap 默认在构建期生成，而构建环境没有数据库。
 * 改为按请求生成后，搜索引擎每次抓取都会拿到最新的 URL 列表。
 * 代价是每次抓取一次全表扫描 + limit 查询——对论坛的数据量而言可以忽略。
 */
export const dynamic = 'force-dynamic'

const SITE = process.env.SITE_URL ?? 'http://localhost:3000'
/** 全局最多列出多少条消息永久链接 */
const MAX_MESSAGE_URLS = 5000

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  const entries: MetadataRoute.Sitemap = [
    {
      url: `${SITE}/`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 1,
    },
  ]

  const channelRows = await db
    .select({
      slug: channels.slug,
      lastMessageAt: channels.lastMessageAt,
    })
    .from(channels)
    .where(eq(channels.archived, false))

  for (const ch of channelRows) {
    entries.push({
      url: `${SITE}/c/${ch.slug}`,
      lastModified: ch.lastMessageAt ?? now,
      changeFrequency: 'hourly',
      priority: 0.8,
    })

    // 历史分页 URL 需要具体的 before 游标才能打开，而 sitemap 生成时逐个
    // 计算游标代价过高。因此分页通过频道页上的 rel="prev" 暴露给爬虫
    // （见 src/app/c/[slug]/page.tsx）。这里不写无效链接——
    // 无效 URL 会降低整份 sitemap 的可信度，得不偿失。
  }

  const recent = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.isDeleted, false))
    .orderBy(desc(messages.id))
    .limit(MAX_MESSAGE_URLS)

  for (const m of recent) {
    entries.push({
      url: `${SITE}/m/${m.id}`,
      lastModified: m.createdAt,
      changeFrequency: 'monthly',
      priority: 0.5,
    })
  }

  return entries
}
