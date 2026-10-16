/**
 * 数据库连接池。
 *
 * 单例挂到 globalThis：Next.js dev 模式热重载会重新执行模块，
 * 不这样做会不断新建连接池直到 Postgres 拒绝连接。
 *
 * ⚠️ 本模块属于"Next 打包层"，**scripts/ 下的脚本不要 import 它**。
 * 它对 `./schema` 使用无扩展名导入（Next/webpack 能解析），
 * 而 Node 的类型擦除不做扩展名解析，脚本间接引入它会 ERR_MODULE_NOT_FOUND。
 * 脚本请用 `src/lib/db-config.ts` 自建连接，见 scripts/seed.mjs。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'
import { postgresConnectionConfig, postgresSsl } from '@/lib/db-config'

export type Db = NodePgDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** 既能接连接池、也能接事务的宽类型 */
export type DbLike = Db | Tx

function createPool(): Pool {
  const config = postgresConnectionConfig()

  return new Pool({
    ...config,
    // 单机部署下 Postgres 默认 max_connections=100。
    // 应用池 × 实例数 + 迁移/定时任务 必须留出余量。
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // SSL 决策统一由 db-config 负责，不要在这里再写一遍主机名判断
    ssl: postgresSsl(),
  })
}

const globalForDb = globalThis as unknown as { __bbsPool?: Pool }

export const pool: Pool = globalForDb.__bbsPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalForDb.__bbsPool = pool

pool.on('error', (err) => {
  // 空闲连接被服务端掐断时不要让进程崩溃
  console.error('[db] idle client error:', err.message)
})

export const db: Db = drizzle(pool, { schema })

export { schema }
