/**
 * 新人限流的端到端验证 —— 打真实 HTTP 接口。
 *
 * 用法（容器内跑，或经隧道从本机跑）：
 *     node scripts/verify-newuser.mjs
 *     BASE_URL=https://bbs.example.com node scripts/verify-newuser.mjs
 *
 * ── 它和 scripts/test-trust.mjs 的分工 ──────────────────────────────
 *
 * test-trust.mjs 是纯函数测试：注入假时钟，把 10 分钟 / 24 小时边界、
 * 各种配额、员工豁免穷举验证。它跑得飞快，但它**证明不了这些策略真的
 * 接在路由上了** —— 代码写对了却忘了调用，测试照样全绿。
 *
 * 所以这里从外部按真实用户的路径打一遍 HTTP，确认门卡确实生效。
 *
 * ── 两类断言，缺一不可 ─────────────────────────────────────────────
 *
 *   1. 负向：新账号第 2 条消息被拒、冷却期传附件被拒
 *   2. **正向**：等过间隔后能继续发言
 *
 * 第 2 类是必需的。如果 `isStaff` 传反了、或者阶段判断写错导致**所有人**
 * 都被拦，只有负向断言的脚本会 100% 通过 —— 那正是"全站坏掉但测试全绿"
 * 的经典陷阱。
 *
 * ── 关于注册限流 ───────────────────────────────────────────────────
 *
 * 每次运行会注册 1 个新账号（新人限流只能对真新账号生效，绕不开）。
 * 注册接口限流为 5 次/小时/IP，而 verify-attachments.mjs 每次要注册 2 个，
 * 所以**一小时内跑一轮完整验证是安全的，跑两轮就会撞 429**。
 * 撞到时脚本会明确说明原因，而不是让你以为是新人限流出了问题。
 *
 * 留下的垃圾账号（`%@newuser.test`）与垃圾消息需在上线前清理，
 * 与 `%@atch.test` 一并处理。
 */
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.NEWUSER_TIMEOUT_MS ?? 8000)
/** 冷却期的发言间隔是 30 秒，等过它才能证明"是延迟而不是永久封禁" */
const WAIT_MS = Number(process.env.NEWUSER_WAIT_MS ?? 31_000)
const SKIP_WAIT = process.env.NEWUSER_SKIP_WAIT === '1'

const results = []
const warnings = []

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

/** 最小合法 PNG（1x1 透明），避免依赖外部文件 */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
}

async function postMessage(cookie, channelId, content) {
  const res = await tfetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ channel_id: channelId, content }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
}

async function uploadPng(cookie, messageId, tag) {
  const form = new FormData()
  form.set('message_id', String(messageId))
  form.set('file', new File([tinyPng()], `${tag}.png`, { type: 'image/png' }))
  const res = await tfetch(`${BASE}/api/attachments`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
}

async function main() {
  const stamp = Date.now().toString(36)
  console.log(`\x1b[1m新人限流验证\x1b[0m  BASE_URL=${BASE}  运行 ${new Date().toISOString()}`)

  // ── 1. 拿一个频道 ────────────────────────────────────────────────
  section('1. 选取目标频道')
  const channelsRes = await tfetch(`${BASE}/api/channels`)
  const { channels } = await channelsRes.json()
  const channel = channels.find((c) => c.type === 'text' && !c.read_only)
  if (!channel) {
    record('找到可写频道', false, '没有 type=text 且非只读的频道')
    return finish()
  }
  record('找到可写频道', true, `#${channel.slug}`)

  // ── 2. 注册一个真·新账号 ─────────────────────────────────────────
  section('2. 注册新账号（只有真新账号才在冷却期）')
  const handle = `nu${stamp}`.slice(0, 32)
  const email = `${handle}@newuser.test`
  const password = `Nu!${stamp}Aa9`

  const regRes = await tfetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, email, password }),
  })
  const newCookie = getCookie(regRes)

  if (regRes.status === 429) {
    record(
      '注册新账号',
      false,
      '注册接口限流（5 次/小时/IP）。这不是新人限流的问题：verify-attachments 每次占 2 个名额，' +
        '一小时跑两轮就会用满。稍后重试，或用 BASE_URL 指向另一个环境。',
    )
    return finish()
  }
  if (regRes.status !== 201 || !newCookie) {
    const body = await regRes.json().catch(() => ({}))
    record('注册新账号', false, `HTTP ${regRes.status}${body?.error ? `：${body.error}` : ''}`)
    return finish()
  }
  record('注册新账号', true, `${handle}（账号年龄 ≈ 0，必定处于冷却期）`)

  // ── 3. 冷却期：发言间隔 ──────────────────────────────────────────
  section('3. 冷却期发言间隔（负向断言）')

  const first = await postMessage(newCookie, channel.id, `新人限流验证 ${stamp} 第 1 条`)
  record('第 1 条消息放行', first.status === 201, `HTTP ${first.status}`)

  const second = await postMessage(newCookie, channel.id, `新人限流验证 ${stamp} 第 2 条`)
  record('紧接着的第 2 条被拒', second.status === 429, `HTTP ${second.status}`)
  record(
    '拒绝码是 new_user_limited（与普通 rate_limited 区分开）',
    second.body?.code === 'new_user_limited',
    `code=${second.body?.code}`,
  )
  record(
    '拒绝信息包含具体等待时间（不能只说"过于频繁"）',
    typeof second.body?.error === 'string' && /30 秒/.test(second.body.error),
    second.body?.error ? `「${second.body.error}」` : '（无 error 字段）',
  )
  record(
    '带 Retry-After 响应头（供客户端倒计时）',
    second.retryAfter !== null && Number(second.retryAfter) > 0,
    `Retry-After=${second.retryAfter}`,
  )

  // ── 4. 冷却期：附件全禁 ──────────────────────────────────────────
  section('4. 冷却期禁止附件')
  const msgId = first.body?.message?.id
  if (!msgId) {
    record('取得消息 id 用于附件测试', false, '第 1 条消息未返回 id')
  } else {
    const up = await uploadPng(newCookie, msgId, `nu${stamp}`)
    record('冷却期上传附件被拒', up.status === 429, `HTTP ${up.status}`)
    record(
      '拒绝码是 new_user_blocked（完全禁止，不是额度用尽）',
      up.body?.code === 'new_user_blocked',
      `code=${up.body?.code}`,
    )
    record(
      '提示里给出还需等待多久',
      typeof up.body?.error === 'string' && /还需/.test(up.body.error),
      up.body?.error ? `「${up.body.error}」` : '（无 error 字段）',
    )
  }

  // ── 5. 正向控制：等过间隔后必须能继续发言 ────────────────────────
  section('5. 正向控制（防止"全站都被拦"却测不出来）')
  if (SKIP_WAIT) {
    record('等待间隔结束', false, '被 NEWUSER_SKIP_WAIT=1 跳过 —— 正向断言未执行', true)
    warnings.push('跳过正向控制')
  } else {
    console.log(`\x1b[2m  等待 ${Math.round(WAIT_MS / 1000)}s 让发言间隔过期…\x1b[0m`)
    await new Promise((r) => setTimeout(r, WAIT_MS))
    const third = await postMessage(newCookie, channel.id, `新人限流验证 ${stamp} 第 3 条`)
    record(
      '等过 30 秒间隔后可以继续发言（是延迟，不是封禁）',
      third.status === 201,
      `HTTP ${third.status}${third.body?.error ? `：${third.body.error}` : ''}`,
    )
  }

  // ── 6. 老账号对照：台阶确实不同 ──────────────────────────────────
  //
  // 用一个既有账号（smokea）证明"限制是按账号年龄分级的"，而不是所有账号
  // 一律 30 秒。
  //
  // ★ 但它可能恰好也在冷却期 ★
  // 刚部署完的环境里，所有账号都是新建的，对照账号同样是 cooldown。
  // 那种情况下**没有**可对比的台阶，这是环境状态而不是代码缺陷 ——
  // 所以记为警告并说明原因，而不是报失败（报失败会让人去追一个不存在的 bug）。
  section('6. 老账号对照（需要 SMOKE_PASSWORD）')
  const smokePassword = process.env.SMOKE_PASSWORD
  if (!smokePassword) {
    record(
      '老账号对照',
      false,
      '未设置 SMOKE_PASSWORD，跳过（容器内运行时 compose 会自动注入）',
      true,
    )
    warnings.push('未做老账号对照')
  } else {
    const loginRes = await tfetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke-a@smoke.test', password: smokePassword }),
    })
    const oldCookie = getCookie(loginRes)
    if (!oldCookie) {
      const body = await loginRes.json().catch(() => ({}))
      record(
        '登录 smokea 作为对照',
        false,
        `HTTP ${loginRes.status}${body?.error ? `：${body.error}` : ''}（账号还不存在时用 npm run smoke 创建）`,
        true,
      )
      warnings.push('对照账号不可用')
    } else {
      const a = await postMessage(oldCookie, channel.id, `新人限流对照 ${stamp} A`)
      const b = await postMessage(oldCookie, channel.id, `新人限流对照 ${stamp} B`)
      record('对照账号第 1 条放行', a.status === 201, `HTTP ${a.status}`)

      if (b.status === 201) {
        record(
          '对照账号不受新人策略约束（trust_level=1 或已过 24 小时）',
          true,
          'established',
        )
        // 说清这里**没有**覆盖什么：夹具被 db:seed 设为 trust_level=1 之后，
        // 爬坡期（10 秒间隔 / 20 条每小时）就不再能从这个脚本观察到了。
        // 那部分由 scripts/test-trust.mjs 用注入时钟精确覆盖，包括边界毫秒。
        record(
          '爬坡期阈值改由单元测试覆盖',
          true,
          'test-trust.mjs 注入假时钟，比等 10 分钟更精确',
        )
      } else if (b.body?.code === 'new_user_limited' && /10 秒/.test(b.body.error ?? '')) {
        record(
          '对照账号处于爬坡期，间隔 10 秒 ≠ 新人的 30 秒（证明按年龄分级）',
          true,
          `「${b.body.error}」`,
        )
      } else if (b.body?.code === 'new_user_limited' && /30 秒/.test(b.body.error ?? '')) {
        record(
          '对照账号也在冷却期，本次无法对比台阶',
          false,
          '全新部署的正常现象（所有账号都未满 10 分钟）。10 分钟后再跑即可看到台阶差异',
          true,
        )
        warnings.push('无台阶可对比')
      } else {
        record('对照账号第 2 条的行为可解释', false, `HTTP ${b.status} code=${b.body?.code}`)
      }

      // 附件在爬坡期/established 是允许的（只有冷却期全禁）。
      //
      // 刻意复用第 1 条消息（a）而不是新建一条：b 刚刚因为间隔被拒，
      // 紧接着再发一条必然也 429，那样就测不到附件本身了。
      // 附件接口只要求"消息属于自己"，复用完全合法。
      //
      // 可能撞上 5 个/小时配额 —— 那是配额用尽、不是功能坏了，记为警告。
      const msgId = a.body?.message?.id
      if (!msgId) {
        record('取得对照账号的消息 id', false, '第 1 条未返回 id', true)
        warnings.push('未能验证附件放行')
      } else {
        const up = await uploadPng(oldCookie, msgId, `ctrl${stamp}`)
        if (up.status === 201) {
          record('非冷却期允许上传附件（对照冷却期的全禁）', true, `HTTP ${up.status}`)
        } else if (up.body?.code === 'new_user_blocked') {
          record(
            '对照账号也在冷却期，附件同样被禁 —— 与冷却期结论一致',
            true,
            '环境状态，非缺陷',
          )
        } else if (up.body?.code === 'new_user_limited') {
          record(
            '非冷却期附件额度',
            false,
            `配额可能已被此前的验证跑用尽：${up.body.error}`,
            true,
          )
          warnings.push('附件配额用尽，未能验证放行')
        } else {
          record('非冷却期上传附件', false, `HTTP ${up.status} code=${up.body?.code}`)
        }
      }
    }
  }

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
    console.log('\n\x1b[33m警告项：\x1b[0m')
    for (const w of warned) console.log(`  ! ${w.name}${w.detail ? ` — ${w.detail}` : ''}`)
  }

  if (failed.length === 0) {
    // 有警告项时不能宣称"全部覆盖" —— 警告的含义正是"有一块没验证到"。
    // 测试脚本最容易犯的错就是把自己的盲区报告成绿灯。
    if (warned.length === 0) {
      console.log('\n\x1b[32m新人限流已生效，且未误伤老账号。\x1b[0m')
    } else {
      console.log(
        `\n\x1b[32m新人限流已生效。\x1b[0m\x1b[33m 但有 ${warned.length} 项未覆盖（见上），不要当作"全绿"。\x1b[0m`,
      )
    }
  }

  console.log(
    '\n\x1b[2m提示：本次留下了 1 个 %@newuser.test 账号与若干测试消息，上线前需清理。\x1b[0m',
  )

  // Windows 上 process.exit() 会在 undici 仍持有 keep-alive 连接时触发 libuv 断言，
  // 把"有失败项(1)"伪装成"程序崩溃"。设 exitCode 后交给事件循环排空。
  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('\n\x1b[31m脚本异常终止：\x1b[0m', err)
  process.exitCode = 1
})
