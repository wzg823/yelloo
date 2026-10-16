/**
 * 编辑 / 删除消息的端到端验证 —— 打真实 HTTP 接口。
 *
 * 用法（在 app 容器内跑）：
 *     docker compose exec -T app node scripts/verify-messages.mjs
 *     docker compose exec -T -e CADDY_URL=http://caddy app node scripts/verify-messages.mjs
 *
 * 需要 db:seed 建好的三个夹具账号（口令来自 SMOKE_PASSWORD）：
 *   smokea  普通成员 —— 作者视角
 *   smokeb  普通成员 —— "别人"视角
 *   smokem  版主     —— 审核视角
 *
 * ── 这份验证重点盯三件事 ─────────────────────────────────────────────
 *
 * 1. **权限边界**（尤其是反直觉的那条）
 *    作者能改自己的；**版主不能改别人的**（只能删）。这条如果不测，
 *    很容易在后续重构里被"顺手放开"，而"管理能替人发言"是事后无法追查的。
 *
 * 2. **删除是真的删了**
 *    正文清空、附件记录删除、**附件文件从卷里消失**、搜索不再命中。
 *    只在前端隐藏不算删 —— 所以搜索这条断言必须有。
 *
 * 3. **幂等与冲突**
 *    重复删除不该报错（两个标签页同时点），已删除的消息不能再编辑。
 */
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
/** 附件文件是由 Caddy 直接从卷里分发的，验证"文件真的没了"必须经 Caddy */
const CADDY = (process.env.CADDY_URL ?? '').replace(/\/+$/, '')
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

function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
}

/** 统一的 JSON 调用：返回 {status, body, retryAfter} */
async function call(path, { method = 'GET', cookie, body, raw = false } = {}) {
  const init = { method, headers: {} }
  if (cookie) init.headers.Cookie = cookie
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await tfetch(`${BASE}${path}`, init)
  if (raw) return { status: res.status, body: await res.text(), retryAfter: null }
  const parsed = await res.json().catch(() => ({}))
  return {
    status: res.status,
    body: parsed,
    retryAfter: res.headers.get('retry-after'),
  }
}

async function login(email, password) {
  const res = await tfetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const cookie = getCookie(res)
  if (!cookie) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      `登录 ${email} 失败：HTTP ${res.status}${body?.error ? `：${body.error}` : ''}` +
        '（夹具不存在或口令不符时执行 npm run db:seed）',
    )
  }
  return cookie
}

async function main() {
  const stamp = Date.now().toString(36)
  console.log(`\x1b[1m编辑/删除验证\x1b[0m  BASE=${BASE}${CADDY ? `  CADDY=${CADDY}` : ''}`)

  const password = process.env.SMOKE_PASSWORD
  if (!password) {
    console.error(
      '\n\x1b[31m✗ 缺少环境变量 SMOKE_PASSWORD\x1b[0m\n\n' +
        '  本脚本用 db:seed 建好的夹具账号登录。\n' +
        '  夹具不存在时先执行：npm run db:seed（幂等）\n',
    )
    process.exitCode = 2
    return
  }

  // ── 1. 登录三个夹具 ─────────────────────────────────────────────
  section('1. 准备账号')
  let author, other, mod
  try {
    author = await login('smoke-a@smoke.test', password)
    other = await login('smoke-b@smoke.test', password)
    mod = await login('smoke-m@smoke.test', password)
    record('登录夹具账号', true, 'smokea（作者）/ smokeb（他人）/ smokem（版主）')
  } catch (err) {
    record('登录夹具账号', false, err.message)
    return finish()
  }

  // ── 2. 取频道 ──────────────────────────────────────────────────
  const { body: chanBody } = await call('/api/channels')
  const channel = (chanBody.channels ?? []).find((c) => c.type === 'text' && !c.read_only)
  if (!channel) {
    record('找到可写频道', false, '没有 type=text 且非只读的频道')
    return finish()
  }
  record('找到可写频道', true, `#${channel.slug}`)

  // ── 3. 作者建一条消息 ──────────────────────────────────────────
  section('2. 作者编辑自己的消息')
  // 用一个独特且与正文完全一致的标记，后面用它验证搜索
  const marker = `zzqq${stamp}`
  const created = await call('/api/messages', {
    method: 'POST',
    cookie: author,
    body: { channel_id: channel.id, content: marker },
  })
  const messageId = created.body?.message?.id
  if (created.status !== 201 || !messageId) {
    record('创建消息', false, `HTTP ${created.status}：${created.body?.error ?? ''}`)
    return finish()
  }
  record('创建消息', true, `id=${String(messageId).slice(-8)}`)

  // 搜索正向控制：删除之前必须能搜到
  {
    const { body: html } = await call(`/search?q=${encodeURIComponent(marker)}`, { raw: true })
    record(
      '删除前搜索能命中（后续断言的对照）',
      html.includes(`/m/${messageId}`),
      '没有这个正向控制，"删除后搜不到"可能只是因为搜索本来就不好用',
    )
  }

  const editedText = `${marker} 已编辑`
  const edit1 = await call(`/api/messages/${messageId}`, {
    method: 'PATCH',
    cookie: author,
    body: { content: editedText },
  })
  record('作者编辑自己的消息', edit1.status === 200, `HTTP ${edit1.status}`)
  record('返回的正文已更新', edit1.body?.message?.content_md === editedText)
  record(
    'content_html 同步更新（不是只改了 markdown 源）',
    typeof edit1.body?.message?.content_html === 'string' &&
      edit1.body.message.content_html.includes('已编辑'),
  )
  const firstEditedAt = edit1.body?.message?.edited_at
  record('edited_at 已写入', typeof firstEditedAt === 'string' && firstEditedAt.length > 0)

  // 持久化：重新拉一次频道消息，确认不是只在响应里改了
  {
    const { body } = await call(`/api/channels/${channel.id}/messages?limit=50`)
    const found = (body.messages ?? []).find((m) => m.id === String(messageId))
    record(
      '重新拉取后编辑已持久化',
      found?.content_md === editedText && found?.edited_at === firstEditedAt,
    )
  }

  // 原样保存不算一次修订：否则"打开编辑框又原样退出"会污染修订历史
  {
    const noop = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      cookie: author,
      body: { content: editedText },
    })
    record(
      '内容未变时不产生新修订（edited_at 不变）',
      noop.status === 200 && noop.body?.message?.edited_at === firstEditedAt,
      `edited_at=${noop.body?.message?.edited_at}`,
    )
  }

  // ── 4. 内容校验 ────────────────────────────────────────────────
  section('3. 内容校验')
  {
    const empty = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      cookie: author,
      body: { content: '   ' },
    })
    record(
      '空内容被拒 400',
      empty.status === 400 && empty.body?.code === 'empty_content',
      `HTTP ${empty.status} code=${empty.body?.code}`,
    )
  }
  {
    const tooLong = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      cookie: author,
      body: { content: 'x'.repeat(8001) },
    })
    record(
      '超长内容被拒 400',
      tooLong.status === 400 && tooLong.body?.code === 'content_too_long',
      `HTTP ${tooLong.status} code=${tooLong.body?.code}`,
    )
  }

  // ── 5. 权限边界 ────────────────────────────────────────────────
  section('4. 权限边界（含刻意设计的那条）')
  {
    const r = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      cookie: other,
      body: { content: '我改别人的' },
    })
    record(
      '普通成员不能编辑别人的消息',
      r.status === 403 && r.body?.code === 'not_author',
      `HTTP ${r.status} code=${r.body?.code}`,
    )
  }
  {
    const r = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      cookie: mod,
      body: { content: '版主改别人的' },
    })
    record(
      '★ 版主也不能编辑别人的消息（管理权是删除，不是改写）',
      r.status === 403 && r.body?.code === 'not_author',
      `HTTP ${r.status} code=${r.body?.code}`,
    )
  }
  {
    const r = await call(`/api/messages/${messageId}`, {
      method: 'DELETE',
      cookie: other,
    })
    record(
      '普通成员不能删除别人的消息',
      r.status === 403 && r.body?.code === 'not_author',
      `HTTP ${r.status} code=${r.body?.code}`,
    )
  }
  {
    const r = await call('/api/messages/999999999999999999', {
      method: 'PATCH',
      cookie: author,
      body: { content: 'x' },
    })
    record('编辑不存在的消息 404', r.status === 404, `HTTP ${r.status}`)
  }
  {
    const r = await call('/api/messages/not-a-number', {
      method: 'DELETE',
      cookie: author,
    })
    record('非法 id 被拒 400', r.status === 400, `HTTP ${r.status} code=${r.body?.code}`)
  }
  {
    const patch = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      body: { content: 'x' },
    })
    const del = await call(`/api/messages/${messageId}`, { method: 'DELETE' })
    record(
      '未登录编辑被拒 401',
      patch.status === 401,
      `HTTP ${patch.status}`,
    )
    record('未登录删除被拒 401', del.status === 401, `HTTP ${del.status}`)
  }

  // ── 6. 附件清理 ────────────────────────────────────────────────
  section('5. 删除时清理附件（记录 + 文件）')
  let attachmentUrl = null
  {
    const fd = new FormData()
    fd.append('message_id', String(messageId))
    fd.append('file', new File([tinyPng()], `del${stamp}.png`, { type: 'image/png' }))
    const res = await tfetch(`${BASE}/api/attachments`, {
      method: 'POST',
      headers: { Cookie: author },
      body: fd,
    })
    const body = await res.json().catch(() => ({}))
    if (res.status === 201 && body?.attachment?.url) {
      attachmentUrl = body.attachment.url
      record('上传附件用于删除测试', true, body.attachment.url)
    } else {
      record('上传附件用于删除测试', false, `HTTP ${res.status} code=${body?.code}`)
    }
  }

  if (attachmentUrl && CADDY) {
    const res = await tfetch(`${CADDY}${attachmentUrl}`)
    record('删除前附件可访问（正向控制）', res.status === 200, `HTTP ${res.status}`)
  } else if (attachmentUrl) {
    record(
      '删除前附件可访问',
      false,
      '未设置 CADDY_URL，跳过（附件由 Caddy 从卷直出，应用端口没有这个路由）',
      true,
    )
    warnings.push('未验证附件的 Caddy 直出')
  }

  // ── 7. 作者删除 ────────────────────────────────────────────────
  section('6. 作者删除自己的消息')
  const del = await call(`/api/messages/${messageId}`, { method: 'DELETE', cookie: author })
  record('作者删除成功', del.status === 200, `HTTP ${del.status}`)
  record('返回墓碑 is_deleted=true', del.body?.message?.is_deleted === true)
  record('墓碑正文为空（服务端就清空了，不是靠前端隐藏）', del.body?.message?.content_md === '')
  record(
    '报告清理了附件数量',
    typeof del.body?.removed_attachments === 'number' && del.body.removed_attachments >= 1,
    `removed_attachments=${del.body?.removed_attachments}`,
  )

  {
    const { body } = await call(`/api/channels/${channel.id}/messages?limit=50`)
    const found = (body.messages ?? []).find((m) => m.id === String(messageId))
    record(
      '重新拉取仍是墓碑（位置也还在，游标不会出现空洞）',
      found?.is_deleted === true && found?.content_md === '',
    )
    record(
      '附件记录已删除（attachment_count=0 且列表为空）',
      found?.attachment_count === 0 && (found?.attachments ?? []).length === 0,
      `attachment_count=${found?.attachment_count} attachments=${(found?.attachments ?? []).length}`,
    )
  }

  if (attachmentUrl && CADDY) {
    const res = await tfetch(`${CADDY}${attachmentUrl}`)
    record(
      '★ 附件文件已从卷里真正删除（HTTP 404）',
      res.status === 404,
      `HTTP ${res.status} —— 用户要求删除时，截图不该还留在磁盘上`,
    )
  }

  // 正文真的清空了：搜索不该再命中
  {
    const { body: html } = await call(`/search?q=${encodeURIComponent(marker)}`, { raw: true })
    record(
      '★ 删除后搜索不再命中（正文确实清空了）',
      !html.includes(`/m/${messageId}`),
      '只在 API 层过滤、库里留着原文的话，这条会失败',
    )
  }

  // ── 8. 幂等与冲突 ──────────────────────────────────────────────
  section('7. 幂等与冲突')
  {
    const again = await call(`/api/messages/${messageId}`, { method: 'DELETE', cookie: author })
    record(
      '重复删除是幂等的（两个标签页同时点不该报错）',
      again.status === 200 && again.body?.already_deleted === true,
      `HTTP ${again.status} already_deleted=${again.body?.already_deleted}`,
    )
  }
  {
    const r = await call(`/api/messages/${messageId}`, {
      method: 'PATCH',
      cookie: author,
      body: { content: '从墓碑里复活' },
    })
    record(
      '已删除的消息不能再编辑 409',
      r.status === 409 && r.body?.code === 'message_deleted',
      `HTTP ${r.status} code=${r.body?.code}`,
    )
  }

  // ── 9. 审核路径 ────────────────────────────────────────────────
  section('8. 版主删别人的消息')
  {
    const victim = await call('/api/messages', {
      method: 'POST',
      cookie: other,
      body: { channel_id: channel.id, content: `待处置 ${stamp}` },
    })
    const victimId = victim.body?.message?.id
    if (!victimId) {
      record('他人建消息用于审核测试', false, `HTTP ${victim.status}`)
    } else {
      const r = await call(`/api/messages/${victimId}`, { method: 'DELETE', cookie: mod })
      record('版主可以删除别人的消息', r.status === 200, `HTTP ${r.status}`)
      record('删除后同样变成墓碑', r.body?.message?.is_deleted === true)

      const { body } = await call(`/api/channels/${channel.id}/messages?limit=50`)
      const found = (body.messages ?? []).find((m) => m.id === String(victimId))
      record('重拉确认审核删除已生效', found?.is_deleted === true)
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
    if (warned.length === 0) {
      console.log('\n\x1b[32m编辑与删除均已生效，权限边界与清理行为符合预期。\x1b[0m')
    } else {
      console.log(
        `\n\x1b[32m主体功能正常。\x1b[0m\x1b[33m 但有 ${warned.length} 项未覆盖（见上）。\x1b[0m`,
      )
    }
  }

  console.log(
    '\n\x1b[2m提示：本次留下了若干测试消息与墓碑，上线前需清理。\x1b[0m',
  )

  // 与其它脚本一致：不用 process.exit()（Windows 上会在 undici 句柄未关时触发 libuv 断言）
  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('\n\x1b[31m脚本异常终止：\x1b[0m', err)
  process.exitCode = 1
})
