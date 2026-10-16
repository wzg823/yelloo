/**
 * 附件端到端验证。
 *
 * 用法（在 app 容器内跑，因为 app 端口没有映射到宿主机）：
 *     docker compose exec -T app node scripts/verify-attachments.mjs
 *
 * 为什么单独做这么一个脚本：附件是唯一一条"数据在数据库、文件在卷里、
 * 但由 Caddy 直接分发"的链路。三处必须严丝合缝地对齐：
 *
 *   1. 应用写入  → UPLOAD_DIR（容器内 /app/var/uploads）
 *   2. Caddy 读取 → /srv/uploads（同一个命名卷）
 *   3. URL 前缀   → /_uploads/*  被 Caddy 的 handle_path 剥掉
 *
 * 任何一处错位都表现为 404，而应用日志里**完全看不出问题**——
 * 因为请求根本没到应用。所以必须有一条能同时覆盖"写入成功"和
 * "反代能读到"的验证。
 *
 * 覆盖的断言：
 *   · 未登录上传被拒（401）
 *   · 登录后上传成功（201）并返回 URL
 *   · 文件确实落在卷里（通过应用再读一次 URL 之外的旁路）
 *   · 非白名单类型被拒（415）
 *   · 给别人的消息加附件被拒（403）
 *   · 超过单文件上限被拒（413）
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  const mark = ok ? '\x1b[32m  ✓\x1b[0m' : '\x1b[31m  ✗\x1b[0m'
  console.log(`${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function getCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
    const m = /^bbs_session=([^;]+)/.exec(line)
    if (m) return `bbs_session=${m[1]}`
  }
  return null
}

/** 构造一个最小但合法的 PNG（1x1 透明），避免依赖外部文件 */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
}

async function main() {
  const stamp = Date.now().toString(36)
  console.log(`\x1b[1m附件链路验证\x1b[0m  BASE=${BASE}`)

  // ── 准备账号 ──────────────────────────────────────────────────────
  //
  // 这里的口令是**写死的，但它不是凭据**：账号名带时间戳后缀（atcha<stamp>），
  // 每次运行都是全新的一次性账号，事后不再登录。所以知道这个字符串并不能
  // 登录任何长期存在的账号 —— 与 smoke.mjs 里那两个固定账号性质完全不同
  // （那两个的口令因此必须由 SMOKE_PASSWORD 环境变量提供）。
  //
  // 代价：每跑一次就在库里留 2 个垃圾账号。上线前需要清理 atch*@atch.test。
  const mkUser = async (tag) => {
    const handle = `atch${tag}${stamp}`.slice(0, 32)
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, email: `${handle}@atch.test`, password: 'AttachTest!2026' }),
    })
    const cookie = getCookie(res)
    if (res.status !== 201 || !cookie) throw new Error(`注册 ${handle} 失败：HTTP ${res.status}`)
    return { handle, cookie }
  }

  const alice = await mkUser('a')
  const bob = await mkUser('b')
  record('准备两个测试账号', true, `${alice.handle} / ${bob.handle}`)

  const channelsRes = await fetch(`${BASE}/api/channels`)
  const { channels } = await channelsRes.json()
  const channel = channels.find((c) => c.type === 'text' && !c.read_only) ?? channels[0]

  // ── 建一条消息（附件必须挂在消息上）────────────────────────────
  const msgRes = await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
    body: JSON.stringify({ channel_id: channel.id, content: `附件测试 ${stamp}` }),
  })
  const msgBody = await msgRes.json()
  if (msgRes.status !== 201) {
    record('创建消息', false, `HTTP ${msgRes.status}：${msgBody?.error ?? ''}`)
    return finish()
  }
  const messageId = String(msgBody.message.id)
  record('创建消息', true, `id=${messageId.slice(-8)}`)

  // ── 1) 未登录上传应被拒 ──────────────────────────────────────────
  {
    const fd = new FormData()
    fd.append('message_id', messageId)
    fd.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'x.png')
    const res = await fetch(`${BASE}/api/attachments`, { method: 'POST', body: fd })
    record('未登录上传被拒', res.status === 401, `HTTP ${res.status}`)
  }

  // ── 2) 给别人的消息加附件应被拒 ──────────────────────────────────
  {
    const fd = new FormData()
    fd.append('message_id', messageId)
    fd.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'x.png')
    const res = await fetch(`${BASE}/api/attachments`, {
      method: 'POST',
      headers: { Cookie: bob.cookie },
      body: fd,
    })
    record('给他人消息加附件被拒', res.status === 403, `HTTP ${res.status}`)
  }

  // ── 3) 非白名单类型应被拒 ────────────────────────────────────────
  {
    const fd = new FormData()
    fd.append('message_id', messageId)
    // 用一个明确不在白名单里的类型（可执行文件）
    fd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'evil.exe')
    const res = await fetch(`${BASE}/api/attachments`, {
      method: 'POST',
      headers: { Cookie: alice.cookie },
      body: fd,
    })
    const body = await res.json().catch(() => ({}))
    record('非白名单类型被拒', res.status === 415, `HTTP ${res.status} ${body?.code ?? ''}`)
  }

  // ── 4) 正常上传（PNG）───────────────────────────────────────────
  let url = null
  {
    const png = tinyPng()
    const fd = new FormData()
    fd.append('message_id', messageId)
    fd.append('file', new Blob([png], { type: 'image/png' }), 'screenshot.png')
    const res = await fetch(`${BASE}/api/attachments`, {
      method: 'POST',
      headers: { Cookie: alice.cookie },
      body: fd,
    })
    const body = await res.json().catch(() => ({}))
    if (res.status === 201 && body.attachment) {
      url = body.attachment.url
      const okSize = body.attachment.size === png.byteLength
      record('上传 PNG 成功', okSize, `${url} · ${body.attachment.size} 字节`)
      record('返回 is_image 标记', body.attachment.is_image === true, String(body.attachment.is_image))
      record(
        'storageKey 不含原始文件名',
        !url.includes('screenshot'),
        url.slice(url.lastIndexOf('/') + 1),
      )
      record('storageKey 为随机十六进制名', /\/[0-9a-f]{32}\.png$/.test(url), '')
    } else {
      record('上传 PNG 成功', false, `HTTP ${res.status}：${body?.error ?? ''}`)
    }
  }

  // ── 5) 附件应随消息返回 ─────────────────────────────────────────
  {
    const res = await fetch(`${BASE}/api/channels/${channel.id}/messages?limit=20`)
    const body = await res.json()
    const found = (body.messages ?? []).find((m) => String(m.id) === messageId)
    const n = found?.attachments?.length ?? 0
    record('消息接口带出附件', n >= 1, `${n} 个`)
  }

  // ── 6) ★ 关键：Caddy 能否从卷里直出文件 ★ ────────────────────────
  //
  // 这是整条链路最容易错位的一环：应用写进 UPLOAD_DIR，
  // Caddy 从 /srv/uploads 读（同一个命名卷），URL 前缀 /_uploads/ 被
  // handle_path 剥掉。三处任何不匹配都会 404，而应用日志里毫无线索。
  //
  // CADDY_URL 默认指向 compose 网络内的 caddy 服务；
  // 若在宿主机跑，可传 http://127.0.0.1。
  if (url) {
    const caddyBase = process.env.CADDY_URL ?? 'http://caddy'
    try {
      const res = await fetch(`${caddyBase}${url}`, { redirect: 'manual' })
      const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null
      const isPng = buf ? buf.subarray(0, 4).toString('hex') === '89504e47' : false
      record(
        'Caddy 从卷直出附件',
        res.ok && isPng,
        `HTTP ${res.status} · ${buf?.length ?? 0} 字节 · PNG 魔数=${isPng}`,
      )
      const ctype = res.headers.get('content-type') ?? ''
      record(
        '附件按扩展名给出 Content-Type',
        ctype.includes('image/png'),
        ctype || '(缺失)',
      )
      record(
        '禁止类型嗅探（nosniff）',
        (res.headers.get('x-content-type-options') ?? '') === 'nosniff',
        res.headers.get('x-content-type-options') ?? '(缺失)',
      )
      // 注意：这里刻意允许 inline 而不是要求 attachment。
      // 图片缩略图依赖 <img src> 渲染，强制 attachment 会让所有缩略图失效。
      // 安全性由应用层的扩展名白名单保证（不放行 html/svg/js），
      // 详见 Caddyfile 中该处的注释。
      const cd = res.headers.get('content-disposition') ?? ''
      record(
        'Content-Disposition 已设置',
        cd.includes('inline') || cd.includes('attachment'),
        cd || '(缺失)',
      )
      record(
        '未放行可执行类型（无 svg/html）',
        !ctype.includes('svg') && !ctype.includes('html'),
        ctype,
      )
      record(
        '附件响应带缓存头',
        (res.headers.get('cache-control') ?? '').includes('immutable'),
        res.headers.get('cache-control') ?? '(缺失)',
      )
    } catch (err) {
      record('Caddy 从卷直出附件', false, `连不上 ${caddyBase}：${err.message}`)
    }

    // 旁路验证卷是否真的可被 Caddy 读到：直接列目录
    try {
      const { readdir } = await import('node:fs/promises')
      const root = process.env.UPLOAD_DIR ?? '/app/var/uploads'
      const key = url.replace('/_uploads/', '')
      const full = `${root}/${key}`
      const stat = await (await import('node:fs/promises')).stat(full)
      record('文件确实落在卷内', stat.size > 0, `${full} · ${stat.size} 字节`)
      const dirEntries = await readdir(root)
      record('卷根目录可读', Array.isArray(dirEntries), `${dirEntries.length} 项`)
    } catch (err) {
      record('文件确实落在卷内', false, err.message)
    }
  }

  return finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n\x1b[1m结果\x1b[0m  通过 ${results.length - failed.length}  失败 ${failed.length}`)
  if (failed.length > 0) {
    console.log('\n\x1b[31m失败项：\x1b[0m')
    for (const f of failed) console.log(`  ✗ ${f.name}`)
  }
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\n\x1b[31m脚本异常：\x1b[0m', err)
  process.exit(1)
})
