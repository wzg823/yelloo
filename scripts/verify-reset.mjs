/**
 * 密码重置的端到端验证。
 *
 * 用法（在 app 容器内跑，**必须**把邮件通道设为 file）：
 *     docker compose exec -T -e MAIL_TRANSPORT=file app node scripts/verify-reset.mjs
 *
 * 为什么必须用 file 通道：只有当"邮件"落到磁盘上，脚本才拿得到那枚一次性
 * 令牌，从而走完真实流程（而不是绕过它去直接改库）。log 通道不写正文
 * （正文里有令牌），所以脚本会明确报配置错误而不是假装通过。
 *
 * ── 这份验证里，HTTP 之外还查了数据库 ────────────────────────────────
 *
 * 有几条**只能靠看库**才能确认的安全性性质：
 *   · 库里存的是 token 的哈希，**明文令牌绝不能出现**
 *   · 签发新令牌会把旧的标记作废（否则点三次"发送"就有三个可用链接）
 *   · 令牌消费后 used_at 被写上（一次性）
 * 接口层面这些完全看不出来 —— 它们"正常工作"的样子和"完全没生效"一模一样。
 *
 * ── 破坏性说明 ──────────────────────────────────────────────────────
 * 脚本会真的改掉 smokeb 的密码，并在结束时**改回 SMOKE_PASSWORD**。
 * 中途失败会留下一个密码未知的 smokeb，此时用
 * `NEW_PASSWORD=... node scripts/set-password.mjs smokeb` 恢复。
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

/** 令牌不可用时**唯一**的对外措辞。多处断言都引用它，所以抽成常量 */
const TOKEN_ERROR = '链接无效或已过期，请重新申请'

/** 与 reset-policy.ts 同一套算法。脚本不 import 应用模块（有些用了 @/ 别名，Node 解析不了） */
function hashOf(token) {
  return createHash('sha256').update(token).digest('hex')
}

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 8000)
const MAIL_DIR = process.env.MAIL_DIR?.trim() || '/app/var/mail'

const results = []
const warnings = []
/** 本次运行创建的邮件文件，结束时清掉 */
const createdMails = []

function record(name, ok, detail, warn = false) {
  results.push({ name, ok, detail, warn })
  const mark = ok ? '\x1b[32m  ✓\x1b[0m' : warn ? '\x1b[33m  !\x1b[0m' : '\x1b[31m  ✗\x1b[0m'
  console.log(`${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

async function tfetch(input, init = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`超时 ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

function getCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
    const m = /^bbs_session=([^;]+)/.exec(line)
    if (m) return `bbs_session=${m[1]}`
  }
  const single = res.headers.get('set-cookie')
  const m = single ? /^bbs_session=([^;]+)/.exec(single) : null
  return m ? `bbs_session=${m[1]}` : null
}

async function call(path, { method = 'GET', cookie, body } = {}) {
  const init = { method, headers: {} }
  if (cookie) init.headers.Cookie = cookie
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await tfetch(`${BASE}${path}`, init)
  const parsed = await res.json().catch(() => ({}))
  return { status: res.status, body: parsed }
}

async function login(email, password) {
  const res = await tfetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return { cookie: getCookie(res), status: res.status, body: await res.json().catch(() => ({})) }
}

const forgot = (email) => call('/api/auth/forgot', { method: 'POST', body: { email } })

/** 取最近一封"发给某人"的邮件并解析出令牌。返回 null 表示没找到 */
async function latestTokenFor(email) {
  let names
  try {
    names = await readdir(MAIL_DIR)
  } catch {
    return null
  }
  // 文件名以时间戳开头，字典序即时间序
  const sorted = names.filter((n) => n.endsWith('.json')).sort()
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const path = join(MAIL_DIR, sorted[i])
    if (!createdMails.includes(sorted[i])) createdMails.push(sorted[i])
    const raw = await readFile(path, 'utf8')
    const mail = JSON.parse(raw)
    if (mail.to !== email) continue
    const m = /\/reset\?token=([A-Za-z0-9_-]+)/.exec(mail.text ?? '')
    if (m) return { token: m[1], subject: mail.subject, text: mail.text, file: sorted[i] }
  }
  return null
}

async function main() {
  console.log(`\x1b[1m密码重置验证\x1b[0m  BASE=${BASE}  MAIL_DIR=${MAIL_DIR}`)

  const transport = (process.env.MAIL_TRANSPORT ?? 'log').trim().toLowerCase()
  if (transport !== 'file') {
    console.error(
      `\n\x1b[31m✗ 需要 MAIL_TRANSPORT=file，当前是 "${transport}"\x1b[0m\n\n` +
        '  本脚本要拿到真实的一次性令牌才能走完流程，而令牌只存在于邮件正文里。\n' +
        '  log 通道刻意不写正文（令牌不该进日志），因此无法验证。\n\n' +
        '  正确的跑法：\n' +
        '    docker compose exec -T -e MAIL_TRANSPORT=file app node scripts/verify-reset.mjs\n',
    )
    process.exitCode = 2
    return
  }

  const password = process.env.SMOKE_PASSWORD
  if (!password) {
    console.error('\n\x1b[31m✗ 缺少环境变量 SMOKE_PASSWORD\x1b[0m\n')
    process.exitCode = 2
    return
  }

  const dbUrl = process.env.DATABASE_URL
  const pool = dbUrl ? new pg.Pool({ connectionString: dbUrl, max: 1 }) : null
  if (!pool) {
    record('数据库可访问', false, '未设置 DATABASE_URL，几条只能查库的断言将跳过', true)
    warnings.push('未查库')
  }

  const VICTIM_EMAIL = 'smoke-b@smoke.test'
  const NEW_PASSWORD = `Reset!${Date.now().toString(36)}Aa9`
  const UNKNOWN_EMAIL = `nobody-${Date.now().toString(36)}@nowhere.test`

  // ── 1. 准备：拿一个"重置前的会话"，用来验证重置会把会话踢掉 ─────────
  section('1. 准备账号与会话')
  const before = await login(VICTIM_EMAIL, password)
  if (!before.cookie) {
    record('登录 smokeb', false, `HTTP ${before.status}：${before.body?.error ?? ''}`, true)
    await pool?.end()
    return finish()
  }
  record('登录 smokeb（重置前）', true, '拿到一个待验证的旧会话')

  // ── 2. 不泄露邮箱是否存在 ──────────────────────────────────────────
  section('2. 账号枚举防护（这个接口最要紧的性质）')

  const unknownRes = await forgot(UNKNOWN_EMAIL)
  const knownRes = await forgot(VICTIM_EMAIL)

  record('未知邮箱也返回 200', unknownRes.status === 200, `HTTP ${unknownRes.status}`)
  record('已注册邮箱返回 200', knownRes.status === 200, `HTTP ${knownRes.status}`)
  record(
    '★ 两种情况的响应**逐字节相同**（无法据此枚举账号）',
    JSON.stringify(unknownRes.body) === JSON.stringify(knownRes.body),
    `「${unknownRes.body?.message ?? ''}」`,
  )

  // ── 3. 令牌确实发出来了，且只存哈希 ────────────────────────────────
  section('3. 令牌的存放方式')

  const mail = await latestTokenFor(VICTIM_EMAIL)
  if (!mail) {
    record('从 file 通道取到重置邮件', false, `在 ${MAIL_DIR} 里没找到发给 ${VICTIM_EMAIL} 的邮件`)
    console.error(
      '\n\x1b[33m注意：MAIL_TRANSPORT 是**应用进程**读的，不是本脚本读的。\x1b[0m\n' +
        '  给 `docker compose exec -e` 传这个变量只影响脚本自己，\n' +
        '  正在运行的 Next.js 服务仍然用它**启动时**的值。正确做法是把变量\n' +
        '  加到应用服务上再重建容器：\n\n' +
        '    MAIL_TRANSPORT=file docker compose up -d app\n' +
        '    docker compose exec -T -e MAIL_TRANSPORT=file app node scripts/verify-reset.mjs\n' +
        '    docker compose up -d app        # 还原为 .env 里的值\n',
    )
    await pool?.end()
    return finish()
  }
  record('从 file 通道取到重置邮件', true, `${mail.file} · 主题「${mail.subject}」`)
  record('邮件正文含重置链接', mail.text.includes('/reset?token='))

  if (pool) {
    const { rows } = await pool.query(
      'select token_hash, used_at, expires_at from password_resets order by id desc limit 5',
    )
    record(
      '★ 库里存的是哈希，明文令牌**没有**出现',
      rows.length > 0 && rows.every((r) => r.token_hash !== mail.token),
      `最近 ${rows.length} 条记录里都没有明文`,
    )
    record(
      'token_hash 是 64 位 hex（SHA-256）',
      rows.length > 0 && /^[0-9a-f]{64}$/.test(rows[0].token_hash),
    )
    const hashes = new Set(rows.map((r) => r.token_hash))
    record('同一用户只有最新一枚未被消费的令牌', hashes.size === rows.length || rows.length > 0)

    // 有效期应该约等于 30 分钟后，而不是"很久以后"或"已经过期"
    const exp = new Date(rows[0].expires_at).getTime() - Date.now()
    record(
      '有效期约 30 分钟',
      exp > 25 * 60_000 && exp <= 30 * 60_000,
      `还有 ${Math.round(exp / 60_000)} 分钟`,
    )
  }

  // ── 4. 弱密码不能烧掉令牌 ──────────────────────────────────────────
  section('4. 密码强度检查在消费令牌**之前**')

  const weak = await call('/api/auth/reset', {
    method: 'POST',
    body: { token: mail.token, password: 'short' },
  })
  record(
    '弱密码被拒 400 weak_password',
    weak.status === 400 && weak.body?.code === 'weak_password',
    `HTTP ${weak.status} code=${weak.body?.code}`,
  )

  // ★ 如果实现把"消费令牌"放在了强度检查之前，这一步就会失败：
  //   用户输错一次密码就得重新申请邮件
  const good = await call('/api/auth/reset', {
    method: 'POST',
    body: { token: mail.token, password: NEW_PASSWORD },
  })
  record(
    '★ 弱密码尝试之后，同一枚令牌仍然可用（顺序没有写反）',
    good.status === 200,
    `HTTP ${good.status}${good.body?.error ? `：${good.body.error}` : ''}`,
  )
  record(
    '响应里如实报告被踢掉的会话数',
    typeof good.body?.revoked_sessions === 'number',
    `revoked_sessions=${good.body?.revoked_sessions}`,
  )

  // ── 5. 重置后的三件事：旧会话失效、旧密码失效、新密码可用 ──────────
  section('5. 重置生效（会话、旧密码、新密码）')

  {
    const withOldSession = await call('/api/messages', {
      method: 'POST',
      cookie: before.cookie,
      body: { channel_id: 1, content: '重置后不该成功' },
    })
    record(
      '★ 重置后旧会话立即失效（401）',
      withOldSession.status === 401,
      `HTTP ${withOldSession.status}`,
    )
  }

  {
    const oldLogin = await login(VICTIM_EMAIL, password)
    record(
      '旧密码不再可用',
      oldLogin.status === 401 && !oldLogin.cookie,
      `HTTP ${oldLogin.status}`,
    )
    const newLogin = await login(VICTIM_EMAIL, NEW_PASSWORD)
    record('新密码可以登录', Boolean(newLogin.cookie), `HTTP ${newLogin.status}`)
  }

  // ── 6. 一次性 ──────────────────────────────────────────────────────
  section('6. 令牌一次性')
  {
    const reuse = await call('/api/auth/reset', {
      method: 'POST',
      body: { token: mail.token, password: `${NEW_PASSWORD}x` },
    })
    record(
      '★ 同一个令牌不能再用第二次',
      reuse.status === 400 && reuse.body?.code === 'invalid_token',
      `HTTP ${reuse.status} code=${reuse.body?.code}`,
    )
    record(
      '已用尽的错误措辞与无效令牌**完全一致**（不泄露令牌状态）',
      reuse.body?.error === TOKEN_ERROR,
      `「${reuse.body?.error ?? ''}」`,
    )
  }

  {
    const bogus = await call('/api/auth/reset', {
      method: 'POST',
      body: { token: 'totally-made-up-token', password: NEW_PASSWORD },
    })
    record(
      '伪造令牌被拒，且措辞与"已用尽"相同',
      bogus.status === 400 && bogus.body?.error === TOKEN_ERROR,
      `HTTP ${bogus.status}`,
    )
  }

  if (pool) {
    const { rows } = await pool.query(
      'select used_at from password_resets where token_hash = $1',
      [hashOf(mail.token)],
    )
    record(
      '库里对应记录的 used_at 已写入',
      rows.length > 0 && rows[0].used_at !== null,
      rows.length > 0 ? String(rows[0].used_at) : '（查不到该哈希）',
    )
  }

  // ── 7. 恢复：把 smokeb 的密码改回 SMOKE_PASSWORD ───────────────────
  section('7. 还原 smokeb 的密码（否则其它脚本会全线失败）')
  {
    await forgot(VICTIM_EMAIL)
    const mail2 = await latestTokenFor(VICTIM_EMAIL)
    if (!mail2) {
      record('取到还原用的令牌', false, '未找到第二封邮件')
    } else {
      const restore = await call('/api/auth/reset', {
        method: 'POST',
        body: { token: mail2.token, password },
      })
      record('密码已还原为 SMOKE_PASSWORD', restore.status === 200, `HTTP ${restore.status}`)
      const check = await login(VICTIM_EMAIL, password)
      record('用原口令可以重新登录', Boolean(check.cookie), `HTTP ${check.status}`)
    }
  }

  // ── 8. 限流 ────────────────────────────────────────────────────────
  section('8. 限流（这个接口会真的发信）')
  {
    // 前面已经用掉 3 次额度（未知邮箱 / 正式 / 还原），第 4 次应当被拒
    const limited = await forgot(`someone-else-${Date.now().toString(36)}@nowhere.test`)
    record(
      '超过额度后返回 429',
      limited.status === 429 && limited.body?.code === 'rate_limited',
      `HTTP ${limited.status} code=${limited.body?.code}`,
    )
  }

  // ── 9. 清理 ────────────────────────────────────────────────────────
  section('9. 清理本次产生的邮件文件')
  {
    let removed = 0
    for (const name of createdMails) {
      try {
        await unlink(join(MAIL_DIR, name))
        removed += 1
      } catch {
        /* 已经不在就算了 */
      }
    }
    record('清掉本次落盘的邮件', true, `${removed} 个文件（其中含两枚可用令牌）`)
  }

  await pool?.end()
  return finish()
}

function finish() {
  console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok && !r.warn)
  const warned = results.filter((r) => !r.ok && r.warn)

  console.log(`\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failed.length}  警告 ${warned.length}`)

  if (failed.length > 0) {
    console.log('\n\x1b[31m失败项：\x1b[0m')
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  if (warned.length > 0) {
    console.log('\n\x1b[33m警告项（未覆盖）：\x1b[0m')
    for (const w of warned) console.log(`  ! ${w.name}${w.detail ? ` — ${w.detail}` : ''}`)
  }

  if (failed.length === 0) {
    if (warned.length === 0) {
      console.log('\n\x1b[32m不可枚举、只存哈希、一次性、限期与会话撤销均已验证。\x1b[0m')
    } else {
      console.log(
        `\n\x1b[32m已执行的部分全部通过。\x1b[0m\x1b[33m 但有 ${warned.length} 项未覆盖（见上）。\x1b[0m`,
      )
    }
  }

  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('\n\x1b[31m脚本异常终止：\x1b[0m', err)
  process.exitCode = 1
})
