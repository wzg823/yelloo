/**
 * 密码重置策略的单元测试 —— 纯函数，不碰数据库、不发网络请求。
 *
 * 用法：
 *     node scripts/test-reset-policy.mjs
 *     npm run test:reset
 *
 * ── 这里测的是"令牌本身可不可信" ────────────────────────────────────
 *
 * 重置流程的其余部分（路由、邮件、数据库）出问题都是可见的：
 * 邮件收不到、接口报错。而令牌实现出问题是**不可见**的：
 *   · 令牌熵不够 → 可以被暴力猜（而流程看起来完全正常）
 *   · 该一次性的地方不是一次性 → 一条泄露的链接永久有效
 *   · 对外错误信息区分了 used/expired → 接口成了令牌探测器
 *
 * 这三条都不会让任何功能"坏掉"，所以只能靠测试钉住。
 */
import {
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  hashesEqual,
  isResetTokenUsable,
  maskEmail,
  resetEmailBody,
  resetExpiry,
} from '../src/lib/reset-policy.ts'

let passed = 0
const failures = []

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`\x1b[32m  ✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  } else {
    failures.push(name)
    console.log(`\x1b[31m  ✗\x1b[0m ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

const T0 = Date.UTC(2026, 0, 1)

// ── 1. 令牌生成 ──────────────────────────────────────────────────────
section('1. 令牌生成（熵与格式）')

{
  const { token, hash } = generateResetToken()

  // 32 字节 base64url = 43 字符（无填充）。少于这个长度就意味着熵不足
  ok('明文令牌长度 43 字符（32 字节 base64url）', token.length === 43, `${token.length} 字符`)
  ok('只含 URL 安全字符（能直接放进邮件链接）', /^[A-Za-z0-9_-]+$/.test(token))
  ok('哈希是 64 位 hex（SHA-256）', /^[0-9a-f]{64}$/.test(hash))
  ok('哈希与明文不同', hash !== token)

  ok('哈希可复现', hashResetToken(token) === hash)

  // 唯一性：1000 次不能有重复。这不证明随机性，但能挡住"忘了加盐/用了固定值"
  const seen = new Set()
  for (let i = 0; i < 1000; i += 1) seen.add(generateResetToken().token)
  ok('1000 次生成无重复', seen.size === 1000, `唯一 ${seen.size}`)

  // 前缀相同的概率极低；若出现说明实现有问题（比如固定前缀）
  const tokens = [...seen]
  ok(
    '不同令牌之间没有共同前缀（不是"固定前缀+计数"）',
    new Set(tokens.map((t) => t.slice(0, 8))).size === 1000,
  )
}

// ── 2. 有效期 ────────────────────────────────────────────────────────
section('2. 有效期')
{
  ok('默认 30 分钟', RESET_TOKEN_TTL_MS === 30 * 60 * 1000)
  const exp = resetExpiry(T0)
  ok('resetExpiry 按给定的 now 计算', exp.getTime() === T0 + RESET_TOKEN_TTL_MS)
  ok('返回的是 Date', exp instanceof Date)
}

// ── 3. 可用性判定（一次性 + 限期）───────────────────────────────────
section('3. 可用性判定（边界到毫秒）')

{
  const base = { expiresAt: T0 + RESET_TOKEN_TTL_MS, usedAt: null }

  ok('未使用且未过期 → 可用', isResetTokenUsable(base, T0).ok === true)

  const atLastMs = isResetTokenUsable(base, T0 + RESET_TOKEN_TTL_MS - 1)
  ok('过期前一毫秒仍可用', atLastMs.ok === true)

  const atExpiry = isResetTokenUsable(base, T0 + RESET_TOKEN_TTL_MS)
  ok('恰好到期即失效（不是"到期后还能用 1 秒"）', atExpiry.ok === false)
  ok(
    '过期对外只报一句通用错误',
    atExpiry.ok === false && atExpiry.code === 'expired' && atExpiry.error.includes('无效或已过期'),
  )

  const used = isResetTokenUsable({ ...base, usedAt: T0 + 1000 }, T0 + 2000)
  ok('已使用 → 失效', used.ok === false && used.code === 'used')
  ok(
    '已使用的错误信息与过期**完全相同**（不泄露令牌状态）',
    used.ok === false && used.error === (atExpiry.ok === false ? atExpiry.error : ''),
    used.ok === false ? `「${used.error}」` : '',
  )

  // 检查顺序：先用尽再判过期。已用尽的令牌即使也过期了，也该报 used ——
  // 那才是真正发生的事（有人重放了它）
  const both = isResetTokenUsable({ expiresAt: T0 - 1, usedAt: T0 - 2 }, T0)
  ok('既用尽又过期时报 used（重放才是重点）', both.ok === false && both.code === 'used', both.ok ? '' : both.code)

  // 时钟异常：expiresAt 在未来很久也不该有问题
  const far = isResetTokenUsable({ expiresAt: T0 + 100 * 365 * 86400_000, usedAt: null }, T0)
  ok('远期到期仍可用（不因数值大小出错）', far.ok === true)

  ok('接受毫秒数形式的 expiresAt', isResetTokenUsable({ expiresAt: T0 + 1000, usedAt: null }, T0).ok === true)
  ok('接受毫秒数形式的 usedAt', isResetTokenUsable({ expiresAt: T0 + 1000, usedAt: T0 }, T0).ok === false)
}

// ── 4. 常量时间比较 ──────────────────────────────────────────────────
section('4. 哈希比较')
{
  const a = hashResetToken('aaa')
  ok('相同哈希相等', hashesEqual(a, a) === true)
  ok('不同哈希不等', hashesEqual(a, hashResetToken('bbb')) === false)
  ok('长度不同不等且不抛异常', hashesEqual(a, 'short') === false)
  ok('空串比较不抛异常', hashesEqual('', '') === true)
}

// ── 5. 邮箱脱敏 ──────────────────────────────────────────────────────
section('5. 邮箱脱敏（审计与日志用）')
{
  ok('保留首字母与域名', maskEmail('alice@example.com') === 'a***@example.com')
  ok('单字符本地部分', maskEmail('a@example.com') === '*@example.com')
  ok('多级域名保留', maskEmail('bob@mail.example.com.cn') === 'b***@mail.example.com.cn')
  ok('取最后一个 @（本地部分含 @ 的畸形输入不崩）', maskEmail('a@b@c.com').startsWith('a***'))
  ok('无 @ 时返回 ***', maskEmail('not-an-email') === '***')
  ok('空串返回 ***', maskEmail('') === '***')
  ok('不会泄露完整本地部分', !maskEmail('alice@example.com').includes('lice'))
}

// ── 6. 邮件正文 ──────────────────────────────────────────────────────
section('6. 邮件正文（链接与有效期必须写进去）')
{
  const link = 'https://bbs.example.com/reset?token=ABC123'
  const mail = resetEmailBody({ handle: 'alice', link })

  ok('主题明确', mail.subject.includes('密码'))
  ok('正文含完整链接', mail.text.includes(link))
  ok('正文含用户名（让人知道这是哪个账号）', mail.text.includes('alice'))
  ok('说明了有效期', mail.text.includes('30 分钟'))
  ok('说明了只能使用一次', mail.text.includes('只能使用一次'))
  ok('提示"不是本人发起"时该怎么办', mail.text.includes('忽略'))
  ok(
    '自定义有效期会反映到正文',
    resetEmailBody({ handle: 'a', link, ttlMinutes: 5 }).text.includes('5 分钟'),
  )
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
console.log(`\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failures.length}`)
if (failures.length > 0) {
  console.log('\n\x1b[31m失败项：\x1b[0m')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('\n\x1b[32m全部通过。令牌熵、一次性、限期与脱敏均已验证。\x1b[0m')
}
