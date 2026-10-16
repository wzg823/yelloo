import type { MetadataRoute } from 'next'

/**
 * robots.txt。
 *
 * 公开技术社区的默认姿态是"欢迎收录"——自然流量是主要获客渠道。
 * 只排除两类：
 *   - /api/       接口无索引价值，且会浪费爬虫配额
 *   - 登录注册     无内容且会稀释权重
 *
 * 消息永久链接 /m/[id] **必须允许**：技术社区的长尾流量主要来自
 * "某个具体问题的回答"被搜到。已删除的消息由页面自身的
 * `robots: { index: false }` 元数据单独排除，不需要在这里一刀切。
 */
export default function robots(): MetadataRoute.Robots {
  const site = process.env.SITE_URL ?? 'http://localhost:3000'

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/login', '/register', '/admin'],
      },
    ],
    sitemap: `${site}/sitemap.xml`,
    host: site,
  }
}
