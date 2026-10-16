/**
 * 迁移执行器。
 *
 * 用 drizzle-orm 的 migrate() 而不是 drizzle-kit CLI：
 * 前者可以在 CI/CD 里被程序调用，退出码可靠，也不会把 drizzle-kit
 * 带进生产镜像的依赖树。
 *
 * ★ 部署顺序 ★
 * 迁移必须在应用滚动更新**之前**执行完成。
 * 多实例同时启动时只有一个实例该跑迁移，否则并发执行 DDL 会互相阻塞甚至失败。
 * 单机部署下用 `docker compose run --rm migrate` 手动执行即可，天然满足这个约束。
 *
 * ★ 关于 SSL ★
 * 连接与 SSL 决策统一走 src/lib/db-config.ts。**不要在这里自己判断主机名**——
 * 曾经因为用 `includes('localhost')` 判断，导致 compose 内部连服务名 `postgres`
 * 时被误判为外部库而强制 SSL，迁移报 "The server does not support SSL connections"。
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { postgresConnectionConfig, postgresSsl, databaseHost } from '../src/lib/db-config.ts'

const { Pool } = pg

let config
try {
  config = postgresConnectionConfig()
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

const pool = new Pool({
  ...config,
  // 迁移是串行 DDL，单连接足够；多连接反而可能在并发 DDL 上互相等待
  max: 1,
  ssl: postgresSsl(),
})

console.log(`→ 目标数据库：${databaseHost() ?? '(未知主机)'}，SSL=${
  postgresSsl() ? 'on' : 'off'
}`)
console.log('→ 开始执行迁移…')

const db = drizzle(pool)

try {
  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('✓ 迁移完成')
} catch (err) {
  console.error('✗ 迁移失败：', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
