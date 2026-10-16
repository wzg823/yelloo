/**
 * 数据库连接参数与 SSL 决策 —— 单一来源。
 *
 * ── 为什么要单独抽出来 ────────────────────────────────────────────
 * "该不该启用 SSL" 这个判断原先在 3 个地方各写了一遍
 * （`src/db/index.ts`、`scripts/migrate.mjs`、`scripts/seed.mjs`），
 * 而且判断方式是 `connectionString.includes('localhost')`。
 *
 * 这在 compose 里必然出错：容器之间连的是**服务名 `postgres`**，不是 localhost，
 * 于是 `postgres://bbs:pw@postgres:5432/bbs` 被误判为"远程外部库" → 强制 SSL
 * → 而容器内的 Postgres 默认不支持 SSL → 迁移直接失败：
 *
 *     Error: The server does not support SSL connections
 *
 * 教训：**用主机名子串猜网络拓扑是不可靠的**。这里改为显式规则：
 *   1. 有 `DATABASE_SSL` 环境变量 → 以它为准（部署时的最终开关）
 *   2. PGHOST / DATABASE_URL 的主机是已知的内网名（localhost/127.0.0.1/postgres/...）
 *      → 关闭 SSL
 *   3. 其余（真实域名或公网 IP，通常是云数据库）→ 启用 SSL
 */

/** Docker Compose 内部服务名与常见的容器内网主机名 */
const INTERNAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'db',
  'database',
  'host.docker.internal',
])

/** `DATABASE_SSL` 的三种取值：true / false / 未设置 */
function sslOverride(): boolean | null {
  const raw = process.env.DATABASE_SSL?.trim().toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  return null
}

/** 从 DATABASE_URL 里取出主机名；解析失败返回 null */
function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    // 用 URL 解析而不是正则：要正确处理用户名密码里的特殊字符与 IPv6 方括号
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** 当前要连接的主机名（优先 DATABASE_URL，其次 PGHOST） */
export function databaseHost(): string | null {
  return hostFromUrl(process.env.DATABASE_URL) ?? process.env.PGHOST ?? null
}

/** 是否启用 SSL。返回原始值而不是 pg 的配置对象，便于脚本与 Next 复用 */
export function databaseSslEnabled(): boolean {
  const override = sslOverride()
  if (override !== null) return override

  const host = databaseHost()
  if (!host) return false
  return !INTERNAL_HOSTS.has(host.toLowerCase())
}

/**
 * pg 的 `ssl` 配置项。
 *
 * 注意 `rejectUnauthorized: true` 是刻意的：云数据库若使用自签证书，
 * 应该把 CA 显式配好，而不是关掉校验——关掉就等于放弃了防中间人攻击。
 */
export function postgresSsl(): { rejectUnauthorized: boolean } | undefined {
  return databaseSslEnabled() ? { rejectUnauthorized: true } : undefined
}

/**
 * 构造连接配置。
 *
 * 同时支持两种写法：
 *   - `DATABASE_URL`（单串，常见于 SaaS 数据库）
 *   - `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`（分开给，常见于自建与容器编排）
 * 分开给时若 DATABASE_URL 存在则后者优先，避免两个来源互相矛盾。
 */
export function postgresConnectionConfig(): {
  connectionString?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
} {
  const url = process.env.DATABASE_URL?.trim()
  if (url) return { connectionString: url }

  const host = process.env.PGHOST
  if (!host) {
    throw new Error(
      '数据库未配置。请设置 DATABASE_URL，或设置 PGHOST/PGUSER/PGPASSWORD/PGDATABASE。参考 .env.example',
    )
  }

  return {
    host,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  }
}
