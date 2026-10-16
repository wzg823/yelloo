/**
 * 管理后台的端到端验证 —— 打真实 HTTP 接口。
 *
 * 用法（在 app 容器内跑）：
 *     docker compose exec -T app node scripts/verify-admin.mjs
 *
 * 管理员专属的部分需要额外的两个环境变量（见 docs/DEPLOY.md）：
 *     docker compose exec -T -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... \
 *       app node scripts/verify-admin.mjs
 * 未提供时会**跳过**那几节并记警告 —— 跳过不等于通过。
 *
 * 依赖 db:seed 建好的夹具：smokea / smokeb（普通成员）、smokem（版主）。
 *
 * ── 这份验证最想钉住的三件事 ─────────────────────────────────────────
 *
 * 1. **越权**：每个管理接口都要用普通成员与未登录各打一遍。
 *    "少判一个接口"就是整站后门，而它不会自己暴露出来。
 *
 * 2. **横向提权**：版主不能禁言另一个版主、不能碰管理员。
 *    这条只有等级关系（admin-policy.ts）挡得住，位运算挡不住。
 *
 * 3. **封禁立即生效**：封禁不只是写一个字段 —— 已登录的会话必须**当场失效**，
 *    而且重新登录也要被拒。否则"封了但人还在发帖"是最难解释的故障。
 */
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 8000)

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

async function main() {
  const stamp = Date.now().toString(36)
  console.log(`\x1b[1m管理后台验证\x1b[0m  BASE=${BASE}`)

  const password = process.env.SMOKE_PASSWORD
  if (!password) {
    console.error(
      '\n\x1b[31m✗ 缺少环境变量 SMOKE_PASSWORD\x1b[0m\n\n' +
        '  本脚本用 db:seed 建好的夹具账号登录（smokea / smokeb / smokem）。\n',
    )
    process.exitCode = 2
    return
  }

  const adminEmail = process.env.ADMIN_EMAIL
  const adminPassword = process.env.ADMIN_PASSWORD
  const hasAdminCreds = Boolean(adminEmail && adminPassword)

  // ── 1. 登录四种身份 ────────────────────────────────────────────
  section('1. 准备身份')
  let member, memberB, mod, admin
  try {
    const a = await login('smoke-a@smoke.test', password)
    const b = await login('smoke-b@smoke.test', password)
    const m = await login('smoke-m@smoke.test', password)
    if (!a.cookie || !b.cookie || !m.cookie) {
      throw new Error(
        `夹具登录失败（smokea=${a.status} smokeb=${b.status} smokem=${m.status}）` +
          '，先执行 npm run db:seed',
      )
    }
    member = a.cookie
    memberB = b.cookie
    mod = m.cookie
    record('登录夹具账号', true, 'smokea / smokeb（成员）、smokem（版主）')
  } catch (err) {
    record('登录夹具账号', false, err.message)
    return finish()
  }

  if (hasAdminCreds) {
    const r = await login(adminEmail, adminPassword)
    if (r.cookie) {
      admin = r.cookie
      record('登录管理员账号', true, adminEmail)
    } else {
      record('登录管理员账号', false, `HTTP ${r.status}：${r.body?.error ?? ''}`, true)
      warnings.push('管理员凭据无效，管理员专属断言未执行')
    }
  } else {
    record(
      '登录管理员账号',
      false,
      '未提供 ADMIN_EMAIL / ADMIN_PASSWORD，管理员专属断言将跳过',
      true,
    )
    warnings.push('未提供管理员凭据')
  }

  // 取一个可写频道
  const { body: chanBody } = await call('/api/channels')
  const channel = (chanBody.channels ?? []).find((c) => c.type === 'text' && !c.read_only)
  if (!channel) {
    record('找到可写频道', false, '没有可用频道')
    return finish()
  }

  // ── 2. 越权：管理接口必须挡住普通成员与游客 ────────────────────
  section('2. 越权防护（每个管理接口都要挡）')

  const adminEndpoints = [
    ['GET', '/api/admin/reports'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/channels'],
    ['GET', '/api/admin/audit'],
  ]

  for (const [method, path] of adminEndpoints) {
    const anon = await call(path, { method })
    const asMember = await call(path, { method, cookie: member })
    record(
      `${method} ${path} 游客 401 / 成员 403`,
      anon.status === 401 && asMember.status === 403,
      `游客 ${anon.status}，成员 ${asMember.status}`,
    )
  }

  {
    // 写接口同样要挡（读被挡不代表写被挡 —— 它们是分开的代码路径）
    const cases = [
      ['PATCH', '/api/admin/users/1', { action: 'mute', duration: '1h' }],
      ['POST', '/api/admin/reports/1', { action: 'resolve' }],
      ['POST', '/api/admin/channels', { name: 'x', slug: 'x-test' }],
      ['PATCH', '/api/admin/channels/1', { archived: true }],
    ]
    let allBlocked = true
    const detail = []
    for (const [method, path, body] of cases) {
      const r = await call(path, { method, cookie: member, body })
      detail.push(`${path}=${r.status}`)
      if (r.status !== 403) allBlocked = false
    }
    record('写接口对普通成员一律 403', allBlocked, detail.join(' '))
  }

  {
    // 版主：能看举报/用户/审计，但**不能**管频道（那是站长的决定）
    const reports = await call('/api/admin/reports', { cookie: mod })
    const users = await call('/api/admin/users', { cookie: mod })
    const audit = await call('/api/admin/audit', { cookie: mod })
    record(
      '版主可以看举报队列',
      reports.status === 200 && Array.isArray(reports.body?.reports),
      `HTTP ${reports.status}`,
    )
    record('版主可以看用户列表', users.status === 200, `HTTP ${users.status}`)
    record('版主可以看审计日志', audit.status === 200, `HTTP ${audit.status}`)

    const channels = await call('/api/admin/channels', { cookie: mod })
    record(
      '版主**不能**管理频道（仅管理员）',
      channels.status === 403,
      `HTTP ${channels.status}`,
    )
  }

  // ── 3. 举报流程 ────────────────────────────────────────────────
  section('3. 举报流程')

  const created = await call('/api/messages', {
    method: 'POST',
    cookie: memberB,
    body: { channel_id: channel.id, content: `管理验证用消息 ${stamp}` },
  })
  const messageId = created.body?.message?.id
  if (!messageId) {
    record('被举报的消息创建成功', false, `HTTP ${created.status}`)
    return finish()
  }
  record('被举报的消息创建成功', true, `id=${String(messageId).slice(-8)}`)

  let reportId = null
  {
    const r = await call('/api/reports', {
      method: 'POST',
      cookie: member,
      body: { target_type: 'message', message_id: messageId, reason: '这是自动化验证的举报' },
    })
    reportId = r.body?.id ?? null
    record('成员可以举报消息', r.status === 201 && Boolean(reportId), `HTTP ${r.status}`)
  }

  {
    const dup = await call('/api/reports', {
      method: 'POST',
      cookie: member,
      body: { target_type: 'message', message_id: messageId, reason: '重复举报' },
    })
    record(
      '同一人重复举报被合并（不刷满队列）',
      dup.status === 200 && dup.body?.deduplicated === true,
      `HTTP ${dup.status} deduplicated=${dup.body?.deduplicated}`,
    )
  }

  {
    // 别人举报同一条消息是**重要信号**，不该被合并
    const other = await call('/api/reports', {
      method: 'POST',
      cookie: mod,
      body: { target_type: 'message', message_id: messageId, reason: '另一个人也举报' },
    })
    record(
      '不同人举报同一条消息不会被合并',
      other.status === 201,
      `HTTP ${other.status}`,
    )
  }

  {
    const self = await call('/api/reports', {
      method: 'POST',
      cookie: memberB,
      body: { target_type: 'message', message_id: messageId, reason: '举报自己' },
    })
    record('不能举报自己的消息', self.status === 400, `HTTP ${self.status} code=${self.body?.code}`)
  }

  {
    const tooShort = await call('/api/reports', {
      method: 'POST',
      cookie: member,
      body: { target_type: 'message', message_id: messageId, reason: 'x' },
    })
    record(
      '理由过短被拒（防一键刷队列）',
      tooShort.status === 400 && tooShort.body?.code === 'reason_too_short',
      `HTTP ${tooShort.status} code=${tooShort.body?.code}`,
    )
  }

  {
    const anon = await call('/api/reports', {
      method: 'POST',
      body: { target_type: 'message', message_id: messageId, reason: '游客举报' },
    })
    record('游客不能举报（401）', anon.status === 401, `HTTP ${anon.status}`)
  }

  {
    const list = await call('/api/admin/reports?status=open', { cookie: mod })
    const mine = (list.body?.reports ?? []).find((r) => r.id === reportId)
    record('举报出现在队列里', Boolean(mine), `open=${list.body?.open_count}`)
    record(
      '队列带出了被举报消息的正文与作者（审核要能直接判断）',
      Boolean(mine?.message?.content?.includes(stamp) && mine?.message?.authorId),
      mine?.message?.content ? `「${mine.message.content.slice(0, 24)}…」` : '（无正文）',
    )
  }

  // ── 4. 处置：删消息 + 禁言 ─────────────────────────────────────
  section('4. 处置举报（删消息 + 禁言）')

  let memberBId = null
  {
    const users = await call('/api/admin/users?q=smokeb', { cookie: mod })
    memberBId = (users.body?.users ?? []).find((u) => u.handle === 'smokeb')?.id ?? null
    record('能在用户列表里找到被举报人', memberBId !== null, `id=${memberBId}`)
  }

  if (reportId && memberBId) {
    const handled = await call(`/api/admin/reports/${reportId}`, {
      method: 'POST',
      cookie: mod,
      body: {
        action: 'resolve',
        note: '自动化验证处置',
        delete_message: true,
        mute_user: '24h',
        reason: '自动化验证',
      },
    })
    record('版主处置举报成功', handled.status === 200, `HTTP ${handled.status}`)
    record(
      '报告了实际执行的动作',
      Array.isArray(handled.body?.applied) &&
        handled.body.applied.includes('delete_message') &&
        handled.body.applied.includes('mute_user'),
      JSON.stringify(handled.body?.applied ?? []),
    )

    const after = await call(`/api/channels/${channel.id}/messages?limit=20`)
    const msg = (after.body?.messages ?? []).find((m) => m.id === String(messageId))
    record('被举报的消息已变成墓碑', msg?.is_deleted === true)

    const userRow = await call(`/api/admin/users?q=smokeb`, { cookie: mod })
    const row = (userRow.body?.users ?? []).find((u) => u.handle === 'smokeb')
    record(
      '被举报人已被禁言',
      row?.status === 'muted' && Boolean(row?.mutedUntil),
      `status=${row?.status} until=${row?.mutedUntil}`,
    )

    // ★ 禁言必须真的拦住行为，而不只是改一个字段 ★
    const postWhileMuted = await call('/api/messages', {
      method: 'POST',
      cookie: memberB,
      body: { channel_id: channel.id, content: `禁言期间的消息 ${stamp}` },
    })
    record(
      '★ 禁言后确实发不了言（403 muted）',
      postWhileMuted.status === 403 && postWhileMuted.body?.code === 'muted',
      `HTTP ${postWhileMuted.status} code=${postWhileMuted.body?.code}`,
    )

    const reopen = await call(`/api/admin/reports/${reportId}`, {
      method: 'POST',
      cookie: mod,
      body: { action: 'resolve' },
    })
    record(
      '已处理的举报不能重复处理（409）',
      reopen.status === 409 && reopen.body?.code === 'already_handled',
      `HTTP ${reopen.status} code=${reopen.body?.code}`,
    )

    // 还原：否则下一次运行这个夹具就是禁言状态
    const restore = await call(`/api/admin/users/${memberBId}`, {
      method: 'PATCH',
      cookie: mod,
      body: { action: 'unmute' },
    })
    record('解除禁言（还原测试状态）', restore.status === 200, `HTTP ${restore.status}`)
  }

  // ── 5. 横向提权 ────────────────────────────────────────────────
  section('5. 横向提权防护（位运算挡不住的那一类）')

  if (memberBId) {
    const memberMute = await call(`/api/admin/users/${memberBId}`, {
      method: 'PATCH',
      cookie: member,
      body: { action: 'mute' },
    })
    record(
      '普通成员不能禁言别人（403，能力位拦住）',
      memberMute.status === 403,
      `HTTP ${memberMute.status} code=${memberMute.body?.code}`,
    )
  }

  {
    // 版主自己：不能对自己动手（防把自己锁在门外）
    const users = await call('/api/admin/users?q=smokem', { cookie: mod })
    const modId = (users.body?.users ?? []).find((u) => u.handle === 'smokem')?.id
    if (modId) {
      const self = await call(`/api/admin/users/${modId}`, {
        method: 'PATCH',
        cookie: mod,
        body: { action: 'mute', duration: '1h' },
      })
      record(
        '★ 版主不能禁言自己（防把自己锁在门外）',
        self.status === 403 && self.body?.code === 'self_target',
        `HTTP ${self.status} code=${self.body?.code}`,
      )
    }
  }

  if (hasAdminCreds && admin) {
    // 版主 vs 管理员：等级关系必须挡住，虽然双方"都有禁言能力"
    const users = await call('/api/admin/users?q=' + encodeURIComponent(adminEmail), {
      cookie: mod,
    })
    const adminId = (users.body?.users ?? []).find((u) => u.email === adminEmail)?.id
    if (adminId) {
      const up = await call(`/api/admin/users/${adminId}`, {
        method: 'PATCH',
        cookie: mod,
        body: { action: 'mute', duration: '1h' },
      })
      record(
        '版主不能禁言管理员（insufficient_rank）',
        up.status === 403 && up.body?.code === 'insufficient_rank',
        `HTTP ${up.status} code=${up.body?.code}`,
      )
    } else {
      record('找到管理员账号用于等级测试', false, '用户列表里查不到', true)
    }
  } else {
    record('版主 vs 管理员的等级测试', false, '未提供管理员凭据，跳过', true)
  }

  if (hasAdminCreds && admin && memberBId) {
    // ★ 与上面那条刻意区分开 ★
    // 上一节测的是"等级关系"（版主 → 管理员，被 insufficient_rank 拦住）；
    // 这一条测的是"能力位"（版主 → 普通成员，等级够但没 BAN_MEMBER）。
    // 两者都会返回 403，但拦住的**原因**不同 —— 只测一条的话，
    // 将来把能力位判断挪错位置也不会有任何断言失败。
    const banMemberAsMod = await call(`/api/admin/users/${memberBId}`, {
      method: 'PATCH',
      cookie: mod,
      body: { action: 'ban', duration: '7d' },
    })
    record(
      '★ 版主不能封禁普通成员（等级够，但没有 BAN_MEMBER 能力位）',
      banMemberAsMod.status === 403 && banMemberAsMod.body?.code === 'forbidden',
      `HTTP ${banMemberAsMod.status} code=${banMemberAsMod.body?.code}`,
    )
  }

  if (memberBId) {
    const role = await call(`/api/admin/users/${memberBId}`, {
      method: 'PATCH',
      cookie: mod,
      body: { action: 'set_role', role: 'member' },
    })
    record(
      '版主不能改角色（没有 MANAGE_ROLE）',
      role.status === 403,
      `HTTP ${role.status} code=${role.body?.code}`,
    )
  }

  // ── 6. 封禁立即生效 ────────────────────────────────────────────
  section('6. 封禁（必须在两个地方同时生效）')

  if (hasAdminCreds && admin && memberBId) {
    const ban = await call(`/api/admin/users/${memberBId}`, {
      method: 'PATCH',
      cookie: admin,
      body: { action: 'ban', duration: '7d', reason: '自动化验证' },
    })
    record('管理员可以封禁', ban.status === 200, `HTTP ${ban.status}`)

    // ★ 已登录的会话必须当场失效 ★
    const withOldSession = await call('/api/channels', { cookie: memberB })
    const withOldSessionPost = await call('/api/messages', {
      method: 'POST',
      cookie: memberB,
      body: { channel_id: channel.id, content: `封禁后 ${stamp}` },
    })
    record(
      '★ 封禁后旧会话立刻失效（无需等 Cookie 过期）',
      withOldSession.status === 200 && withOldSessionPost.status === 401,
      `读接口 ${withOldSession.status}（游客可读，正常）；发帖 ${withOldSessionPost.status}`,
    )

    // ★ 重新登录也要被拒 ★
    const relogin = await login('smoke-b@smoke.test', password)
    record(
      '★ 被封禁的账号无法重新登录（403 banned）',
      relogin.status === 403 && relogin.body?.code === 'banned',
      `HTTP ${relogin.status} code=${relogin.body?.code}`,
    )

    // 还原
    const unban = await call(`/api/admin/users/${memberBId}`, {
      method: 'PATCH',
      cookie: admin,
      body: { action: 'unban' },
    })
    record('解封成功', unban.status === 200, `HTTP ${unban.status}`)

    const after = await login('smoke-b@smoke.test', password)
    record('解封后可以重新登录', Boolean(after.cookie), `HTTP ${after.status}`)
    memberB = after.cookie ?? memberB
  } else {
    record('封禁生效验证', false, '需要管理员凭据，已跳过', true)
    warnings.push('封禁未验证')
  }

  // ── 7. 频道管理 ────────────────────────────────────────────────
  section('7. 频道管理')

  if (hasAdminCreds && admin) {
    const slug = `verify-${stamp}`
    let newChannelId = null

    const createdCh = await call('/api/admin/channels', {
      method: 'POST',
      cookie: admin,
      body: { name: `验证频道 ${stamp}`, slug, type: 'text', topic: '自动化验证' },
    })
    newChannelId = createdCh.body?.id ?? null
    record('管理员可以新建频道', createdCh.status === 201 && newChannelId !== null, `HTTP ${createdCh.status}`)

    const dup = await call('/api/admin/channels', {
      method: 'POST',
      cookie: admin,
      body: { name: '重名', slug },
    })
    record(
      'slug 重复被拒 409（给出可读提示而不是数据库约束名）',
      dup.status === 409 && dup.body?.code === 'slug_taken',
      `HTTP ${dup.status} code=${dup.body?.code}`,
    )

    const badSlug = await call('/api/admin/channels', {
      method: 'POST',
      cookie: admin,
      body: { name: '中文名', slug: '闲聊' },
    })
    record(
      '中文 slug 被拒并提示手填',
      badSlug.status === 400 && badSlug.body?.code === 'invalid_slug',
      `HTTP ${badSlug.status} code=${badSlug.body?.code}`,
    )

    const announce = await call('/api/admin/channels', {
      method: 'POST',
      cookie: admin,
      body: { name: `公告 ${stamp}`, slug: `ann-${stamp}`, type: 'announce', read_only: false },
    })
    record(
      '★ 新建 announce 频道时被强制只读（防止人人能在公告频道发言）',
      announce.status === 201 && announce.body?.channel?.read_only === true,
      `read_only=${announce.body?.channel?.read_only}`,
    )

    if (newChannelId) {
      const archive = await call(`/api/admin/channels/${newChannelId}`, {
        method: 'PATCH',
        cookie: admin,
        body: { archived: true },
      })
      record('归档频道', archive.status === 200, `HTTP ${archive.status}`)

      const publicList = await call('/api/channels')
      const stillVisible = (publicList.body?.channels ?? []).some((c) => c.slug === slug)
      record(
        '归档后不再出现在公开频道列表里',
        !stillVisible,
        stillVisible ? '仍然可见' : '已从侧栏消失',
      )

      const restore = await call(`/api/admin/channels/${newChannelId}`, {
        method: 'PATCH',
        cookie: admin,
        body: { archived: false, topic: '自动化验证（已还原）' },
      })
      record('取消归档', restore.status === 200, `HTTP ${restore.status}`)
    }
    if (announce.body?.id) {
      await call(`/api/admin/channels/${announce.body.id}`, {
        method: 'PATCH',
        cookie: admin,
        body: { archived: true },
      })
    }
  } else {
    record('频道管理验证', false, '需要管理员凭据，已跳过', true)
    warnings.push('频道管理未验证')
  }

  // ── 8. 审计留痕 ────────────────────────────────────────────────
  section('8. 审计留痕（每个写操作都要有）')

  {
    const audit = await call('/api/admin/audit?limit=200', { cookie: mod })
    const logs = audit.body?.logs ?? []
    const actions = new Set(logs.map((l) => l.action))

    record('审计接口可读', audit.status === 200 && logs.length > 0, `${logs.length} 条`)
    record('举报创建有留痕', actions.has('report.create'))
    record('举报处置有留痕', actions.has('report.resolve') || actions.has('report.dismiss'))
    record('禁言有留痕', actions.has('user.mute'))
    record('删消息有留痕（管理处置也算）', actions.has('message.delete'))

    const banLog = logs.find((l) => l.action === 'user.ban')
    if (hasAdminCreds && admin) {
      record(
        '封禁有留痕，且记录了经办人',
        Boolean(banLog?.actor?.handle),
        banLog ? `by ${banLog.actor?.handle}` : '（未找到 user.ban）',
      )
    }

    record(
      '审计带 IP（合规追溯需要）',
      logs.some((l) => typeof l.ip === 'string' && l.ip.length > 0),
    )

    const filtered = await call('/api/admin/audit?action=report.create&limit=10', { cookie: mod })
    record(
      '审计可按动作筛选',
      (filtered.body?.logs ?? []).every((l) => l.action === 'report.create'),
      `${(filtered.body?.logs ?? []).length} 条`,
    )
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
    console.log('\n\x1b[33m警告项（这些断言没有真正执行）：\x1b[0m')
    for (const w of warned) console.log(`  ! ${w.name}${w.detail ? ` — ${w.detail}` : ''}`)
  }

  if (failed.length === 0) {
    if (warned.length === 0) {
      console.log('\n\x1b[32m权限边界、横向提权防护、封禁生效与审计留痕均已验证。\x1b[0m')
    } else {
      console.log(
        `\n\x1b[32m已执行的部分全部通过。\x1b[0m\x1b[33m 但有 ${warned.length} 项未覆盖（见上），不要当作全绿。\x1b[0m`,
      )
    }
  }

  console.log('\n\x1b[2m提示：本次留下了举报单、审计记录与测试频道，上线前需清理。\x1b[0m')

  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('\n\x1b[31m脚本异常终止：\x1b[0m', err)
  process.exitCode = 1
})
