/**
 * 管理策略的单元测试 —— 纯函数，不碰数据库、不发网络请求。
 *
 * 用法：
 *     node scripts/test-admin-policy.mjs
 *     npm run test:admin
 *
 * ── 为什么这一份最不能省 ────────────────────────────────────────────
 *
 * 这里测的是**等级关系**，也就是"这个人能不能处置那个人"。
 * 它写错的表现不是报错，而是**权限体系静默失效**：
 * 版主可以封版主、管理员可以互相封禁、被盗账号可以立刻造出第二个管理员。
 * 这些操作在日志上看起来全都"有权限、合法"。
 *
 * 而位运算永远发现不了这类问题 —— 它看的是"有没有这个能力"，
 * 不看"对谁用"。所以横向提权必须由这一层单独兜住，并且穷举测试。
 */
import {
  CHANNEL_SLUG_RE,
  canAssignRole,
  canModerateTarget,
  effectiveStatus,
  excerpt,
  normalizeChannelInput,
  normalizeChannelSlug,
  parseDuration,
  roleRank,
} from '../src/lib/admin-policy.ts'

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

const admin = { id: 1, role: 'admin' }
const mod = { id: 2, role: 'mod' }
const mod2 = { id: 3, role: 'mod' }
const member = { id: 4, role: 'member' }
const member2 = { id: 5, role: 'member' }

// ── 1. 等级映射 ──────────────────────────────────────────────────────
section('1. 角色等级')
ok('admin > mod > member', roleRank('admin') > roleRank('mod') && roleRank('mod') > roleRank('member'))
ok('未知角色按最低等级处理（拼写错误不该放行）', roleRank('superuser') === 0 && roleRank(null) === 0)

// ── 2. 禁止自我处置 ──────────────────────────────────────────────────
section('2. 不能处置自己（防把自己锁在门外）')
for (const [who, label] of [[admin, '管理员'], [mod, '版主'], [member, '普通成员']]) {
  for (const action of ['mute', 'ban', 'kick', 'set_trust']) {
    const v = canModerateTarget(who, who, action)
    ok(
      `${label}不能对自己 ${action}`,
      v.ok === false && v.code === 'self_target',
      v.ok ? '被放行了' : v.code,
    )
  }
}
{
  const v = canAssignRole(admin, admin, 'member')
  ok('管理员不能改自己的角色（会把自己降权/锁死）', v.ok === false && v.code === 'self_target')
}

// ── 3. 横向提权：同级与更高级一律拒绝 ────────────────────────────────
section('3. 横向提权（这一节是整份测试的重点）')
{
  const cases = [
    ['管理员 → 管理员', admin, { id: 99, role: 'admin' }],
    ['版主 → 版主', mod, mod2],
    ['版主 → 管理员', mod, admin],
    ['普通成员 → 普通成员', member, member2],
    ['普通成员 → 版主', member, mod],
  ]
  for (const [label, actor, target] of cases) {
    for (const action of ['mute', 'ban', 'kick', 'set_trust']) {
      const v = canModerateTarget(actor, target, action)
      ok(
        `${label} 不能 ${action}`,
        v.ok === false && v.code === 'insufficient_rank',
        v.ok ? '★ 被放行了，这是横向提权漏洞' : v.code,
      )
    }
  }
}

section('4. 允许的方向（低等级可以被高等级处置）')
{
  ok('管理员可以禁言版主', canModerateTarget(admin, mod, 'mute').ok === true)
  ok('管理员可以封禁版主', canModerateTarget(admin, mod, 'ban').ok === true)
  ok('管理员可以禁言普通成员', canModerateTarget(admin, member, 'mute').ok === true)
  ok('版主可以禁言普通成员', canModerateTarget(mod, member, 'mute').ok === true)
}

// ── 5. 角色指派：不能造出同级或更高 ──────────────────────────────────
section('5. 角色指派（不能让被盗账号立刻造出第二个管理员）')
{
  ok('管理员可以把成员设为版主', canAssignRole(admin, member, 'mod').ok === true)
  ok('管理员可以把版主降为成员', canAssignRole(admin, mod, 'member').ok === true)

  const escalate = canAssignRole(admin, member, 'admin')
  ok(
    '管理员**不能**把别人设为管理员（必须走带外手段）',
    escalate.ok === false && escalate.code === 'role_too_high',
    escalate.ok ? '★ 被放行了' : escalate.code,
  )
  const modPromote = canAssignRole(mod, member, 'mod')
  ok(
    '版主不能把人提到与自己同级',
    modPromote.ok === false && modPromote.code === 'role_too_high',
    modPromote.ok ? '★ 被放行了' : modPromote.code,
  )
  ok(
    '等级关系优先于角色规则（版主不能碰版主）',
    canAssignRole(mod, mod2, 'member').ok === false,
  )
}

// ── 6. 时长解析 ──────────────────────────────────────────────────────
section('6. 时长解析')
{
  const t = (input) => parseDuration(input)
  ok('30m → 30 分钟', t('30m').ok && t('30m').ms === 30 * 60_000)
  ok('12h → 12 小时', t('12h').ok && t('12h').ms === 12 * 3_600_000)
  ok('7d → 7 天', t('7d').ok && t('7d').ms === 7 * 86_400_000)
  ok('大小写与空格都能容忍', t(' 7D ').ok && t(' 7D ').ms === 7 * 86_400_000)
  ok('forever → 不设结束时间', t('forever').ok && t('forever').ms === null)
  ok('空串 → 不设结束时间', t('').ok && t('').ms === null)
  ok('0 → 不设结束时间', t('0').ok && t('0').ms === null)
  ok('0m 也按不设结束时间处理', t('0m').ok && t('0m').ms === null)

  ok('无单位被拒', t('30').ok === false)
  ok('未知单位被拒', t('30x').ok === false)
  ok('负数被拒', t('-5m').ok === false)
  ok('中文被拒（避免"3天"被静默当成无期限）', t('3天').ok === false)
  const tooLong = t('999d')
  ok('超过 365 天被拒', tooLong.ok === false, tooLong.ok ? '被放行' : tooLong.error)
}

// ── 7. 有效状态 ──────────────────────────────────────────────────────
section('7. 有效状态（必须与 session.isMuted 一致）')
{
  const now = Date.UTC(2026, 0, 1)
  ok('active → active', effectiveStatus({ status: 'active', mutedUntil: null }, now) === 'active')
  ok('banned → banned', effectiveStatus({ status: 'banned', mutedUntil: null }, now) === 'banned')
  ok(
    '禁言且未到期 → muted',
    effectiveStatus({ status: 'muted', mutedUntil: now + 60_000 }, now) === 'muted',
  )
  ok(
    '禁言但已过期 → active（否则界面会显示"禁言中"而其实早就能发言）',
    effectiveStatus({ status: 'muted', mutedUntil: now - 1 }, now) === 'active',
  )
  ok(
    '禁言且未设结束时间 → muted（永久禁言）',
    effectiveStatus({ status: 'muted', mutedUntil: null }, now) === 'muted',
  )
  ok(
    '接受 Date 与毫秒两种入参',
    effectiveStatus({ status: 'muted', mutedUntil: new Date(now + 1000) }, now) === 'muted',
  )
  ok(
    'banned 优先于禁言到期判断',
    effectiveStatus({ status: 'banned', mutedUntil: now - 1 }, now) === 'banned',
  )
}

// ── 8. 频道 slug ─────────────────────────────────────────────────────
section('8. 频道 slug 规范化')
{
  ok('大写转小写', normalizeChannelSlug('General') === 'general')
  ok('空格转连字符', normalizeChannelSlug('front end') === 'front-end')
  ok('下划线转连字符', normalizeChannelSlug('front_end') === 'front-end')
  ok('连续连字符合并', normalizeChannelSlug('a---b') === 'a-b')
  ok('去掉首尾连字符', normalizeChannelSlug('-abc-') === 'abc')
  ok('丢弃非 ASCII（中文名必须手填 slug）', normalizeChannelSlug('闲聊') === '')
  ok('丢弃符号', normalizeChannelSlug('help!!!') === 'help')

  ok('合法 slug 通过校验', CHANNEL_SLUG_RE.test('general-chat'))
  ok('单字符被拒（太短，且首页链接会很难看）', !CHANNEL_SLUG_RE.test('a'))
  ok('以连字符结尾被拒', !CHANNEL_SLUG_RE.test('abc-'))
  ok('以连字符开头被拒', !CHANNEL_SLUG_RE.test('-abc'))
  ok('含大写被拒', !CHANNEL_SLUG_RE.test('Abc'))
  ok('超长被拒', !CHANNEL_SLUG_RE.test('a'.repeat(33)))
}

// ── 9. 频道输入规范化 ────────────────────────────────────────────────
section('9. 频道输入规范化')
{
  const base = { name: '闲聊', slug: 'general-chat', type: 'text' }

  const okText = normalizeChannelInput(base)
  ok('普通文本频道通过', okText.ok === true)
  ok('未指定 readOnly 时为 false', okText.ok && okText.value.readOnly === false)

  const forum = normalizeChannelInput({ ...base, type: 'forum' })
  ok('forum 类型通过', forum.ok === true)

  // ★ 关键耦合：公告频道必须只读，否则发送接口只看 readOnly，
  //   结果人人能在公告频道发言
  const announce = normalizeChannelInput({ ...base, type: 'announce', readOnly: false })
  ok(
    '★ announce 类型被强制为只读（即使传了 readOnly=false）',
    announce.ok === true && announce.value.readOnly === true,
    announce.ok ? `readOnly=${announce.value.readOnly}` : '',
  )

  const textReadOnly = normalizeChannelInput({ ...base, readOnly: true })
  ok('普通频道可以显式设为只读', textReadOnly.ok && textReadOnly.value.readOnly === true)

  const unknownType = normalizeChannelInput({ ...base, type: 'weird' })
  ok('未知类型退化为 text（而不是报错或放行任意值）', unknownType.ok && unknownType.value.type === 'text')

  ok('空名字被拒', normalizeChannelInput({ ...base, name: '  ' }).ok === false)
  ok('超长名字被拒', normalizeChannelInput({ ...base, name: 'x'.repeat(49) }).ok === false)

  const badSlug = normalizeChannelInput({ ...base, slug: '闲聊' })
  ok(
    '中文 slug 被拒并给出可操作的提示',
    badSlug.ok === false && badSlug.code === 'invalid_slug' && badSlug.error.includes('手填'),
    badSlug.ok ? '被放行' : badSlug.error,
  )

  ok('超长话题被拒', normalizeChannelInput({ ...base, topic: 'x'.repeat(201) }).ok === false)
  ok('空话题归一为 null', normalizeChannelInput({ ...base, topic: '   ' }).value.topic === null)

  const negPos = normalizeChannelInput({ ...base, position: -5 })
  ok('负排序值归零', negPos.ok && negPos.value.position === 0)
  const floatPos = normalizeChannelInput({ ...base, position: 3.7 })
  ok('排序值取整', floatPos.ok && floatPos.value.position === 3)
}

// ── 10. excerpt ──────────────────────────────────────────────────────
section('10. 摘要截断')
{
  ok('短文本原样返回', excerpt('hello', 80) === 'hello')
  ok('换行被压平', excerpt('a\n\nb', 80) === 'a b')
  ok('超长截断并加省略号', excerpt('x'.repeat(100), 10).length === 10)
  ok('截断结果以省略号结尾', excerpt('x'.repeat(100), 10).endsWith('…'))
  ok('边界：正好等于上限时不截断', excerpt('x'.repeat(10), 10) === 'x'.repeat(10))
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
console.log(`\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failures.length}`)
if (failures.length > 0) {
  console.log('\n\x1b[31m失败项：\x1b[0m')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('\n\x1b[32m全部通过。防横向提权、时长解析与频道输入均已验证。\x1b[0m')
}
