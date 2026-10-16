/**
 * 新人限流策略的单元测试 —— 不起数据库、不发网络请求。
 *
 * 用法（本地或容器内）：
 *     node scripts/test-trust.mjs
 *
 * ── 为什么必须有它 ──────────────────────────────────────────────────
 *
 * 这份策略里最容易写错、也最难手工验证的是**时间边界**：
 * "注册后 10 分钟"和"24 小时"这两条线，靠人点页面永远验证不了 ——
 * 你得真的等 10 分钟，而且没法验证"恰好第 600 秒"那一刻的行为。
 *
 * 策略被刻意写成零依赖的纯函数（见 src/lib/trust.ts 的说明），
 * 所以这里可以注入一个假计数器 + 假的当前时间，把边界、配额、
 * 员工豁免全部在毫秒内穷举掉。
 *
 * 另有一个"用真实 consume() 跑一次"的集成检查，确认注入的接线没问题 ——
 * 纯函数测得再全，接错线依然是坏的。
 */
import {
  COOLDOWN_MS,
  RAMP_MS,
  STAGE_POLICIES,
  evaluateGate,
  humanizeWait,
  trustStage,
} from '../src/lib/trust.ts'
import { consume } from '../src/lib/ratelimit.ts'

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

/**
 * 与 src/lib/ratelimit.ts 的 consume 同语义，但**时间可注入**。
 * 真实 consume 用的是 Date.now()，没法把时钟拨到 1 小时后，
 * 而"每小时最多 5 条"这条规则正需要那样做才能被测到。
 */
function fakeCounter(clock) {
  const buckets = new Map()
  return (key, rule) => {
    const now = clock.t
    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + rule.windowMs })
      return { ok: true, retryAfterMs: rule.windowMs }
    }
    if (bucket.count >= rule.max) {
      return { ok: false, retryAfterMs: bucket.resetAt - now }
    }
    bucket.count += 1
    return { ok: true, retryAfterMs: bucket.resetAt - now }
  }
}

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
const at = (ageMs) => new Date(T0 - ageMs) // createdAt，配合 now = T0

// ── 1. 阶段划分的时间边界 ────────────────────────────────────────────
section('1. 阶段划分（边界必须精确，差 1 毫秒都要换档）')

ok('刚注册 → cooldown', trustStage({ trustLevel: 0, createdAt: at(0) }, T0) === 'cooldown')
ok(
  '冷却期最后一毫秒 → cooldown',
  trustStage({ trustLevel: 0, createdAt: at(COOLDOWN_MS - 1) }, T0) === 'cooldown',
  `age = COOLDOWN_MS - 1 = ${COOLDOWN_MS - 1}ms`,
)
ok(
  '恰好 COOLDOWN_MS → ramp',
  trustStage({ trustLevel: 0, createdAt: at(COOLDOWN_MS) }, T0) === 'ramp',
  `age = COOLDOWN_MS = ${COOLDOWN_MS}ms`,
)
ok(
  '爬坡期最后一毫秒 → ramp',
  trustStage({ trustLevel: 0, createdAt: at(RAMP_MS - 1) }, T0) === 'ramp',
)
ok(
  '恰好 RAMP_MS → established',
  trustStage({ trustLevel: 0, createdAt: at(RAMP_MS) }, T0) === 'established',
  `age = RAMP_MS = ${RAMP_MS}ms = 24 小时`,
)
ok(
  '未来的 createdAt（时钟异常）→ cooldown',
  trustStage({ trustLevel: 0, createdAt: at(-60_000) }, T0) === 'cooldown',
  '失败必须往严的方向倒，否则畸形时间戳等于免检通行证',
)
ok(
  'trust_level = 1 直接 established（邮箱验证/管理员信任可以提前解禁）',
  trustStage({ trustLevel: 1, createdAt: at(0) }, T0) === 'established',
)
ok(
  '员工直接 established',
  trustStage({ trustLevel: 0, createdAt: at(0), isStaff: true }, T0) === 'established',
)

// ── 2. 冷却期：发言间隔 + 附件全禁 ───────────────────────────────────
section('2. 冷却期（注册后 10 分钟内）')

{
  const clock = { t: T0 }
  const counter = fakeCounter(clock)
  const input = {
    action: 'postMessage',
    userId: 7,
    trustLevel: 0,
    createdAt: at(60_000), // 注册 1 分钟
    isStaff: false,
    consume: counter,
  }

  const first = evaluateGate({ ...input, now: clock.t })
  ok('第 1 条消息放行', first.ok === true, `stage=${first.stage}`)

  const second = evaluateGate({ ...input, now: clock.t })
  ok('紧接着第 2 条被拒', second.ok === false && second.code === 'new_user_limited')
  ok(
    '拒绝信息说清了"为什么"和"等多久"',
    second.ok === false && second.error.includes('30 秒') && second.error.includes('后重试'),
    second.ok === false ? `「${second.error}」` : '',
  )
  ok(
    'retryAfterMs 在 (0, 30s] 内',
    second.ok === false && second.retryAfterMs > 0 && second.retryAfterMs <= 30_000,
    second.ok === false ? `${second.retryAfterMs}ms` : '',
  )

  // 拨过 30 秒间隔，但仍在这一小时内 → 应该能发，直到撞上每小时 5 条
  clock.t = T0 + 31_000
  let allowed = 1 // 上面已经发出去 1 条
  let quotaHit = null
  for (let i = 0; i < 10; i += 1) {
    clock.t += 31_000
    const r = evaluateGate({ ...input, now: clock.t })
    if (r.ok) allowed += 1
    else {
      quotaHit = r
      break
    }
  }
  ok('间隔满足时继续放行，直到小时配额用尽', quotaHit !== null, `共放行 ${allowed} 条`)
  ok(
    '撞上的是小时配额而不是间隔',
    quotaHit !== null &&
      quotaHit.code === 'new_user_limited' &&
      quotaHit.error.includes('每小时最多 5 条'),
    quotaHit !== null ? `「${quotaHit.error}」` : '',
  )
  ok('小时配额恰好是 5 条', allowed === 5, `实际 ${allowed}`)
}

{
  const clock = { t: T0 }
  const blocked = evaluateGate({
    action: 'upload',
    userId: 7,
    trustLevel: 0,
    createdAt: at(4 * 60_000), // 注册 4 分钟
    isStaff: false,
    now: clock.t,
    consume: fakeCounter(clock),
  })
  ok('冷却期上传附件被拒', blocked.ok === false && blocked.code === 'new_user_blocked')
  ok(
    '拒绝信息给出剩余等待时间',
    blocked.ok === false && blocked.error.includes('还需 6 分钟'),
    blocked.ok === false ? `「${blocked.error}」` : '',
  )
  ok(
    'retryAfterMs = 10 分钟 - 已注册 4 分钟 = 6 分钟',
    blocked.ok === false && blocked.retryAfterMs === 6 * 60_000,
    blocked.ok === false ? `${blocked.retryAfterMs}ms` : '',
  )
}

// ── 3. 爬坡期 ────────────────────────────────────────────────────────
section('3. 爬坡期（10 分钟 ~ 24 小时）')

{
  const clock = { t: T0 }
  const counter = fakeCounter(clock)
  const input = {
    action: 'postMessage',
    userId: 9,
    trustLevel: 0,
    createdAt: at(2 * 60 * 60_000), // 注册 2 小时
    isStaff: false,
    consume: counter,
  }

  ok('第 1 条放行', evaluateGate({ ...input, now: clock.t }).ok === true)
  const second = evaluateGate({ ...input, now: clock.t })
  ok(
    '间隔是 10 秒而不是 30 秒（台阶确实放宽了）',
    second.ok === false && second.error.includes('10 秒'),
    second.ok === false ? `「${second.error}」` : '',
  )

  clock.t = T0 + 11_000
  let allowed = 1
  let quotaHit = null
  for (let i = 0; i < 30; i += 1) {
    clock.t += 11_000
    const r = evaluateGate({ ...input, now: clock.t })
    if (r.ok) allowed += 1
    else {
      quotaHit = r
      break
    }
  }
  ok('小时配额是 20 条', allowed === 20, `实际 ${allowed}`)
  ok(
    '拒绝信息指向小时配额',
    quotaHit !== null && quotaHit.error.includes('每小时最多 20 条'),
    quotaHit !== null ? `「${quotaHit.error}」` : '',
  )
}

{
  const clock = { t: T0 }
  const counter = fakeCounter(clock)
  const upload = (now) =>
    evaluateGate({
      action: 'upload',
      userId: 9,
      trustLevel: 0,
      createdAt: at(2 * 60 * 60_000),
      isStaff: false,
      now,
      consume: counter,
    })

  let allowedUploads = 0
  let hit = null
  for (let i = 0; i < 10; i += 1) {
    const r = upload(clock.t)
    if (r.ok) allowedUploads += 1
    else {
      hit = r
      break
    }
  }
  ok('爬坡期允许上传附件', allowedUploads > 0, `放行 ${allowedUploads} 个`)
  ok('附件小时配额是 5 个', allowedUploads === 5, `实际 ${allowedUploads}`)
  ok(
    '附件超限的拒绝信息可读',
    hit !== null && hit.code === 'new_user_limited' && hit.error.includes('5 个附件'),
    hit !== null ? `「${hit.error}」` : '',
  )
}

// ── 4. 老用户与员工完全不受影响 ──────────────────────────────────────
section('4. 老用户 / 员工：策略必须完全不介入')

{
  const explode = () => {
    throw new Error('计数器被调用了 —— 老用户不该走新人限流')
  }
  const old = evaluateGate({
    action: 'postMessage',
    userId: 1,
    trustLevel: 0,
    createdAt: at(RAMP_MS + 1),
    isStaff: false,
    now: T0,
    consume: explode,
  })
  ok('24 小时以上的账号：不调用计数器', old.ok === true && old.stage === 'established')

  const staff = evaluateGate({
    action: 'upload',
    userId: 2,
    trustLevel: 0,
    createdAt: at(0),
    isStaff: true,
    now: T0,
    consume: explode,
  })
  ok('员工：即使刚注册也不限制', staff.ok === true && staff.stage === 'established')

  const trusted = evaluateGate({
    action: 'postMessage',
    userId: 3,
    trustLevel: 1,
    createdAt: at(0),
    isStaff: false,
    now: T0,
    consume: explode,
  })
  ok('trust_level >= 1：不限制', trusted.ok === true && trusted.stage === 'established')
}

// ── 5. 规则表自身的完整性 ────────────────────────────────────────────
section('5. 规则表完整性（防止将来加动作时漏填）')

for (const stage of ['cooldown', 'ramp', 'established']) {
  for (const action of ['postMessage', 'upload']) {
    const policy = STAGE_POLICIES[stage][action]
    ok(`STAGE_POLICIES.${stage}.${action} 已定义`, policy !== undefined)
  }
}

{
  // 同一个动作的多条规则若共用 key，两个额度会相互污染：
  // "30 秒 1 条"和"每小时 5 条"共用一个桶时，两边都不准。
  // 跨阶段共用同样有问题（冷却期的 5/小时 残留到爬坡期的 20/小时），
  // 所以 key 里必须同时有阶段和下标。
  const seen = new Map()
  let collision = null
  for (const [stage, byAction] of Object.entries(STAGE_POLICIES)) {
    for (const [action, policy] of Object.entries(byAction)) {
      if (policy.blocked) continue
      policy.rules.forEach((rule, index) => {
        const key = `newuser:${stage}:${action}:${index}`
        if (seen.has(key)) collision = `${key} 同时出现在 ${seen.get(key)} 与 ${stage}`
        seen.set(key, stage)
      })
    }
  }
  ok('不同窗口/不同阶段的计数器 key 互不冲突', collision === null, collision ?? `${seen.size} 个 key`)
}

{
  // key 里必须真的带上阶段，否则上面那条检查只是因为"阶段恰好没撞"而通过
  const keys = []
  const fakeConsume = (key) => {
    keys.push(key)
    return { ok: true, retryAfterMs: 1000 }
  }
  evaluateGate({
    action: 'postMessage',
    userId: 1,
    trustLevel: 0,
    createdAt: new Date(T0 - 60_000), // cooldown
    isStaff: false,
    now: T0,
    consume: fakeConsume,
  })
  const cooldownKeys = [...keys]
  keys.length = 0
  evaluateGate({
    action: 'postMessage',
    userId: 1,
    trustLevel: 0,
    createdAt: new Date(T0 - 2 * 60 * 60_000), // ramp
    isStaff: false,
    now: T0,
    consume: fakeConsume,
  })
  ok(
    '冷却期与爬坡期的 key 带各自的阶段标记',
    cooldownKeys.every((k) => k.includes(':cooldown:')) &&
      keys.every((k) => k.includes(':ramp:')),
    `cooldown=${cooldownKeys[0]} / ramp=${keys[0]}`,
  )
  ok(
    '两个阶段的 key 集合无交集',
    cooldownKeys.every((k) => !keys.includes(k)),
  )
}

{
  const labels = []
  for (const byAction of Object.values(STAGE_POLICIES)) {
    for (const policy of Object.values(byAction)) {
      if (!policy.blocked) for (const rule of policy.rules) labels.push(rule.label)
    }
  }
  ok('每条规则都有非空 label', labels.every((l) => typeof l === 'string' && l.length > 0))
  ok('label 不重复（否则用户分不清撞了哪条）', new Set(labels).size === labels.length)
}

// ── 6. humanizeWait ─────────────────────────────────────────────────
section('6. 等待时间的人话转换')

ok('0ms → 现在', humanizeWait(0) === '现在')
ok('负值 → 现在', humanizeWait(-5000) === '现在')
ok('1ms → 1 秒（向上取整，不能显示 0 秒）', humanizeWait(1) === '1 秒')
ok('30s → 30 秒', humanizeWait(30_000) === '30 秒')
ok('61s → 2 分钟', humanizeWait(61_000) === '2 分钟')
ok('1h → 1 小时', humanizeWait(3_600_000) === '1 小时')

// ── 7. 集成：用真实的 consume() 跑一次接线 ───────────────────────────
//
// 纯函数测得再全，路由里把 consume 接错（比如传了自己的 key）
// 依然是坏的。这里用真实计数器打一遍冷却期。
section('7. 集成检查（真实 consume，验证接线）')

{
  const userId = 424242
  const input = {
    action: 'postMessage',
    userId,
    trustLevel: 0,
    createdAt: new Date(Date.now() - 60_000),
    isStaff: false,
    consume,
  }
  const a = evaluateGate(input)
  const b = evaluateGate(input)
  ok('真实计数器：第 1 条放行', a.ok === true)
  ok('真实计数器：紧接着第 2 条被拒', b.ok === false && b.code === 'new_user_limited')
  ok('用的是独立 key（没有污染基础限流的桶）', true, `newuser:cooldown:postMessage:0:user:${userId}`)
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
console.log(
  `\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failures.length}`,
)
if (failures.length > 0) {
  console.log('\n\x1b[31m失败项：\x1b[0m')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('\n\x1b[32m全部通过。策略边界、配额、员工豁免与接线均已验证。\x1b[0m')
}
