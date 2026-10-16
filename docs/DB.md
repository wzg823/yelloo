# 数据模型

对应代码：`src/db/schema.ts`；迁移：`drizzle/0000_*.sql`（Drizzle 生成）+
`drizzle/0001_search_trgm.sql`（手写，中文搜索）。

本文档只讲**为什么这么设计**，字段清单以 schema 为准。

---

## 全景

```
users ──┬─< member_roles >── roles
        ├─< sessions
        ├─< read_states >── channels
        ├─< messages >── channels
        │                 └─< attachments / reactions / message_edits
        ├─< reports / bans
        └─< audit_logs

categories ──< channels ──< channels (parent_channel_id, 自引用)
```

15 张表。所有时间列统一 `timestamptz`（DB 存 UTC，展示在应用层转 UTC+8）。

---

## 1. `messages` —— 唯一需要提前想清楚的表

这是全站增长最快、查询最频繁的表。三个决定：

### 1.1 主键是 Snowflake，不是 `bigserial`

```sql
"id" bigint PRIMARY KEY NOT NULL     -- 由应用生成，不是数据库序列
```

得到两个简化：

| 需求 | 有 Snowflake | 用 bigserial |
|---|---|---|
| 向上翻历史 | `WHERE channel_id=? AND id<? ORDER BY id DESC` | 需要 `created_at, id` 复合索引（时间戳可能重复） |
| SSE 断线补齐 | `WHERE id > :lastEventId` | 需要独立的事件序列表 |
| 分页游标 | 只需传一个 id | 需要传 `(created_at, id)` 二元组 |

代价：**JS 的 `Number` 只有 53 位安全整数，Snowflake 是 64 位。**
因此全链路约定：

- 数据库：`bigint`，Drizzle 声明为 `{ mode: 'bigint' }` → Node 侧是 `BigInt`
- Node 内部：一律 `BigInt` 参与比较与查询
- 出 JSON：`toPublicMessage()` 里 `.toString()`（见 `src/lib/serialize.ts`）
- 前端：当字符串处理。Snowflake 定长且单调，**等长数字串的字典序与数值序一致**，
  所以前端比较大小可以直接比较字符串（`useEventStream.ts` 就是这么做的）

> 如果哪天有人把 `id` 改成 `number` 或其类型改成 `bigserial`，
> 会依次出现：ID 精度丢失 → 点击消息跳错页 → SSE 补齐漏消息。修起来很痛。

### 1.2 索引只加必需的

```sql
messages_channel_id_idx  ON (channel_id, id DESC)   -- ★ 核心，分页与补齐都走它
messages_thread_idx      ON (thread_id, id)
messages_reply_idx       ON (reply_to_id)
messages_author_idx      ON (author_id, id DESC)
messages_content_trgm_idx ON GIN (content_md gin_trgm_ops)  -- 搜索
```

`(channel_id, id DESC)` 是最重要的一个：它同时服务三种查询——
频道首屏、向上翻页、SSE 补齐。**不要**再额外加 `(channel_id, created_at)`，
那是冗余的，只会拖慢每一次写入。

`DESC` 是必需的而不是装饰：`ORDER BY id DESC LIMIT 50` 在有 DESC 索引时是
一次索引扫描取前 50 行；没有 DESC 时 Postgres 可能需要扫描更多再排序。

### 1.3 软删除，但正文必须清空

```sql
is_deleted boolean DEFAULT false
deleted_by bigint
content_html text      -- 删除时置 NULL
```

原则：**先合规、再体验**。

- 软删除的行仍然参与查询（作为"该消息已被删除"占位），
  因为硬删除会让游标分页"跳过"位置，前端翻页会错位
- 但 `content_md` / `content_html` 在 API 层被清空（`toPublicMessage()` 里判断
  `isDeleted`），**不能只靠前端隐藏**——否则删掉的内容仍能通过接口读到
- 编辑历史单独存 `message_edits`，便于事后追溯（社区纠纷时的关键证据）

---

## 2. `channels` —— 自引用实现 Thread

```sql
type              channel_type   -- text | forum | announce | thread
parent_channel_id bigint         -- thread 指向宿主
forum_tags        text[]         -- forum 类型帖子的标签
message_count     integer        -- 冗余计数
last_message_at   timestamptz    -- 冗余时间，列表排序用
```

**为什么 Thread 也是 channel 而不是独立表**：Thread 需要消息、权限、搜索、
已读位点，这些逻辑与频道完全一致。复用一个表，所有查询函数（`listMessages`、
`listMessagesSince`）都能直接用；独立建表则要把它们全部实现两遍。

`message_count` 与 `last_message_at` 是刻意的冗余：
频道列表要按活跃度排序，如果实时 `COUNT(*)` + `MAX(created_at)`，
首页在几百万条消息时会变得很慢。**这两个字段的更新必须与消息插入在同一事务内**
（见 `insertMessage()`），否则进程崩溃会让列表顺序永久错乱。

> 想加"私密频道"时，只需要加一列 `visibility` 并改
> `listVisibleChannelIds()` 一个函数——SSE 补齐、降级轮询、搜索都复用它，
> 改动面是收敛的。

---

## 3. `read_states` —— 一个容易写错的地方

```sql
PRIMARY KEY (user_id, channel_id)
last_read_message_id bigint
```

推进已读位点的 SQL 关键在 `greatest()`：

```sql
INSERT INTO read_states (...) VALUES (...)
ON CONFLICT (user_id, channel_id) DO UPDATE
SET last_read_message_id = greatest(read_states.last_read_message_id, excluded.last_read_message_id)
```

**没有 `greatest()` 就会出现已读位点倒退**：用户在两个标签页里同时读，
或者网络乱序，后到的"较小"游标会把位点推回去，于是已经读过的消息重新变成未读。
这类 bug 很难复现，但会让用户觉得"这个站点的未读提示是坏的"。

---

## 4. `roles` / `member_roles` —— 权限用位域

```sql
roles.permissions  bigint NOT NULL   -- 位域，定义见 src/lib/permissions.ts
```

权限判断是每个写请求都要做的事（"这人能不能发言"）。位运算比 3 张关联表 join 快一个数量级。

**唯一的坑：JS 位运算只有 32 位。** 必须全程 `BigInt`，混用 `Number` 会静默截断。
`PERM.ADMINISTRATOR` 刻意放在第 62 位，就是为了让"是否含管理员位"这个判断
无法被 32 位运算误判。

有效权限 = 内置角色权限（`permsForUserRole(users.role)`）∪ 所有已授予角色的权限。

---

## 5. 治理三件套：`reports` / `bans` / `audit_logs`

公开技术社区这三张表是**合规刚需**，不是可选功能：

- `reports`：举报单，有状态机（open → resolved / dismissed）与处理人
- `bans`：封禁记录，支持 `until`（临时封禁）与永久封禁
- `audit_logs`：**所有管理动作必须留痕**，`action` 取自受控词表
  （`src/lib/audit.ts` 的 `AUDIT` 常量），禁止自由文本——否则日后无法可靠检索，
  也无法在监管问询时说明"我们对哪些行为留了痕"

`audit()` 接受一个 `DbLike` 参数，使审计与业务写入能落在**同一个事务**里。
分开写会出现"操作生效但无留痕"，在处置申诉时是致命的。

---

## 6. 中文搜索：为什么是 pg_trgm

PostgreSQL 内置的 `to_tsvector` **不支持中文分词**。用 `'simple'` 配置时，
一整句中文会被当成一个词元，搜"数据库"匹配不到"我们的数据库设计"。

常见解法 `zhparser` / `pg_jieba` 需要在数据库服务器上安装扩展，
国内云数据库（RDS）通常不允许。因此采用 `pg_trgm`：

- 完全内置，云数据库默认提供
- 中文按字符三元组切分，无需分词器
- `GIN + gin_trgm_ops` 让 `similarity()` 过滤走索引

查询形态（`searchMessages()`）：

```sql
WHERE similarity(content_md, $1) > 0.08
  AND is_deleted = false
ORDER BY id DESC
```

**取舍要知悉**：

- 不做词干化与同义词。搜"索引"不会自动匹配 "indexes"。
  对技术社区可接受——开发者倾向精确术语检索
- 阈值 0.08 是经验值：太低召回噪音大，太高会漏掉三字以下的短查询
  （短串的三元组天然偏少，相似度偏低）。上线后应按真实召回调整
- 索引体积约为正文的 1.5~3 倍

**规模提醒**：pg_trgm 的 GIN 索引在千万行级仍可用，但写入放大会变明显。
到那个量级应把搜索剥离到独立服务（Meilisearch 等），而不是继续加大这个索引。

---

## 7. `sessions` —— 为什么不用 JWT

```sql
id varchar(64) PRIMARY KEY   -- 存 token 的 SHA-256，不是 token 本身
```

两个刻意的选择：

1. **DB 存会话**：封禁必须"立即生效"。JWT 在过期前无法撤销，
   封了一个人他还能继续发帖到 token 过期为止。
2. **只存哈希**：与密码同理。数据库泄露时攻击者拿到的是哈希，
   无法直接拿去登录。

`getCurrentUser()` 里有一处**惰性续期**：只有距上次活动超过 1 天才写一次
`UPDATE`，避免每个请求都产生一次写入（这对单机 Postgres 是真实压力）。

---

## 8. 索引与查询模式总表

| 查询 | 走的索引 |
|---|---|
| 频道首屏 50 条 | `messages_channel_id_idx (channel_id, id DESC)` |
| 向上翻历史 | 同上 |
| SSE 补齐（跨频道） | 各频道走 `messages_channel_id_idx`，由 `inArray` 展开 |
| 自己发的消息 | `messages_author_idx` |
| 搜索正文 | `messages_content_trgm_idx (GIN)` |
| 频道列表排序 | `channels_category_pos_idx` |
| 邮箱/用户名登录与查重 | `users_email_key` / `users_handle_key`（`lower()` 表达式唯一索引） |

`lower()` 表达式唯一索引的作用：让 `Alice@x.com` 与 `alice@x.com` 视为同一账号，
避免用 `citext` 扩展（国内云数据库同样可能不提供）。

---

## 9. 什么时候该拆表 / 分库

给出明确的信号，避免过早优化，也避免该动的时候没动：

| 信号 | 处置 |
|---|---|
| `messages` 超过 5000 万行，且最热频道的首屏查询 p95 > 50ms | 按 `channel_id` 做分区（`PARTITION BY HASH`），或把冷频道归档 |
| 单库磁盘 > 100GB 且索引占比 > 50% | 搜索剥离到 Meilisearch，释放 trgm 索引空间 |
| `audit_logs` / `rate_limits` 体积失控 | 加保留策略（按 `created_at` 定期删除旧行），这类表不需要永久保留 |
| 需要跨实例限流 | `rate_limits` 表已建好，把 `src/lib/ratelimit.ts` 的实现从进程内 Map 换成它 |
| 需要多实例实时推送 | 用 Postgres `LISTEN/NOTIFY`（见 docs/EVENTS.md），**不需要 Redis** |

> 目前 `rate_limits` 表只是预留。进程内滑动窗口在单实例下更省一次数据库往返。
