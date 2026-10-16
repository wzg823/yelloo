/**
 * 提升指定用户为版主或管理员（仅供本地验证使用）。
 *
 * 用法：
 *     DATABASE_URL=postgres://... node scripts/promote.mjs <handle> [mod|admin]
 *
 * 为什么需要它：注册接口创建的用户固定是 `member`。
 * 而管理类能力（删消息、处理举报、看审计日志）需要 mod 及以上角色，
 * 没有这个脚本就只能手写 SQL 去改 role——那既容易写错，也不便于复现。
 *
 * 它同时更新两处，缺一不可：
 *   1. `users.role`         —— 决定 `permsForUserRole()` 给出的内置权限档位
 *   2. `member_roles` 关联   —— 决定"额外授予的角色权限"聚合
 *
 * 约束：本文件是 .mjs，不能出现 TypeScript 语法；所有 import 必须带扩展名
 * （Node 的类型擦除不做扩展名解析）。理由详见 scripts/seed.mjs 的注释。
 */
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '../src/db/schema.ts'
import { postgresConnectionConfig, postgresSsl, databaseHost } from '../src/lib/db-config.ts'

const { Pool } = pg

const handle = process.argv[2]
const targetRole = (process.argv[3] ?? 'mod').toLowerCase()

if (!handle) {
  console.error('用法: node scripts/promote.mjs <handle> [mod|admin]')
  process.exit(2)
}
if (targetRole !== 'mod' && targetRole !== 'admin') {
  console.error(`✗ 角色只能是 mod 或 admin，收到：${targetRole}`)
  process.exit(2)
}

let config
try {
  config = postgresConnectionConfig()
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

const pool = new Pool({ ...config, max: 1, ssl: postgresSsl() })
const db = drizzle(pool, { schema })

async function main() {
  console.log(`→ 目标数据库：${databaseHost() ?? '(未知)'}，SSL=${postgresSsl() ? 'on' : 'off'}`)

  const found = await db
    .select({ id: schema.users.id, handle: schema.users.handle, role: schema.users.role })
    .from(schema.users)
    .where(sql`lower(${schema.users.handle}) = ${handle.toLowerCase()}`)
    .limit(1)

  const user = found[0]
  if (!user) {
    throw new Error(`找不到用户 ${handle}。先通过注册接口创建它。`)
  }

  await db.update(schema.users).set({ role: targetRole }).where(eq(schema.users.id, user.id))

  const roleRow = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, targetRole))
    .limit(1)

  if (!roleRow[0]) {
    throw new Error(
      `roles 表里没有 '${targetRole}'。先执行 npm run db:seed 写入内置角色。`,
    )
  }

  await db
    .insert(schema.memberRoles)
    .values({ userId: user.id, roleId: roleRow[0].id })
    .onConflictDoNothing()

  console.log(`✓ ${user.handle}：${user.role} → ${targetRole}`)
  console.log('  该用户需要重新登录才会拿到新权限（会话缓存了权限位）。')
}

main()
  .catch((err) => {
    console.error('✗ 失败：', err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
