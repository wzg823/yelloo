# 实时事件契约（SSE）

对应代码：`src/lib/realtime/hub.ts`（服务端扇出）、`src/app/api/events/route.ts`（端点）、
`src/lib/useEventStream.ts`（客户端）。

---

## 1. 为什么是 SSE 而不是 WebSocket

这个社区只需要**服务端 → 客户端**单向推送。选 SSE 换来三件事：

| | SSE | WebSocket |
|---|---|---|
| 断线重连 | 浏览器原生实现，带指数退避 | 自己写 |
| 断线补齐 | 浏览器自动带 `Last-Event-ID` 头 | 自己设计重放协议 |
| 服务端实现 | 一个 `ReadableStream` | 需要握手、心跳、帧解析、连接管理 |
| 基础设施 | 普通 HTTP，任何反代都支持 | 需要反代显式升级配置 |

代价只有两个，都已处理：只能用文本（我们本来就传 JSON）、
以及**需要显式关闭中间层缓冲**（见第 7 节，这是最容易踩的坑）。

---

## 2. 一条连接，多路复用

```
客户端                     服务端
  │                          │
  │  GET /api/events         │
  │  ?since=<cursor>         │
  ├─────────────────────────►│
  │                          │ 1. 鉴权，取可见频道集合
  │                          │ 2. 注册到 hub（先注册，后补历史）
  │                          │ 3. 查库补发 id > since 的消息
  │  event: message.created  │
  │  id: 18446744073709551.. │
  │◄─────────────────────────┤
  │  event: resync (ready)   │
  │◄─────────────────────────┤ 4. 握手完成，切实时模式
  │                          │
  │  : hb 1735...            │ 5. 每 25s 心跳
  │◄─────────────────────────┤
```

**为什么每个用户只开一条连接**：浏览器对同源 HTTP/1.1 有 6 条连接上限。
若按频道各开一条 `EventSource`，用户切到第 7 个频道时，
页面上的普通请求（翻页、发消息、加载图片）会全部排队饿死。

服务端因此按"该用户可见的频道集合"过滤后推送。
该集合来自 `listVisibleChannelIds()`，**将来加私密频道时只改这一个函数**。

---

## 3. 游标语义

游标就是消息 ID（Snowflake，全局单调递增）。三种来源，优先级从高到低：

1. `Last-Event-ID` 请求头 —— 浏览器重连时自动带上，值为**最后成功收到的事件 id**
2. `?since=<cursor>` 查询参数 —— 首次连接或手动重连时使用
3. 都没有 → 不下发历史，由客户端自行拉频道首屏

服务端补齐逻辑（`/api/events`）：

```
cursor = since
循环最多 10 批，每批 200 条：
    取 id > cursor 的可见消息（按 id 升序）
    逐条下发 message.created
    cursor = 该批最后一条的 id
    不足 200 条 → 结束
```

**补齐期间不丢事件**的关键在于顺序：先 `registerSink()` 注册订阅，
再查库补历史。期间到达的实时事件进入 `pending` 队列，补齐结束后按序 flush。
若反过来（先补历史再注册），两步之间到达的消息会永久丢失——
这是实时系统里最典型的竞态，且只在有并发写入时偶发。

---

## 4. 事件类型与载荷

所有事件都是 SSE 帧：

```
event: <type>
id: <cursor>
data: <JSON>

```

| `event` | 触发时机 | `data` |
|---|---|---|
| `message.created` | 新消息落库后 | `{ message: PublicMessage }` |
| `message.updated` | 消息内容变化：编辑、或补充附件 | `{ message: PublicMessage }` |
| `message.deleted` | 软删除 | `{ message: PublicMessage }`（墓碑，正文已清空） |
| `channel.updated` | 频道改名/归档（P2） | `{ channel: {...} }` |
| `typing` | 有人正在输入（P3） | `{ channel_id, user_id }` |
| `resync` | 见下 | 见下 |

### ★ 变更事件不能走"新增"那条路径 ★

这是一个踩过的坑，写在这里以防回归。

`message.created` 与 `message.updated` / `message.deleted` 的载荷形状**完全相同**
（都是完整的 `PublicMessage`），看起来可以共用一个处理器 —— 但它们的归并语义
**正好相反**：

| 事件 | 归并规则 | 理由 |
|---|---|---|
| `message.created` | 按 id **去重**，没见过的才追加 | 同一条消息会从 SSE、降级轮询、断线补齐三条路径重复到达 |
| `message.updated` / `message.deleted` | 按 id **覆盖**，见过的必须替换 | 它的 id 一定已经见过——这正是它是"变更"的定义 |

早期版本共用一个回调，于是变更被 `if (seen.has(id)) continue` 无条件丢弃。
后果是：别人看不到你的编辑、看不到附件被补上、看不到消息被删除；
而连接状态还显示"实时已连接"，**从外部完全看不出问题**。

现在两边的实现分别在 `src/lib/message-list.ts` 的 `ingestCreated` 与
`applyMessageUpdate`，并由 `scripts/test-message-list.mjs` 钉住行为。

### 编辑与删除不在补齐范围内

补齐流是 `id > cursor` 的增量，而编辑与删除**不产生新的 id**，
所以断线期间发生的这类变更**不会**在重连补发。客户端必须自己兜：

- SSE 重连成功后：重取当前频道最后一页，按 id 覆盖（`onReconnected`）
- 降级轮询模式下：每 6 次轮询（约 30 秒）做一次同样的窗口刷新

不兜的话，那些消息会永远停在旧内容 —— 而这恰好是"看起来正常"的那类故障。

### `resync` 是一个多用途事件

它有三种 `reason`，客户端必须区分处理：

```jsonc
// (a) 握手完成。cursor 用于校准客户端本地游标
{ "reason": "ready", "channels": 7, "heartbeat_ms": 25000, "stats": {...} }

// (b) 背压：慢客户端的积压队列超限，服务端丢弃了积压
{ "reason": "backpressure", "max": 500 }

// (c) 补齐过程出错（数据库查询失败等）
{ "reason": "replay_failed" }
```

- (a) → 只更新游标，**不要**重拉页面
- (b)(c) → 调用 `onResync` 回调，通常做法是重新拉取当前频道最后一页并重建本地状态

### `PublicMessage` 形状

```jsonc
{
  "id": "18446744073709551617",   // 字符串！见 docs/DB.md 第 1.1 节
  "channel_id": 42,
  "thread_id": null,
  "reply_to_id": null,
  "author": {
    "id": 7, "handle": "alice", "display_name": "Alice",
    "avatar_url": null, "role": "member"
  },
  "kind": "text",
  "content_md": "原文",
  "content_html": "<p>渲染后</p>",   // 已软删除时为 null
  "is_deleted": false,
  "edited_at": null,
  "created_at": "2025-01-01T12:00:00.000Z",
  "attachment_count": 0,
  "reaction_count": 0
}
```

**`content_html` 由服务端生成且已转义**（`src/lib/markdown.ts` 是白名单式渲染器）。
前端直接 `dangerouslySetInnerHTML` 是安全的。**若将来换成第三方 Markdown 渲染器，
必须同时引入 HTML 消毒步骤**，否则就是一个存储型 XSS。

---

## 5. 背压

慢客户端（弱网、后台标签页）会让服务端的待发队列无界增长，最终 OOM。

处理策略：每个连接一个 `pending` 队列，上限 `SSE_MAX_BACKLOG`（默认 500）。

```
队列未满 → 入队，返回成功
队列已满 → 清空队列，下发 resync{reason:"backpressure"}，要求客户端重拉
```

为什么选"丢弃 + resync"而不是"无限缓冲"或"直接断开"：

- 无限缓冲 → 服务端内存泄漏，影响所有用户
- 直接断开 → 用户看到连接反复失败，体验更差
- 丢弃 + resync → 用户只看到一次短暂的重新加载，服务端内存有硬上限

---

## 6. 客户端行为（`useEventStream.ts`）

```
connect()
  ├─ new EventSource('/api/events?since=' + cursor)
  ├─ open         → status='live'，清零失败计数，停止轮询
  │                 非首次连接 → onReconnected()（重取窗口，兜住断线期间的编辑/删除）
  ├─ message.created          → onMessages：去重后追加，推进游标
  ├─ message.updated/deleted  → onUpdates ：按 id 覆盖，**不**推进游标
  ├─ resync       → reason 为 ready 则校准游标，否则触发重拉
  └─ error        → 主动 close，自己调度重连
                    连续失败 ≥ 3 次 → 启动 5 秒轮询兜底
                    重连延迟 2^n 秒，上限 30 秒
```

两个刻意的设计：

1. **`error` 时主动关闭而不是依赖浏览器的自动重连**。
   浏览器重连策略不可控，且它不区分"服务端 500"与"中间层拦截了
   `text/event-stream`"。自己调度才能实现"连续失败则降级"。
2. **游标放在 `useRef` 而不是 `useState`**。游标变化不应触发组件重渲染，
   更不应触发 `useEffect` 重连（那会导致"每收到一条消息就重连一次"的灾难）。

### 降级轮询

`GET /api/sync?since=<cursor>&limit=200`

```jsonc
{ "messages": [PublicMessage], "cursor": "18446744...", "has_more": true }
```

与 SSE 补齐共用 `listMessagesSince()`，因此**两条路径的数据形状完全一致**，
前端不需要分支处理。轮询模式下仍会持续尝试恢复 SSE（指数退避），
成功则自动切回。

> 轮询只返回**新增**消息（同样是 `id > cursor` 的增量），所以编辑与删除
> 不会随轮询到达。客户端每 6 次轮询（约 30 秒）重取一次可见窗口来兜住它
> （`POLLS_PER_WINDOW_REFRESH`）。见第 4 节"编辑与删除不在补齐范围内"。

---

## 7. 部署必须配合的设置（最容易踩的坑）

**症状**：一切正常，但消息要等 20~60 秒才出现。

**原因**：某个中间层在缓冲响应。SSE 是长连接，任何"攒够一个 buffer 再发"的行为
都会破坏实时性。

必须满足：

| 层 | 要求 |
|---|---|
| 应用 | 响应头带 `X-Accel-Buffering: no`（已在 `/api/events` 设置） |
| Caddy | `flush_interval -1`；`/api/events*` 不压缩（已配在 `Caddyfile`） |
| Nginx（若替代 Caddy） | `proxy_buffering off;` `proxy_cache off;` `proxy_read_timeout 3600s;` |
| Cloudflare（若加 CDN） | **必须对该路径关闭缓冲**，并把超时提到 100s 以上；免费版对长连接的默认行为会掐断 |
| 应用侧 | 心跳间隔（默认 25s）必须小于所有中间层的读超时 |

Caddy 里还有一处细节：对 `/api/events` 显式把 `Accept-Encoding` 设为 `identity`。
这比依赖 `encode` 指令的排除规则更可靠——直接从上游跳过压缩决策。

### 反代读超时必须置 0

`read_timeout 0` 不是笔误。流式响应没有"读完成"这一刻，
设了非零超时会导致长连接被定期误杀，表现为"每隔几分钟重连一次"。

---

## 8. 扩展到多实例

当前实现是**进程内** Map（`globalThis.__bbsHub`）。`next start` 默认单进程，
因此单机部署是正确的；但如果用 PM2 cluster 或 Node cluster 起多进程，
就会出现"用户连到 A 进程，消息从 B 进程发出"→ 用户收不到消息。

**扩展方案（不需要 Redis）**：

```ts
// publish 侧：写库后广播通知
await db.execute(sql`select pg_notify('bbs_events', ${JSON.stringify(envelope)})`)

// 每个实例启动时：
const listener = await pool.connect()
await listener.query('LISTEN bbs_events')
listener.on('notification', (msg) => hub.deliver(JSON.parse(msg.payload)))
```

改动范围只有 `src/lib/realtime/hub.ts` 里的 publish/deliver，**路由与前端零改动**。

两条约束：

1. **`NOTIFY` 载荷上限 8000 字节。** 因此只广播
   `{channelId, cursor, messageId}`，客户端收到后按 id 拉取正文。
   把 `PublicMessage` 整个塞进通知会在大消息（长代码块）上直接失败。
2. `LISTEN` 需要一条**专用连接**（连接池里的连接会被复用，导致监听失效）。
   这条连接也要处理断线重连。

若将来事件量级达到日均百万以上，再考虑 NATS JetStream 或 Kafka——
但在那之前，Postgres 自带的机制足够。

---

## 9. 观测

`GET /api/health` 返回实时连接统计：

```jsonc
{
  "status": "ok",
  "uptime_s": 86400,
  "checks": { "database": { "ok": true, "ms": 2 } },
  "realtime": { "users": 412, "connections": 587 }   // 用户数 / 连接数
}
```

`connections > users` 是正常的（多标签页）。异常信号：

- `connections` 持续单调增长且不下降 → 连接泄漏。检查 `registerSink` 的清理函数
  是否都在连接关闭时被调用（`close()` / `cancel()` 两条路径）
- `status: degraded` → 数据库不可用，负载均衡器会摘掉该实例

**容量参考**：单机 2vCPU/4GB 下，每个连接约占 30KB 常驻内存，
10,000 并发连接约 300MB。真正的瓶颈通常在文件描述符数量
（记得给容器和宿主机调高 `ulimit -n`）而不是 CPU。
