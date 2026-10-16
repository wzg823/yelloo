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
 *
 * ── 为什么这里是懒初始化（而不是模块级 new Pool）────────────────────
 *
 * 早期写法是模块级的 `export const pool = createPool()`，而 `createPool()`
 * 会调 `postgresConnectionConfig()` —— 那个函数在缺少 `DATABASE_URL` 时**抛异常**。
 * 于是"没配数据库"会在**模块被 import 的那一刻**炸掉，而不是在真正用数据库的时候。
 *
 * 后果是 `next build` 在没有 `.env` 的机器上直接失败：
 *
 *     Error: 数据库未配置。请设置 DATABASE_URL ...
 *     Failed to collect page data for /api/auth/login
 *
 * 报错指向的是 `/api/auth/login` 这种与数据库无关的路由，而真正的原因是
 * 构建期收集页面信息时把整张模块图都加载了一遍。这类"错误信息与真实原因
 * 无关"的故障最难查，所以改成：**import 不碰配置，用到才创建**。
 *
 * 运行时行为不变：第一次真正查询时仍会抛出那句清晰的配置错误。
 * 构建期不再加载配置，于是"无数据库也能构建"这条性质重新成立
 * （Docker 构建里写占位 .env 的做法因此也可以去掉了，但保留无害）。
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

let poolRef: Pool | null = globalForDb.__bbsPool ?? null
let dbRef: Db | null = null

/**
 * 取连接池，首次调用时创建。
 *
 * 不再以 `const pool` 的形式导出：把懒创建的东西伪装成一个常量，
 * 只会让人以为"import 就会建好"，从而又依赖起我们刚刚去掉的那个行为。
 * 需要它的地方（目前只有本文件）调这个函数即可。
 */
export function getPool(): Pool {
  if (poolRef) return poolRef

  const created = createPool()
  created.on('error', (err) => {
    // 空闲连接被服务端掐断时不要让进程崩溃
    console.error('[db] idle client error:', err.message)
  })

  // 生产环境刻意不写回 globalThis：单进程部署下没有热重载问题，
  // 而挂到 globalThis 会让连接池在测试/脚本里跨"重新加载"存活，反而更难清理
  if (process.env.NODE_ENV !== 'production') globalForDb.__bbsPool = created
  poolRef = created
  return created
}

export function getDb(): Db {
  if (!dbRef) dbRef = drizzle(getPool(), { schema })
  return dbRef
}

/**
 * 对外仍然是 `db`，用法完全不变（`db.select(...)` / `db.transaction(...)`）。
 *
 * 用 Proxy 把属性访问转发给懒创建的实例。方法必须 `bind(real)`：
 * drizzle 的方法内部会用 `this` 取自身的 client/session，
 * 直接返回未绑定的函数会拿到 Proxy 作为 `this` 而报错。
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>
    const value = real[prop]
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value
  },
})

export { schema }
