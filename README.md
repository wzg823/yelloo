# 技术社区（频道制论坛）

一个面向中文开发者的**公开技术社区**。内部采用 Discord 式的频道模型（连续消息流 + Thread），
对外用论坛式的 URL 结构把内容暴露给搜索引擎。

当前状态：**P0 + P1 已完成**，可注册登录、发消息、传附件、实时接收、向上翻历史、搜索、未读角标。
P2 剩余项（编辑删除、管理后台、举报处置、新人限流、密码重置）见 [docs/STATUS.md](docs/STATUS.md)；
产品范围与里程碑见 [docs/PLAN.md](docs/PLAN.md)。

---

## 技术选型与理由

| 层 | 选择 | 为什么这样选 |
|---|---|---|
| 框架 | Next.js 15 App Router + React 19 + TS | 论坛重 SEO，需要服务端渲染；Server Actions 省掉整个 REST 层 |
| 数据库 | PostgreSQL 16 | 内置 GIN/pg_trgm 索引即可满足中文搜索，无需 Elasticsearch |
| ORM | Drizzle | 类型安全且 SQL 可控，迁移是纯 SQL 文件，方便 review |
| 实时 | **SSE**（不是 WebSocket） | 只需要服务端单向推送；SSE 有原生自动重连与 `Last-Event-ID`，实现量小一个数量级 |
| 实时扇出 | 进程内 Map | 单实例够用。扩展路径见下文，**不需要引入 Redis** |
| 密码 | argon2id（`@node-rs/argon2`） | 预编译二进制，Docker 构建不需要编译工具链 |
| 反向代理 | Caddy | 自动 HTTPS，SSE 配置只有两行 |
| 样式 | 原生 CSS | 骨架阶段零构建配置，`next build` 少一个失败点 |

**刻意没引入的东西**：Redis、Kafka、Elasticsearch、K8s、GraphQL、Tailwind、状态管理库。
在单机 + 万级用户之前，它们都只是负债。

---

## 快速开始

### 前置要求

- Node.js ≥ 20.9（本仓库在 22 / 24 上验证过）
- PostgreSQL 16（本机安装，或用仓库里的 `docker compose`）

### 本地开发

```bash
# 1) 安装依赖
npm install

# 2) 配置环境变量
cp .env.example .env
# 至少需要改 DATABASE_URL；SESSION_SECRET 用下面的命令生成
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 3) 建表 + 初始化数据（分类、频道、内置角色）
npm run db:migrate
npm run db:seed

# 4) 起开发服务器
npm run dev            # → http://localhost:3000
```

创建管理员：在 `.env` 里设置 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` 后重新执行
`npm run db:seed`（幂等，不会重复插入）。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（热重载） |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务 |
| `npm run typecheck` | TypeScript 检查（CI 必跑） |
| `npm run smoke` | **端到端验证**：注册 → 发消息 → 跨用户实时投递 + 心跳检测（需 `SMOKE_PASSWORD`，见下） |
| `npm run build:image` | **在 WSL 里构建镜像并导出**（低内存服务器的正确做法） |
| `npm run deploy` | 部署到服务器（**在服务器上执行**，见 [docs/DEPLOY.md](docs/DEPLOY.md) 第 4 节） |
| `npm run deploy:local -- -Server root@IP` | 从 Windows 本地编排部署（打包上传 + 远程部署 + 验证） |
| `npm run deploy:local -- -Server root@IP -Images -Smoke` | **上传预构建镜像**部署，服务器零构建（推荐） |
| `npm run db:generate` | 改完 `src/db/schema.ts` 后生成迁移 SQL |
| `npm run db:migrate` | 执行迁移 |
| `npm run db:seed` | 写入初始化数据（分类、频道、内置角色、首个管理员） |
| `npm run db:studio` | Drizzle 数据浏览器 |

> **改 schema 的流程**：改 `src/db/schema.ts` → `npm run db:generate` →
> 检查生成的 `drizzle/00xx_*.sql`（务必 review，别盲信生成器）→ `npm run db:migrate`。
> 生成的文件要一起提交。

> **部署后必跑 `npm run smoke`**。它能发现"页面看起来正常但实时其实不通"
> 这类问题，并诊断中间层是否在缓冲 SSE。详见 [docs/DEPLOY.md](docs/DEPLOY.md) 第 5 节。

> **`SMOKE_PASSWORD` 是必填的。** smoke 用两个长期固定账号（`smokea` / `smokeb`）
> 模拟两个浏览器互相收发消息，它们的口令**不写在源码里**——写死等于把一把长期
> 有效的钥匙提交进仓库。配置方式：
>
> ```bash
> # 本机运行
> SMOKE_PASSWORD=<口令> npm run smoke
> # 容器内运行：写进服务器 .env 的 SMOKE_PASSWORD，compose 自动注入
> ```
>
> 未配置时 smoke 以退出码 **2** 报配置错误（而不是回退到默认口令，也不是静默跳过）。
> 账号不存在时脚本会自动注册，所以首次配好直接跑即可。

---

## HTTP API

除页面外，还提供了一组 REST 端点。**它们不是"给测试用的"**——
Server Action 需要浏览器注入的 `Next-Action` 头，脚本、移动端、桌面端都无法调用，
因此非浏览器客户端必须有 REST 入口。

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查（含数据库与实时连接统计），供容器与负载均衡器探活 |
| `GET /api/channels` | 公开频道列表（游客可读） |
| `GET /api/channels/:id/messages` | 历史消息，游标分页（`?before=` / `?after=` / `?limit=`） |
| `POST /api/messages` | 发送消息（需登录） |
| `GET /api/events` | **SSE 实时事件流**，见 [docs/EVENTS.md](docs/EVENTS.md) |
| `GET /api/sync` | 降级轮询（`?since=<cursor>`），SSE 不可用时兜底 |
| `POST /api/read` | 推进已读位点 |
| `POST /api/auth/register` | 注册（JSON 或表单编码），下发 httpOnly Cookie |
| `POST /api/auth/login` | 登录 |
| `POST /api/auth/logout` | 登出，并断开该用户所有 SSE 连接 |

---

## 目录结构

```
src/
├─ app/
│  ├─ layout.tsx                     根布局（含容错的导航查询）
│  ├─ page.tsx                       首页：频道总览
│  ├─ globals.css                    全站样式
│  ├─ c/[slug]/page.tsx              频道页（SSR 首屏 50 条，SEO 入口）
│  ├─ m/[id]/page.tsx                消息永久链接（长尾流量入口 + JSON-LD）
│  ├─ search/page.tsx                搜索结果
│  ├─ (auth)/                        登录注册：page + actions.ts
│  ├─ api/
│  │  ├─ events/route.ts             ★ SSE 主端点
│  │  ├─ sync/route.ts               降级轮询端点
│  │  ├─ messages/route.ts           发送消息
│  │  ├─ channels/[id]/messages/     历史分页
│  │  ├─ read/route.ts               已读位点
│  │  └─ health/route.ts             健康检查（供容器/LB）
│  ├─ robots.ts / sitemap.ts         SEO
│  └─ not-found.tsx
├─ components/
│  ├─ AppShell.tsx                   侧栏 + 内容区外壳
│  ├─ ChannelStream.tsx              ★ 消息流：去重/乐观插入/游标翻页
│  ├─ MessageItem.tsx                单条消息（SSR 与实时共用）
│  ├─ Composer.tsx                   发言框
│  ├─ AuthForm.tsx                   登录注册表单
│  └─ CodeEnhancer.tsx               给代码块挂复制按钮
├─ db/
│  ├─ schema.ts                      ★ 数据模型（改这里前先读文件头注释）
│  └─ index.ts                       连接池（单例）
└─ lib/
   ├─ snowflake.ts                   ★ 消息 ID 生成
   ├─ realtime/hub.ts                ★ 实时扇出
   ├─ useEventStream.ts              ★ 客户端 SSE + 降级轮询
   ├─ queries.ts                     数据访问层
   ├─ session.ts / password.ts       会话与密码
   ├─ permissions.ts                 权限位
   ├─ markdown.ts                    白名单式 Markdown 渲染（防 XSS）
   ├─ ratelimit.ts / audit.ts        限流与审计
   ├─ serialize.ts                   BigInt/Date 的 JSON 安全转换
   ├─ safe-query.ts                  装饰性查询的降级包装
   └─ format.ts                      展示层工具
```

---

## 核心设计速览

### 消息 ID 用 Snowflake，不是自增

`messages.id` 是 64 位 Snowflake（时间戳 + worker + 序列号）。带来两个简化：

- 游标分页只需一个索引：`WHERE channel_id = ? AND id < ? ORDER BY id DESC`
- SSE 断线补齐不需要额外的事件表：`WHERE id > :lastEventId`

代价：**JS 侧必须用 BigInt，出 JSON 必须转字符串**（`Number` 只有 53 位安全整数）。
全链路已处理，新代码请遵守 `src/lib/serialize.ts` 的约定。

### 实时：一条 SSE 连接，多路复用

浏览器对同源 HTTP/1.1 只有 6 条连接。如果每个频道开一条 `EventSource`，
用户切到第 7 个频道就会把页面其他请求全部饿死。所以：

- 每个登录用户只维持 **1** 条 `/api/events` 连接
- 服务端按"该用户可见的频道集合"过滤后推送
- 断线重连靠 `Last-Event-ID` 补齐；SSE 被中间层拦截时自动降级为 5 秒轮询

细节与完整事件契约见 [docs/EVENTS.md](docs/EVENTS.md)。

### 扩展路径（需要多实例时）

**不需要引入 Redis。** Postgres 自带的 `LISTEN/NOTIFY` 就够：

1. `publish()` 写库后执行 `SELECT pg_notify('bbs_events', json)`
2. 启动时用一条专用连接 `LISTEN bbs_events`
3. 收到通知后调用本地 `hub.deliver()` 分发给本实例上的连接

改动范围：`src/lib/realtime/hub.ts` 的 publish/deliver 两个函数，路由与前端零改动。
注意 `NOTIFY` 载荷上限 8000 字节，因此只广播"频道 id + 消息 id"，正文由客户端按 id 拉取。

---

## 部署

见 [docs/DEPLOY.md](docs/DEPLOY.md)。**中国大陆部署前请先读"备案"一节——
这是硬性前置条件，未备案域名解析到大陆服务器会被直接阻断。**

单机 Docker Compose 部署约为 **$6~8/月**（VPS + 域名）。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | **进度报告**：当前完成度、线上快照、风险、下一步 |
| [docs/PLAN.md](docs/PLAN.md) | 产品范围、里程碑、后续优先级、风险 |
| [docs/DB.md](docs/DB.md) | 数据模型逐表说明、索引与查询模式、扩容思考 |
| [docs/EVENTS.md](docs/EVENTS.md) | SSE 协议、游标语义、背压、降级、多实例扩展 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 中国大陆部署步骤、备案、备份恢复、排障 |

---

## 已知限制（P0/P1 范围内）

这些是**有意为之**的取舍，不是遗漏：

- 消息编辑 / 删除未实现：软删除字段已在表里，客户端也已支持 `message.deleted` 事件（P2）
- 举报、封禁、审计日志只有表与工具函数，没有管理界面（P2）
- `users.trust_level` 已写入但未被读取，新人限流尚未生效（P2）
- forum 类型频道目前与 text 频道行为一致，未做"一帖一帖"的独立 URL（P3）
- 评论/反应（reactions）只有表结构（P3）
- 无邮件发送：注册不做邮箱验证，忘记密码流程未实现（P2）
- 无速率限制的分布式实现：当前是进程内滑动窗口，多实例下额度会乘以实例数（P4）
