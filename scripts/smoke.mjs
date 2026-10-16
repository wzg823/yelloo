/**
 * 端到端验证脚本 —— SSE 实时推送与核心闭环。
 *
 * 用法（在服务器上或任何能访问站点的机器上跑）：
 *     node scripts/smoke.mjs
 *     BASE_URL=https://bbs.example.com node scripts/smoke.mjs
 *     BASE_URL=http://127.0.0.1:3000 node scripts/smoke.mjs
 *
 * 它回答四个问题，这四件事无法靠"打开页面看看"确认：
 *
 *   1. 用户能注册、频道能列出、消息能落库吗
 *   2. SSE 能建立连接吗（含跨源检查与 Cookie 鉴权）
 *   3. **「A 发的消息，B 能在 2 秒内收到吗」** ← 本项目的核心验收标准
 *   4. **心跳是否按时到达** ← 判断是否有中间层在缓冲 SSE
 *
 * 第 4 点尤其重要：中间层缓冲的表现是"功能看起来正常，但消息要等几十秒"，
 * 而它只在真实部署环境才会出现，本地开发永远看不到。
 *
 * 脚本自带清理意识：所有测试用户使用随机后缀，不会与你已有数据冲突；
 * 会在目标频道留下测试消息，跑完可自行删除。
 *
 * 依赖：仅 Node.js 内置能力（fetch / crypto），需要 Node >= 20
 */

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 5000)
const DELIVERY_BUDGET_MS = Number(process.env.SMOKE_DELIVERY_BUDGET_MS ?? 2000)
const HEARTBEAT_WAIT_MS = Number(process.env.SMOKE_HEARTBEAT_WAIT_MS ?? 40000)

const results = []
let warnings = 0

/**
 * 当前 SSE 客户端的引用 —— 模块级，让 `finish()` 也能关掉它。
 *
 * ★ 为什么必须这么做 ★
 *
 * 这个脚本刻意不用 `process.exit()`（原因见 `finish()` 的说明），
 * 于是**只要 SSE 流还开着，事件循环就永远不空，进程永不退出** ——
 * 表现为"打印完结果摘要后卡死"。
 *
 * 成功路径在 main() 末尾会 `sse.abort()`，所以看起来一切正常；
 * 但**任何提前失败**（比如第 5 步发消息被拒）都会直接 `return finish()`，
 * 根本走不到那行 abort。第一次实测就是这个现象：连跑 8 分钟不退出，
 * 而 `deploy.sh --smoke` 会因此永久挂住。
 */
let activeSse = null

function record(name, ok, detail, warn = false) {
  results.push({ name, ok, detail, warn })
  if (!ok && warn) warnings += 1
  const mark = ok ? (warn ? '\x1b[33m  !\x1b[0m' : '\x1b[32m  ✓\x1b[0m') : '\x1b[31m  ✗\x1b[0m'
  console.log(`${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/** 带超时的 fetch。没有超时的话，被中间层挂起的请求会永远卡住脚本 */
async function tfetch(input, init = {}, timeoutMs = TIMEOUT_MS) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseCookie(res) {
  // Node 的 fetch 用 getSetCookie()（Headers 标准扩展）
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
    const m = /^bbs_session=([^;]+)/.exec(line)
    if (m) return `bbs_session=${m[1]}`
  }
  const single = res.headers.get('set-cookie')
  const m = single ? /bbs_session=([^;]+)/.exec(single) : null
  return m ? `bbs_session=${m[1]}` : null
}

/**
 * 极简 EventSource 客户端。
 *
 * 刻意不用第三方库：这个脚本要能在裸 Node 上直接跑，
 * 不应该给服务器引入任何额外依赖。
 *
 * 每个 SSE 帧形如：
 *     event: message.created\n
 *     id: 123\n
 *     data: {...}\n
 *     \n
 * 注释行以 ':' 开头（我们的心跳就是这种），需要单独识别——
 * 它是判断"中间层有没有缓冲"的唯一信号。
 */
class SseClient {
  #controller = new AbortController()
  #handlers = new Map()
  #onComment = null
  #done = null

  constructor(url, cookie) {
    this.#done = (async () => {
      const res = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: this.#controller.signal,
      })

      if (!res.ok) throw new Error(`SSE 连接失败：HTTP ${res.status}`)
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('text/event-stream')) {
        throw new Error(`Content-Type 不是 text/event-stream，实际是 "${ct}"（中间层可能改写了响应）`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })

          // SSE 用空行分隔事件
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)

            const lines = raw.split('\n')
            let event = 'message'
            let id = null
            const dataLines = []
            let isComment = false

            for (const line of lines) {
              if (line.startsWith(':')) {
                isComment = true
                continue
              }
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('id:')) id = line.slice(3).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
            }

            if (isComment) {
              this.#onComment?.(raw)
              continue
            }

            const payload = dataLines.join('\n')
            let parsed = null
            try {
              parsed = payload ? JSON.parse(payload) : null
            } catch {
              /* 忽略无法解析的事件 */
            }
            const handler = this.#handlers.get(event)
            if (handler) handler({ event, id, data: parsed })
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
    })()
  }

  on(event, handler) {
    this.#handlers.set(event, handler)
    return this
  }

  onComment(handler) {
    this.#onComment = handler
    return this
  }

  ready() {
    return this.#done
  }

  abort() {
    this.#controller.abort()
  }
}

function parseJson(res) {
  return res.json().catch(() => null)
}

// ═══════════════════════════════════════════════════════════════════════
async function main() {
  const stamp = Date.now().toString(36)
  console.log(`\x1b[1m端到端验证\x1b[0m  BASE_URL=${BASE}  运行 ${new Date().toISOString()}`)

  // ── 1. 健康检查 ──────────────────────────────────────────────────────
  section('1. 健康检查')
  try {
    const t0 = Date.now()
    const res = await tfetch(`${BASE}/api/health`)
    const body = await parseJson(res)
    const ms = Date.now() - t0

    if (res.status === 200 && body?.checks?.database?.ok) {
      record('GET /api/health', true, `数据库 ${body.checks.database.ms}ms，总 ${ms}ms`)
      const rt = body.realtime
      if (rt) record('实时连接统计', true, `${rt.users} 用户 / ${rt.connections} 连接`)
    } else if (res.status === 503) {
      record('GET /api/health', false, `数据库不可用：${body?.checks?.database?.detail ?? '未知'}`)
      console.log('\n\x1b[31m数据库不可用，后续测试无法进行。先修数据库再重跑。\x1b[0m')
      return finish()
    } else {
      record('GET /api/health', false, `HTTP ${res.status}`)
    }
  } catch (err) {
    record('GET /api/health', false, err.message)
    console.log('\n\x1b[31m站点不可达。检查：服务是否启动、端口是否正确、防火墙是否放行。\x1b[0m')
    return finish()
  }

  // ── 2. 频道列表 ──────────────────────────────────────────────────────
  section('2. 频道列表')
  let channel = null
  try {
    const res = await tfetch(`${BASE}/api/channels`)
    const body = await parseJson(res)
    const list = body?.channels ?? []

    if (list.length === 0) {
      record('GET /api/channels', false, '没有任何频道')
      console.log('\n\x1b[31m没有频道。在服务器上执行 npm run db:seed 初始化数据。\x1b[0m')
      return finish()
    }

    // 优先用可写的 text 频道，避免选中只读的 #公告 导致发消息被拒
    channel =
      list.find((c) => c.type === 'text' && !c.read_only) ??
      list.find((c) => !c.read_only) ??
      list[0]

    record('GET /api/channels', true, `${list.length} 个频道，选用 #${channel.slug}（type=${channel.type}）`)
    if (channel.read_only) {
      record('可用写频道', false, `选中的 #${channel.slug} 是只读频道，后续发消息会失败`, true)
    }
  } catch (err) {
    record('GET /api/channels', false, err.message)
    return finish()
  }

  // ── 3. 取得两个测试用户（模拟两个浏览器）────────────────────────────
  //
  // ★ 先尝试登录固定账号，失败才注册 ★
  //
  // 早期版本每次运行都注册新账号（带时间戳后缀），有两个真实副作用：
  //   1. 每次部署都在库里留下一批 smoke* 用户，需要手工清理
  //   2. 同一 IP 连续跑几次就会撞上注册限流（每小时 5 次），
  //      表现为 429，看起来像"部署失败"，实际只是测试脚本自己把额度用完了
  // 所以固定账号 + 登录优先。
  section('3. 准备测试用户')

  // ★ 口令来自环境，不写死在仓库里 ★
  //
  // smokea / smokeb 是**长期存在的固定账号**（不是每次新建的一次性账号），
  // 所以写死在源码里等于把一把长期有效的钥匙提交进版本库。即使仓库是私有的，
  // 一旦转公开、加了协作者、或只是被 clone 到别处，它就已经泄露了。
  //
  // 未设置时报配置错误（退出码 2），而不是回退到某个默认口令 ——
  // 默认口令只会成为下一个泄露源，还会让"忘了配置"表现为"站点坏了"。
  const TEST_PASSWORD = process.env.SMOKE_PASSWORD
  if (!TEST_PASSWORD) {
    console.error(
      '\n\x1b[31m✗ 缺少环境变量 SMOKE_PASSWORD\x1b[0m\n\n' +
        '  smokea / smokeb 的口令不在源码里（避免把长期有效的凭据提交进仓库）。\n\n' +
        '  本机运行：    SMOKE_PASSWORD=<口令> npm run smoke\n' +
        '  容器内运行：  写在服务器 .env 的 SMOKE_PASSWORD，compose 会自动注入\n' +
        '  两个账号还不存在时：设好 .env 后直接跑，脚本会自动注册它们\n',
    )
    // ★ 用 exitCode + return，不用 process.exit() ★
    //
    // 在 Windows 上，此时 undici 还握着前几个请求留下的 keep-alive 连接，
    // 直接 process.exit() 会在 libuv 里触发断言：
    //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
    //     file src\win\async.c, line 76
    // 进程以 0xC0000409 崩溃退出，于是"配置错误(2)"被伪装成"程序崩溃"。
    // 设 exitCode 后正常返回，事件循环会在 keep-alive 超时后排空并干净退出。
    process.exitCode = 2
    return
  }

  /** 返回 cookie 或 null */
  async function loginOrRegister(tag) {
    const email = `smoke-${tag}@smoke.test`
    const handle = `smoke${tag}`

    // 先试登录
    try {
      const res = await tfetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: TEST_PASSWORD }),
      })
      const cookie = parseCookie(res)
      if (res.status === 200 && cookie) return { handle, cookie, reused: true }
    } catch {
      /* 落到注册分支 */
    }

    // 登录失败则注册。若已存在（409）说明密码不是我们预期的，
    // 明确报出来而不是静默失败——那通常意味着有人手工改过这个账号。
    try {
      const res = await tfetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle, email, password: TEST_PASSWORD }),
      })
      const cookie = parseCookie(res)
      const body = await parseJson(res)

      if (res.status === 201 && cookie) return { handle, cookie, reused: false }

      record(
        `取得测试用户 ${handle}`,
        false,
        `注册失败 HTTP ${res.status}${body?.error ? `：${body.error}` : ''}`,
      )
      return null
    } catch (err) {
      record(`取得测试用户 ${handle}`, false, err.message)
      return null
    }
  }

  const users = []
  for (const tag of ['a', 'b']) {
    const u = await loginOrRegister(tag)
    if (u) {
      users.push(u)
      record(
        `测试用户 ${u.handle}`,
        true,
        u.reused ? '已存在，直接登录' : '新注册',
      )
    }
  }

  if (users.length < 2) {
    console.log('\n\x1b[31m需要两个可登录用户才能验证实时推送。\x1b[0m')
    console.log('\x1b[2m常见原因：注册被限流（同 IP 每小时 5 次）、或邮箱/用户名格式被拒。\x1b[0m')
    return finish()
  }

  const [alice, bob] = users

  // ── 4. 建立 SSE 连接 ─────────────────────────────────────────────────
  section('4. SSE 连接')
  const received = []
  let serverCursor = null
  let heartbeatCount = 0
  let firstHeartbeatAt = null

  // 从"当前最大消息 id"起步：先问服务端要一个游标，避免把历史消息全推一遍
  let bootstrapCursor = '0'
  try {
    const res = await tfetch(`${BASE}/api/sync?since=0`, { headers: { Cookie: alice.cookie } })
    const body = await parseJson(res)
    bootstrapCursor = body?.cursor ?? '0'
  } catch {
    /* 拿不到就用 0，最多多收一点历史 */
  }

  const sse = new SseClient(
    `${BASE}/api/events?since=${encodeURIComponent(bootstrapCursor)}`,
    alice.cookie,
  )
  // 登记给 finish()，保证提前失败时也会被关闭（见 activeSse 的说明）
  activeSse = sse

  sse.onComment((raw) => {
    heartbeatCount += 1
    if (firstHeartbeatAt === null) firstHeartbeatAt = Date.now()
    void raw
  })

  sse.on('message.created', ({ id, data }) => {
    if (data?.message) received.push({ at: Date.now(), id, message: data.message })
  })

  sse.on('resync', ({ id, data }) => {
    if (data?.reason === 'ready') {
      // ★ 游标在 SSE 的 `id:` 行上，不在 payload 里 ★
      //
      // formatSse() 把 cursor 放在信封层（`id: <cursor>`），payload 只有
      // { reason, channels, heartbeat_ms, stats }。早期版本读的是 data.cursor，
      // 于是这里恒为 undefined —— 而下面的守卫写的是 `=== null`，
      // `undefined === null` 为 false，所以"10 秒内未收到握手"这条断言
      // 从来没生效过，测试一直显示通过。现在两处都修正。
      serverCursor = typeof id === 'string' && id.length > 0 ? id : null

      const cursorOk = serverCursor !== null && /^\d+$/.test(serverCursor)
      record(
        'SSE 握手完成',
        true,
        `可见频道 ${data.channels} 个，心跳 ${data.heartbeat_ms}ms`,
      )
      // 游标是 Last-Event-ID 断线补齐的起点：缺失或格式不对，
      // 重连时会静默丢消息（表现为"偶尔少几条"，极难复现）
      record(
        'SSE 握手携带游标',
        cursorOk,
        cursorOk ? `游标 ${serverCursor}` : `游标缺失或非纯数字：${JSON.stringify(serverCursor)}`,
      )
    } else {
      record(`服务端要求 resync（${data?.reason}）`, false, '背压或补齐失败', true)
    }
  })

  try {
    // 只等握手，不等整个流结束（它不会结束）
    await Promise.race([
      sse.ready().then(() => undefined),
      (async () => {
        // 给一个宽松的握手窗口
        // 用 `!serverCursor` 而不是 `=== null`：游标可能是 undefined/null/''，
        // 三者都意味着没拿到，`=== null` 只覆盖其中一种
        for (let i = 0; i < 100 && !serverCursor; i += 1) {
          await new Promise((r) => setTimeout(r, 100))
        }
      })(),
    ])

    if (!serverCursor) {
      record('SSE 握手完成', false, '10 秒内未收到携带游标的 ready 事件')
    }
  } catch (err) {
    record('SSE 连接', false, err.message)
    return finish()
  }

  // 未登录时必须被拒——这是鉴权是否真的生效的快速验证
  try {
    const res = await tfetch(`${BASE}/api/events`, {}, 3000)
    record('未登录访问 /api/events 被拒', res.status === 401, `HTTP ${res.status}`)
    await res.body?.cancel?.()
  } catch {
    record('未登录访问 /api/events 被拒', false, '请求异常', true)
  }

  // ── 5. 核心验收：跨用户实时投递 ──────────────────────────────────────
  section('5. 实时投递（核心验收）')
  const content = `smoke 端到端验证 ${stamp} ${new Date().toISOString()}`
  let sentAt = 0

  try {
    sentAt = Date.now()
    const post = (cookie) =>
      tfetch(`${BASE}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ channel_id: channel.id, content }),
      })

    let res = await post(bob.cookie)
    let body = await parseJson(res)

    // ★ 新人门卡可能拦下**测试账号自己** ★
    //
    // smokea / smokeb 是固定账号，但"固定"不等于"老"：全新部署之后第一次
    // 运行 smoke 时它们刚被创建，同样落在冷却期（30 秒间隔）/爬坡期（10 秒间隔）。
    // 表现就是"连续跑两次 smoke，第二次神秘失败"。
    //
    // 那不是缺陷 —— 反垃圾门卡由 scripts/verify-newuser.mjs 专门验证，
    // smoke 的职责是实时链路。所以这里按服务端给的等待时间重试一次，
    // 并明确打印原因，避免把预期行为当成故障去排查。
    if (res.status === 429 && body?.code === 'new_user_limited') {
      const waitMs = Math.min(
        Number(res.headers.get('retry-after') ?? 30) * 1000 + 500,
        35_000,
      )
      console.log(
        `\x1b[33m  !\x1b[0m 测试账号自身被新人限流拦住，等待 ${Math.round(waitMs / 1000)}s 后重试` +
          `\x1b[2m（预期行为：账号未满 24 小时；门卡本身由 verify-newuser.mjs 验证）\x1b[0m`,
      )
      await new Promise((r) => setTimeout(r, waitMs))
      sentAt = Date.now()
      res = await post(bob.cookie)
      body = await parseJson(res)
    }

    if (res.status !== 201) {
      record('B 发送消息', false, `HTTP ${res.status}：${body?.error ?? '未知错误'}`)
      return finish()
    }

    record('B 发送消息', true, `id=${String(body.message.id).slice(-8)}`)

    // 游标必须是纯数字的 Snowflake —— 验证 BigInt 序列化没有退化成科学计数法
    const idStr = String(body.message.id)
    record(
      '消息 ID 是完整 Snowflake 字符串',
      /^\d{15,20}$/.test(idStr),
      idStr,
    )
  } catch (err) {
    record('B 发送消息', false, err.message)
    return finish()
  }

  // 等 A 收到
  const deadline = sentAt + DELIVERY_BUDGET_MS
  let hit = null
  while (Date.now() < deadline) {
    hit = received.find((r) => r.message.content_md === content)
    if (hit) break
    await new Promise((r) => setTimeout(r, 50))
  }

  if (hit) {
    const latency = hit.at - sentAt
    record('A 实时收到 B 的消息', true, `端到端延迟 ${latency}ms`)
    record(
      `延迟在 ${DELIVERY_BUDGET_MS}ms 预算内`,
      latency < DELIVERY_BUDGET_MS,
      `${latency}ms`,
      latency >= DELIVERY_BUDGET_MS,
    )
  } else {
    record(
      'A 实时收到 B 的消息',
      false,
      `${DELIVERY_BUDGET_MS}ms 内未收到。若站点能正常刷新看到消息，问题在 SSE 链路`,
    )
  }

  // ── 6. 心跳（判断中间层是否缓冲）─────────────────────────────────────
  section('6. 心跳检测（中间层缓冲诊断）')
  console.log(
    `\x1b[2m  等待最多 ${Math.round(HEARTBEAT_WAIT_MS / 1000)}s 观察心跳。若一直等不到，说明有中间层在缓冲响应。\x1b[0m`,
  )

  const hbWaitStart = Date.now()
  while (heartbeatCount === 0 && Date.now() - hbWaitStart < HEARTBEAT_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 250))
  }

  if (heartbeatCount > 0) {
    const waited = firstHeartbeatAt ? firstHeartbeatAt - hbWaitStart : 0
    record('收到 SSE 心跳', true, `${heartbeatCount} 次，首次在 ${Math.round(waited / 1000)}s 后`)
    if (waited > 35000) {
      record('心跳及时', false, `首次心跳延迟 ${Math.round(waited / 1000)}s，疑似被缓冲`, true)
    } else {
      record('心跳及时', true, '中间层未发现缓冲迹象')
    }
  } else {
    record(
      '收到 SSE 心跳',
      false,
      `${Math.round(HEARTBEAT_WAIT_MS / 1000)}s 内一次都没有 —— 强烈提示中间层在缓冲响应`,
    )
    console.log(
      '\x1b[33m  排查方向：\x1b[0m\n' +
        '    · Caddyfile 里 /api/events 的 flush_interval 是否为 -1\n' +
        '    · 是否额外套了 CDN（Cloudflare 等需要对该路径关闭缓冲）\n' +
        '    · 反代是否为该路径关闭了 gzip\n' +
        '    详见 docs/EVENTS.md 第 7 节',
    )
  }

  // ── 7. 分页与鉴权 ────────────────────────────────────────────────────
  section('7. 分页与权限')

  try {
    const res = await tfetch(`${BASE}/api/channels/${channel.id}/messages?limit=5`)
    const body = await parseJson(res)
    const msgs = body?.messages ?? []
    const ordered = msgs.every((m, i) => i === 0 || String(msgs[i - 1].id) < String(m.id))
    record('历史消息接口（游客可读）', msgs.length > 0, `${msgs.length} 条`)
    record('返回结果按 id 升序', ordered, ordered ? '有序' : '顺序错误')
  } catch (err) {
    record('历史消息接口', false, err.message)
  }

  try {
    const res = await tfetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channel.id, content: 'should be rejected' }),
    })
    record('未登录发消息被拒', res.status === 401, `HTTP ${res.status}`)
  } catch (err) {
    record('未登录发消息被拒', false, err.message)
  }

  try {
    const res = await tfetch(`${BASE}/api/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
      body: JSON.stringify({ channel_id: channel.id, message_id: '0' }),
    })
    record('已读位点接口', res.ok, `HTTP ${res.status}`)
  } catch (err) {
    record('已读位点接口', false, err.message)
  }

  // ── 8. SEO 基础 ──────────────────────────────────────────────────────
  section('8. SEO 基础（公开技术社区的获客命脉）')

  for (const path of ['/robots.txt', '/sitemap.xml']) {
    try {
      const res = await tfetch(`${BASE}${path}`)
      const text = await res.text()
      const looksRight =
        res.ok &&
        (path === '/robots.txt'
          ? text.includes('Sitemap')
          : text.includes('<urlset') || text.includes('<sitemapindex'))
      record(`GET ${path}`, looksRight, `HTTP ${res.status}，${text.length} 字节`)
    } catch (err) {
      record(`GET ${path}`, false, err.message)
    }
  }

  try {
    const res = await tfetch(`${BASE}${channel.type === 'thread' ? '/' : `/c/${channel.slug}`}`)
    const html = await res.text()
    // 服务端渲染的判据：HTML 里必须已经有消息正文，而不是只有一个空壳
    const hasMessages = /class="msg/.test(html)
    record('频道页服务端渲染消息', hasMessages, hasMessages ? 'HTML 中含消息节点' : '未找到消息节点')
    record(
      '频道页含 canonical',
      html.includes('rel="canonical"') || html.includes('canonical'),
      '',
      !html.includes('canonical'),
    )
  } catch (err) {
    record('频道页渲染', false, err.message)
  }

  sse.abort()
  return finish()
}

function finish() {
  console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
  const passed = results.filter((r) => r.ok && !r.warn).length
  const failed = results.filter((r) => !r.ok && !r.warn)
  const warned = results.filter((r) => !r.ok && r.warn)

  console.log(`\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failed.length}  警告 ${warned.length}`)

  if (failed.length > 0) {
    console.log('\n\x1b[31m失败项：\x1b[0m')
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  if (warned.length > 0) {
    console.log('\n\x1b[33m警告项（不一定影响使用，但建议排查）：\x1b[0m')
    for (const w of warned) console.log(`  ! ${w.name}${w.detail ? ` — ${w.detail}` : ''}`)
  }

  if (failed.length === 0 && warned.length === 0) {
    console.log('\n\x1b[32m全部通过。核心闭环（注册 → 发消息 → 跨用户实时投递）已验证。\x1b[0m')
  } else if (failed.length === 0) {
    console.log('\n\x1b[32m无失败项。警告项建议在正式上线前处理。\x1b[0m')
  }

  console.log(
    '\n\x1b[2m提示：本次会向 #' +
      (process.env.SMOKE_CHANNEL_HINT ?? '目标') +
      ' 频道写入测试消息，可在管理后台或数据库清理。\x1b[0m',
  )

  // ★ 先关 SSE，再设退出码 ★
  //
  // 顺序很关键。这个脚本不用 process.exit()：在 Windows 上，undici 还握着
  // keep-alive 连接时调 process.exit() 会触发 libuv 断言
  //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
  // 进程以 0xC0000409 崩溃，于是"有 N 项失败(退出码 1)"被伪装成"程序崩溃"，
  // 正好把最有用的信息盖掉。
  //
  // 但**不调 process.exit() 就意味着必须自己把句柄关干净**：
  // SSE 是唯一的常驻连接，只要它还开着，事件循环就永远不空，进程永不退出。
  // 提前失败的路径走不到 main() 末尾的 abort()，所以这里必须兜底。
  try {
    activeSse?.abort?.()
  } catch {
    /* 已经关掉了 */
  }

  // 兜底：万一将来又引入什么常驻句柄，最多等 5 秒就强退。
  // unref() 让它自己不阻止退出 —— 正常路径毫秒级结束，异常路径被这 5 秒封顶。
  // 宁可退出码带一点噪音，也不能让 `deploy.sh --smoke` 永久挂住。
  const forceExit = setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 5000)
  forceExit.unref?.()

  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('\n\x1b[31m脚本异常终止：\x1b[0m', err)
  // 与 finish() 同样的两条：关掉 SSE，再设退出码（不用 process.exit()）
  try {
    activeSse?.abort?.()
  } catch {
    /* 已经关掉了 */
  }
  const forceExit = setTimeout(() => process.exit(1), 5000)
  forceExit.unref?.()
  process.exitCode = 1
})
