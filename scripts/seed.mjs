/**
 * 初始化数据。
 *
 * 用法：
 *     npm run db:migrate      # 先建表
 *     npm run db:seed         # 再灌数据
 *
 * 幂等：所有插入都用 onConflictDoNothing，可反复执行。
 *
 * ── 三条必须遵守的实现约束 ────────────────────────────────────────
 *
 * 1. **本文件是 .mjs，不能出现任何 TypeScript 语法。**
 *    曾在此处写过 `type: 'text' as const`，导致 `npm run db:seed` 直接
 *    SyntaxError 退出。种子数据已抽到 `seed-data.json`，改数据不用碰代码。
 *
 * 2. **所有 import 必须带显式扩展名（`.ts` / `.json`）。**
 *    Node 的类型擦除**不做扩展名解析**，`from './schema'` 会
 *    `ERR_MODULE_NOT_FOUND`。这是 Node 原生跑 TS 与 webpack/tsc 的关键差别。
 *
 * 3. **不要 import `src/db/index.ts`。**
 *    它对 `./schema` 用的是无扩展名导入（Next 能解析，Node 不能），
 *    因此脚本必须自建连接。顺带也让脚本对 Next 运行时零依赖。
 *
 * ── 关于外键的循环依赖 ───────────────────────────────────────────
 * 不需要在这里做 topological 排序：Drizzle 的 `references(() => x.id)`
 * 是惰性求值的，即使存在 users ↔ member_roles 这类互相引用，
 * 运行时也不会因为"表对象还没初始化"而报错。
 */
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { hash } from '@node-rs/argon2'

import * as schema from '../src/db/schema.ts'
import { ARGON2_OPTIONS } from '../src/lib/argon2-options.ts'
import { ALL_PERMS, BASE_MEMBER_PERMS, PERM } from '../src/lib/permissions.ts'
import {
  postgresConnectionConfig,
  postgresSsl,
  databaseHost,
} from '../src/lib/db-config.ts'
import seedData from './seed-data.json' with { type: 'json' }

const { Pool } = pg

/**
 * 内置角色。
 *
 * 名称即标识，改名前先确认代码里没有硬编码引用：
 * `src/lib/permissions.ts` 的 `permsForUserRole()` 是按 `users.role` 判定的，
 * 这里的 roles 表用于"额外授予角色"。
 */
const BUILTIN_ROLES = [
  { name: 'admin', permissions: ALL_PERMS, position: 100, assignable: false },
  {
    name: 'mod',
    permissions:
      BASE_MEMBER_PERMS |
      PERM.MANAGE_MESSAGE |
      PERM.MANAGE_REPORT |
      PERM.KICK_MEMBER |
      PERM.VIEW_AUDIT_LOG,
    position: 50,
    assignable: true,
  },
  { name: 'member', permissions: BASE_MEMBER_PERMS, position: 0, assignable: false },
]

let config
try {
  config = postgresConnectionConfig()
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

const pool = new Pool({
  ...config,
  max: 1,
  // SSL 决策统一由 db-config 负责（见该文件的说明：用主机名子串猜拓扑曾经出过 bug）
  ssl: postgresSsl(),
})

const db = drizzle(pool, { schema })

async function main() {
  console.log(`→ 目标数据库：${databaseHost() ?? '(未知主机)'}，SSL=${postgresSsl() ? 'on' : 'off'}`)
  console.log('→ 写入内置角色')
  for (const role of BUILTIN_ROLES) {
    await db.insert(schema.roles).values(role).onConflictDoNothing({ target: schema.roles.name })
  }

  console.log('→ 写入分类')
  for (const c of seedData.categories) {
    await db
      .insert(schema.categories)
      .values(c)
      .onConflictDoNothing({ target: schema.categories.slug })
  }

  console.log('→ 写入频道')
  const catRows = await db.select().from(schema.categories)
  const catBySlug = new Map(catRows.map((c) => [c.slug, c.id]))

  for (const ch of seedData.channels) {
    await db
      .insert(schema.channels)
      .values({
        slug: ch.slug,
        name: ch.name,
        type: ch.type,
        topic: ch.topic,
        position: ch.position,
        readOnly: ch.readOnly ?? false,
        categoryId: catBySlug.get(ch.category) ?? null,
      })
      .onConflictDoNothing({ target: schema.channels.slug })
  }

  // ── 首个管理员 ────────────────────────────────────────────────────
  // 通过环境变量提供，避免把弱口令写死在代码里。
  const adminEmail = process.env.SEED_ADMIN_EMAIL
  const adminPassword = process.env.SEED_ADMIN_PASSWORD
  const adminHandle = process.env.SEED_ADMIN_HANDLE ?? 'admin'

  if (!adminEmail || !adminPassword) {
    console.log('→ 未设置 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD，跳过管理员创建')
    console.log('  如需创建：写进 .env 后重新执行本脚本（幂等，不会重复插入）')
    return
  }

  if (adminPassword.length < 10) {
    throw new Error('SEED_ADMIN_PASSWORD 至少 10 位')
  }

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${adminEmail.toLowerCase()}`)
    .limit(1)

  if (existing.length > 0) {
    console.log(`→ 管理员已存在，跳过：${adminEmail}`)
    return
  }

  const passwordHash = await hash(adminPassword, ARGON2_OPTIONS)

  const inserted = await db
    .insert(schema.users)
    .values({
      handle: adminHandle,
      email: adminEmail.toLowerCase(),
      passwordHash,
      displayName: '站长',
      role: 'admin',
      trustLevel: 2,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id })

  const adminId = inserted[0].id
  const adminRole = await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, 'admin'))
    .limit(1)

  if (adminRole[0]) {
    await db
      .insert(schema.memberRoles)
      .values({ userId: adminId, roleId: adminRole[0].id })
      .onConflictDoNothing()
  }

  console.log(`→ 已创建管理员：${adminHandle} <${adminEmail}>`)
}

main()
  .then(() => {
    console.log('✓ 完成')
  })
  .catch((err) => {
    console.error('✗ 种子数据写入失败：', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
