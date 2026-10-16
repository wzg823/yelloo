/**
 * 重置某个用户的密码（运维用）。
 *
 * 用法：
 *     NEW_PASSWORD='<新口令>' node scripts/set-password.mjs <handle>
 *     node scripts/set-password.mjs <handle> '<新口令>'      # 见下方警告
 *     node scripts/set-password.mjs --list                   # 列出候选账号
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 面向用户的自助"忘记密码"需要邮件通道（P2 未完成）。在邮件打通之前，
 * 这条命令就是唯一的密码找回路径 —— 没有它，用户忘密码 = 账号报废。
 *
 * ── 两个刻意的设计 ────────────────────────────────────────────────
 * 1. **口令优先从环境变量取，不优先从 argv 取**
 *    argv 会出现在 `ps`、shell history、以及容器 inspect 里。
 *    为了兼容随手一用的场景仍支持 argv，但会打印警告。
 * 2. **改密后立即撤销该用户所有会话**
 *    密码重置的语义就是"把别人踢下线"。若旧会话继续有效（比如账号已被
 *    他人接管），改密这个动作就完全失去意义。会话表存的是令牌的 SHA-256，
 *    所以这里直接按 user_id 删除即可。
 *
 * 约束：本文件是 .mjs，不能出现 TypeScript 语法；所有 import 必须带扩展名
 * （Node 的类型擦除不做扩展名解析）。理由详见 scripts/seed.mjs 的注释。
 */
import { hash } from '@node-rs/argon2'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '../src/db/schema.ts'
import { ARGON2_OPTIONS } from '../src/lib/argon2-options.ts'
import { weakPasswordReason } from '../src/lib/password-policy.ts'
import { postgresConnectionConfig, postgresSsl, databaseHost } from '../src/lib/db-config.ts'

const { Pool } = pg

const args = process.argv.slice(2)

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`用法:
  NEW_PASSWORD='<新口令>' node scripts/set-password.mjs <handle>
  node scripts/set-password.mjs <handle> '<新口令>'   # 口令会出现在进程列表里
  node scripts/set-password.mjs --list                # 列出账号（排查拼写错误）

口令强度规则与注册接口共用 src/lib/password-policy.ts，不会出现两套标准。`)
  process.exit(args.length === 0 ? 2 : 0)
}

const listMode = args[0] === '--list'
const handle = listMode ? null : args[0]
const passwordFromArgv = listMode ? null : args[1]
const NEW_PASSWORD = process.env.NEW_PASSWORD ?? passwordFromArgv

if (!listMode && !NEW_PASSWORD) {
  console.error(`✗ 缺少新口令。推荐用环境变量传，避免留在 shell history 与进程列表里：

    NEW_PASSWORD='<新口令>' node scripts/set-password.mjs ${handle}`)
  process.exit(2)
}

if (passwordFromArgv) {
  console.error(
    '⚠ 口令是通过命令行参数传入的 —— 它会出现在 `ps`、shell history、' +
      '以及 `docker inspect` 里。建议改用 NEW_PASSWORD 环境变量。',
  )
}

// 强度检查对两条传参路径都要生效（早期版本只在环境变量路径上检查，
// 结果"越不安全的传法越不受约束"，正好反了）
if (!listMode) {
  const weak = weakPasswordReason(NEW_PASSWORD)
  if (weak) {
    console.error(`✗ 新口令不符合策略：${weak}`)
    process.exit(2)
  }
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

  if (listMode) {
    const all = await db
      .select({ handle: schema.users.handle, role: schema.users.role, status: schema.users.status })
      .from(schema.users)
      .orderBy(schema.users.id)
    console.log(`\n共 ${all.length} 个账号：`)
    for (const u of all) console.log(`  ${u.handle.padEnd(20)} ${u.role.padEnd(8)} ${u.status}`)
    return
  }

  const found = await db
    .select({ id: schema.users.id, handle: schema.users.handle })
    .from(schema.users)
    .where(sql`lower(${schema.users.handle}) = ${handle.toLowerCase()}`)
    .limit(1)

  const user = found[0]
  if (!user) {
    throw new Error(`找不到用户 ${handle}。用 --list 看看现有账号的拼写。`)
  }

  const passwordHash = await hash(NEW_PASSWORD, ARGON2_OPTIONS)

  // 两步必须同一个事务：只改哈希而没撤销会话，等于"改了密码但别人还在线"
  const revoked = await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id))
    const gone = await tx
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, user.id))
      .returning({ id: schema.sessions.id })
    return gone.length
  })

  console.log(`✓ ${user.handle} 的密码已重置，并撤销 ${revoked} 个会话（旧标签页会被登出）`)
}

main()
  .catch((err) => {
    console.error('✗ 失败：', err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
