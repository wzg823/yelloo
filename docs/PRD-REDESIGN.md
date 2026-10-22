# 针对 AI 社区 PRD 的重设计建议

> 输入：`ai_community_prd.md`（v1.0 MVP 基线）
> 对照：本仓库当前实现（P0–P2 已完成，线上运行中）
>
> 结论先说：**不需要重写，但需要一次架构级重构 + 四组新资源。**
> 最大的风险不是 AI，而是把"默认公开"改成"访问控制贯穿全链路"。

---

## 1. 结论摘要

### 现状与 PRD 的关系

| PRD 要求 | 当前状态 |
|---|---|
| 注册登录、会话失效、游客只读 | ✅ 已完成 |
| 实时聊天室（广播、重连、去重、乐观更新、限流反馈） | ✅ 已完成，实测投递 13–33ms |
| 历史消息游标分页 | ✅ 已完成 |
| 消息回复/引用/表情/收藏/编辑/删除 | 编辑删除 ✅；引用 ✅；表情/收藏 ❌ |
| 举报、禁言、封禁、审计、管理后台 | ✅ 已完成（PRD 这一块我们做得比要求多） |
| 图片上传（PRD 列为"可选"） | ✅ 已完成（白名单 + 随机存储名 + Caddy 直出） |
| **兴趣社群（多社群）** | ❌ 当前是**单一社区**，明确不做多租户 |
| **私密内容与成员权限** | ❌ 完全没有。`listVisibleChannelIds()` 只按 `archived` 过滤 |
| **项目 / 成果** | ❌ 无 |
| **讨论串** | ❌ 表结构里预留了 `thread_id`，未实现 |
| **AI 按需调用（流式）** | ❌ 无，且早期方案里明确排除过 |
| 搜索 | ✅ 有（pg_trgm），但**不校验权限** |
| 通知 / 收藏 / 发现页 | ❌ 无 |

### 一句话判断

当前代码覆盖了 PRD 的**阶段 1、阶段 2 的聊天部分、阶段 5 的大部分**，
而且治理侧（举报→处置→封禁→审计）比 PRD 要求更完整。
**真正的增量是四件事**：多社群与私密可见性、项目、讨论串+成果、AI。

### 增量规模

以"P2 那五项（附件/未读/新人限流/编辑删除/管理后台/密码重置）"为 1 个单位：

**这次改动约为 2.5–4 个单位。** 其中单项最大的是 AI，第二是可见性重构。
不是几天能完成的事，建议按第 8 节的阶段推进，每阶段都可上线。

---

## 2. 三个必须先改的架构点

### 2.1 可见性：现在根本不存在，必须在加任何新内容类型之前建好

**证据**（`src/lib/queries.ts`）：

```ts
export async function listVisibleChannelIds(): Promise<number[]> {
  const rows = await db.select({ id: channels.id }).from(channels)
    .where(eq(channels.archived, false))   // ← 没有 userId
  return rows.map((r) => r.id)
}
```

它被 **9 处**调用：`/api/events`（握手 + 补齐）、`/api/sync`（2 处）、
`/api/channels`、`layout.tsx`（侧栏）、`page.tsx`（首页）、`queries.ts` 内部（2 处）。

好消息：这个函数是我当初刻意留下的**唯一岔口**（文件里有一句注释：
"将来要加私密频道时，只需要改这一个函数"）。9 个调用点都已经或很容易拿到用户。

坏消息：**只有这一个函数是不够的**。PRD 6.2 要求私密内容在四个地方都挡住：

| 读路径 | 现在 | 需要 |
|---|---|---|
| REST（消息列表、频道列表） | 按 archived 过滤 | 按成员关系过滤 |
| SSE 实时订阅 | 握手时固定频道集合 | 按成员关系，且**成员变更时要重新界定** |
| 搜索 | `similarity() + is_deleted=false` | 加上成员关系 JOIN |
| AI 上下文 | 不存在 | 只能通过同一个 resolver 组装 |

**所以第一步不是"加一张表"，而是把可见性收敛成一个 resolver，然后逐个读路径接上去。**

#### 建议实现

```
src/lib/access.ts        纯函数，零依赖（可被脚本单测）
  resolveChannelAccess(user, channel, membership) → { canRead, canWrite, canManage }
  resolveProjectAccess(user, project, membership) → 同上
  canReadContent(user, target) → 统一入口
```

要求三条：

1. **任何读路径都不得绕过它。** 加一个自检脚本：列出所有 `from(messages)` /
   `from(channels)` 的读取位置，逐个标注"经过 resolver"或"公开读"，清单入库。
   新增未标注的读点 = 测试失败。这类"检查代码结构"的断言，比人肉 review 可靠得多。
2. **SSE 的频道集合要能重算。** 现在只在握手时算一次；用户加入/退出社群后
   必须重算（`addChannels` / 需要新增 `setChannels`）。否则出现"已退出但还能看到"
   或"已加入但收不到"。
3. **搜索必须 join 成员关系**，不能"先搜再过滤"——后者会泄露总数与存在性。

### 2.2 信息架构：单一社区 → 发现页 + 社群 + 项目

现在的 `AppShell` 是：侧栏 = 分类分组 + 频道列表 + 搜索 + 用户信息。
PRD 要求：左侧三栏（全局导航 / 社群列表 / 频道列表）、中央内容、右侧可选面板。

这不是加个页面，是**导航模型换掉**：

| 当前 | 目标 |
|---|---|
| `categories` → `channels` | 全局导航 → 社群 → 频道 |
| 首页 = 频道总览 | 首页 = 发现（正在讨论 / 推荐项目 / 热门社群 / 近期成果）|
| URL `/c/[slug]` | `/s/[community]/c/[channel]` |
| 无右侧栏 | 讨论串面板 / 成员列表 |

**关于 URL 变更**：现在改是免费的。站点还没有被搜索引擎收录、没有外部链接，
换 URL 结构没有任何代价；上线后再改就会丢掉收录与收藏。**这是现在做的最强理由之一。**

**关于"公共空间"**：PRD 5 节说"公共空间可使用系统级社区记录"。强烈建议照做，
并且**把现有 9 个频道整体迁进这个系统社群**（`slug=public` 或 `lobby`）。
理由：新用户注册后的第一步必须有地方可去。如果首版只有"用户创建的社群"，
冷启动时首页是空的——这会直接杀死第一个假设（用户愿意参与讨论）。

### 2.3 消息容器模型：PRD 的双父设计要合并

PRD 的 `messages` 同时有 `channel_id` 和 `project_id`：

```
| messages | id, channel_id, project_id, sender_id, sender_type, content, created_at |
```

这会带来三个问题：

1. **每条消息都有两个"可空父指针"**，任何查询都要写 `if` 分支（`where channel_id = ?` 还是 `where project_id = ?`）
2. **分页/实时/权限/搜索四处都要处理两种容器**，每处都是双份逻辑
3. `project_id + channel_id` 的组合语义不明确：项目聊天室到底是不是一个频道？

**建议：统一成"容器"概念，只保留一个外键。**

```sql
channels
  id, slug, name, type,
  owner_type   -- 'community' | 'project'   （project 的聊天室也是一条 channel）
  owner_id
  visibility   -- 'public' | 'private'
messages
  id, channel_id   -- ★ 只有这一个外键
```

- 创建项目 → 自动创建一条 `owner_type='project'` 的 channel
- 项目详情页的三个标签：聊天室=读那条 channel；讨论=读 threads；成果=读 artifacts
- 我现有的 `messages` 表（Snowflake id、content_md/html、软删除、修订历史、附件）
  **一行都不用改**

这一条能让后面的实现量减少一大截：分页、SSE、搜索、权限、附件全部复用现有代码。

---

## 3. 我建议偏离 PRD 的 8 处（附理由）

PRD 是需求基线，不是实现规范。以下几处我建议按现有方案走。

| # | PRD 建议 | 建议 | 理由 |
|---|---|---|---|
| 1 | 实时用 **WebSocket 或托管实时服务** | **保持 SSE** | 本项目只需要服务端→客户端单向推送，AI 流式同样是单向。SSE 自带重连与 `Last-Event-ID`，且**穿透普通 HTTP 反代**（WebSocket 在某些企业代理与国内 CDN 上更易被拦）。现有实现已实测 13ms 投递、心跳准时 |
| 2 | 消息索引 `(channel_id, created_at, id)` | **`(channel_id, id DESC)`** | 我们的 id 是 Snowflake，**本身就按时间单调**。多存一列 `created_at` 只让索引变大、写入变慢，查询没有任何收益 |
| 3 | `messages.project_id` 与 `channel_id` 并列 | **只保留 `channel_id`** | 见 2.3。项目聊天室就是一条 channel |
| 4 | 新增 `moderation_actions` 表 | **复用已有 `audit_logs`** | 现有审计已覆盖全部管理动作（`user.ban/mute/role_grant/trust_set`、`message.delete`、`channel.*`、`report.*`），带受控词表、经办人、IP、jsonb 详情。再加一张表 = 两处真相 |
| 5 | `threads` + `thread_replies(thread_id, message_id)` | **`threads` + `messages.thread_id`** | PRD 的写法把"谁是某条 thread 的回复"记了两遍（join 表一次、消息本身隐含一次），必然分叉。一条消息属于哪个 thread 只该有一处字段 |
| 6 | `notifications.payload` jsonb | **加 `dedupe_key` 唯一约束** | 通知的触发源是实时事件，而事件会重投（我们已经在客户端为消息做了去重）。没有幂等键时，"重连补发一批事件"会把同一条通知写十遍 |
| 7 | 搜索"PostgreSQL 全文搜索" | **保持 pg_trgm** | 中文没有分词时 `to_tsvector` 基本不可用（需要 `zhparser`/`pg_jieba`，云数据库通常不给装）。`pg_trgm` 的相似度对中文短查询已经够用，且已在线上跑 |
| 8 | 私密社群"邀请或管理员审批" | **MVP 只做邀请制** | 审批流是一整套工作流（申请表、列表、通过/拒绝、通知、配额），而 PRD §11 自己把它列为待决策项。邀请制一天能做完，审批制是一周 |

另外一处**补充而非偏离**：PRD §9.2 的实时广播目标是 P95 < 500ms。
现有实测 13–33ms（同区域、容器内），已经远优于目标 —— 这条不需要额外投入。

---

## 4. 权限模型设计

### 4.1 现有模型缺什么

现在是**扁平的全局角色**：`member` / `mod` / `admin` + bigint 能力位。
这套对"单一公开社区"是恰当的，但无法表达 PRD 需要的**作用域关系**：

- 我是 A 社群的成员，不是 B 社群的成员
- 我是某私密项目的成员，但不是该项目所属社群的普通成员
- 我是 A 社群的管理员，但这不等于我能看该项目下的私密内容（PRD 6.2 第 2、3 条）

### 4.2 建议：能力位保留，作用域关系叠加

```
全局能力（保留现有 bigint 位域）：能不能发言 / 上传 / 举报 / 删任意消息 / 管理平台
作用域关系（新表）：
  community_members(community_id, user_id, role)   -- owner | admin | member
  project_members(project_id, user_id, role)       -- owner | member
  channel_members(channel_id, user_id)             -- 仅私密频道用
```

判定顺序（`resolveChannelAccess`）：

1. 平台管理员（`ADMINISTRATOR` 位）→ 全通过
2. 频道归档 → 只读
3. 频道 `owner_type='community'`：
   - `visibility='public'` → 所有登录用户可读；写权限看全局能力位
   - `visibility='private'` → 必须是该社群成员，或 `channel_members` 里有他
4. 频道 `owner_type='project'`：必须是项目成员；项目私密时**社群成员身份不叠加**
5. 全局封禁/禁言覆盖一切（现有 `isMuted` / banned 已在读路径生效）

### 4.3 必须做的测试（纯函数，穷举矩阵）

这是**整个重设计里最该被测试的一块**，因为它的失败是静默的：
一个漏判不会报错，只会让某个私密内容出现在某个人的屏幕上。

测试矩阵（`scripts/test-access.mjs`）：

```
身份 × 资源 × 期望
  游客 / 注册用户 / 社群成员 / 社群管理员 / 项目成员 / 项目所有者 / 平台管理员
× 公开社群频道 / 私密社群频道 / 公开项目频道 / 私密项目频道 / 私密频道(channel_members)
× 归档 / 已删除
```

必须断言的几条"反直觉"规则（PRD 6.2）：

- 社群管理员 **不能**读本社群的私密项目频道（除非他也是项目成员）
- 社群成员 **不会**因为加入了社群而自动获得项目权限
- 私密社群里的成果，其可见性 **不得**宽于所属项目
- 被禁言用户 **不能**通过已建立的 SSE 连接继续发送（现有实现已在每次写入校验，保持）

---

## 5. AI 子系统

这是增量里最大、最贵、最容易失控的一块。设计要点：

### 5.1 上下文组装只能有一个入口

```
buildAiContext(user, scope, task) → { messages[], truncated, droppedCount }
```

它内部**只调用 `resolveChannelAccess`**，不允许任何一个 AI 任务自己写查询。
原因：AI 上下文是数据外泄最隐蔽的一条路径 —— 内容一旦进了 prompt，
就会出现在模型服务商那边，而且可能被模型复述给别的用户。

必须做到：
- prompt 里不含用户邮箱、IP、session token
- 私密内容被拒绝时**记录日志但不把内容写进日志**
- 上下文超长时截断，并如实告知用户"基于最近 N 条"

### 5.2 状态机与流式事件

PRD 给的状态机是对的，落地时注意：

```
queued → streaming → completed | failed | cancelled
```

- 走现有 SSE 追加事件类型：`ai.run_started` / `ai.delta` / `ai.run_completed` /
  `ai.run_failed` / `ai.run_cancelled`
- `ai.delta` 必须带 **`run_id` + `seq`**，客户端按 (run_id, seq) 去重。
  理由：SSE 断线重连会重放补齐，没有序号就无法判断"这段文字我拼过没有"
- **取消必须真的中断**：`AbortController` 一路传到 provider 的 fetch，
  而不是前端隐藏。PRD 6.3 明确要求这一点
- 完成后作为一条 `messages` 落库（`kind='ai'` 或 `sender_type='ai'`），
  **同时写 `ai_runs.usage`**（tokens / 模型 / 耗时）

### 5.3 配额与成本

三层限制，缺一不可：

| 层 | 目的 | 建议初值 |
|---|---|---|
| 每用户每日次数 | 防单个用户烧钱 | 20 次/天（可配） |
| 全局并发 | 防打满上游速率 | 3 并发 |
| 单次超时 | 防挂死连接 | 60s，首字节 15s |

`ai_runs` 记录 usage 之后，**管理后台加一个"AI 用量"页**（按用户/按日聚合）。
没有这个页面，AI 成本是不可见的——而 PRD §11 把"AI 调用成本不可控"列为风险。

### 5.4 首版只做一个任务

PRD 列了四个任务：解释概念 / 总结讨论 / 分析方案 / 生成初稿。

**建议首版只做「总结当前讨论」。** 理由：

- 它是唯一**有明确输入边界**的任务（当前频道/讨论串的最近 N 条），上下文组装最简单
- 它直接对应 PRD 的核心价值主张（"降低整理成本"）
- 它天然产出可保存的内容（成果/讨论摘要），能验证"内容沉淀"这条闭环

其余三个任务的差别主要在 prompt 与温度参数，**管道打通后加它们是半天的活**。
反过来，如果先做四个任务再回头修管道，每个任务都要跟着改。

---

## 6. 数据模型落地清单

按"必改 / 新增 / 不用动"三类。

### 必改（3 张表）

| 表 | 改动 | 说明 |
|---|---|---|
| `channels` | 加 `community_id`（可空）、`owner_type`、`owner_id`、`visibility` | 现有 9 条频道全部挂到系统社群 `public` 下 |
| `messages` | 加 `thread_id`（FK → `threads`）、`sender_type`（user/ai/system） | 现有 `kind` 保留为消息形状（text/system），`sender_type` 表示是谁说的 |
| `categories` | 加 `community_id` | 分类是社群内部的分组 |

### 新增（9 张表）

```
communities            id, slug, name, description, visibility, owner_id, member_count
community_members      community_id, user_id, role, joined_at   [unique(c,y)]
community_join_requests  P1，MVP 可先不建
projects               id, slug, title, description, visibility, owner_id,
                       community_id?, channel_id, source_message_id?, status
project_members        project_id, user_id, role, joined_at     [unique(p,y)]
channel_members        channel_id, user_id                      [unique(c,y)]
threads                id, root_message_id [unique], channel_id, created_by,
                       reply_count, last_reply_at, resolved_at?
artifacts              id, project_id, author_id, title, body, url, visibility
notifications          id, user_id, type, payload, read_at, dedupe_key [unique]
ai_runs                id, user_id, task, context_type, context_id, status,
                       provider, model, input_tokens, output_tokens, ms,
                       error, created_at
```

### 不用动（10 张表）

`users`、`roles`、`member_roles`、`sessions`、`attachments`、`message_edits`、
`reactions`、`read_states`、`reports`、`bans`、`audit_logs`、`rate_limits`、
`password_resets`

**`reactions` 表已经在库里但一直没用** —— 正好这次接上（PRD 3.2 要求表情反应），
不需要新建表。

### 一个时机判断

当前库里是 **11 个用户 / 37 条消息**，全是演示与验证数据。
所以：**现在可以激进改 schema，不用写数据迁移脚本。** 直接清库重建。

真实用户进来之后，`channels.owner_type` 这种结构性改动就需要"迁移 + 双写 + 回滚预案"，
成本是现在的十倍以上。**这是做重设计最便宜的时刻。**

---

## 7. 与现有代码的复用关系

| 现有能力 | 重设计后 |
|---|---|
| Snowflake id + 游标分页 | **完全复用**（这是全项目最值钱的一个决策） |
| SSE 单连接多路复用 + 降级轮询 | 复用，只需扩展事件类型与频道集合重算 |
| Snowflake 引擎 / 会话 / argon2 / 密码策略 | 完全复用 |
| 附件（白名单、随机名、Caddy 直出） | 完全复用，对象存储是后续可选 |
| 消息编辑删除 + 修订历史 + 软删除清库 | 完全复用 |
| 举报 → 处置 → 封禁 → 审计 → 管理后台 | 完全复用，**只需把"处置范围"从全站扩展到社群级** |
| 新人限流 / 基础限流 / 密码重置 / 主题 | 完全复用 |
| pg_trgm 搜索 | 复用，**必须加权限 JOIN** |
| 8 个验证脚本（397 项断言） | 全部保留，并新增 `test-access.mjs` |

**真正要重写的只有**：导航与信息架构（`AppShell` 及其子页面）、首页（发现页）。

---

## 8. 阶段路线图

每阶段结束都应是一个**可上线的版本**。

| 阶段 | 内容 | 验收（能演示什么） |
|---|---|---|
| **0. 可见性基座** | `access.ts` + 成员表 + resolver 接入 4 条读路径 + 穷举测试 | 私密频道对非成员：REST 403、SSE 不推送、搜索不命中、AI 上下文不含 |
| **1. 社群** | communities CRUD、加入/退出、自动 `general` 频道、系统社群迁移、导航改版 | 建社群 → 自动出频道 → 他人加入 → 发消息；私密社群非成员看不到 |
| **2. 讨论串** | `threads` 表 + 右栏面板 + 回复计数 + 回原消息 | 从消息开讨论 → 他人回复 → 回跳原消息 |
| **3. 项目 + 成果** | projects、成员、项目频道、artifacts、消息转项目 | 从消息创建项目（预填）→ 项目聊天 → 发布成果 → 权限继承 |
| **4. AI** | `ai_runs`、流式事件、取消、配额、用量页 | `@AI` 总结 → 流式输出 → 停止 → 失败重试 → 超配额被拒 → 越权上下文被挡 |
| **5. 发现 / 搜索 / 通知 / 收藏** | 规则排序 feed、权限化搜索、站内通知、收藏 | 首页四模块；搜索只出有权内容；被回复/被@有通知 |

**阶段 0 不能跳过，也不能排到后面。** 如果先做社群再做可见性，
意味着社群相关的每个读接口都要先按"全公开"写一遍，再回头改一遍 —— 双倍工作，
而且中间那段时间线上是**真的有越权**的。

---

## 9. 我的三条反向建议（削减范围）

PRD 的 MVP 范围偏大。如果要一个人做完并让第一批用户真的用起来，我建议砍这三处：

### 9.1 AI 首版只做"总结"

见 5.4。四个任务里三个是 prompt 变体，管道通了再加。

### 9.2 通知首版只做两种

PRD 列了四种（提及、回复、加入申请、项目成员变化）。
**只做"被回复"和"被@"**，加入申请取决于是否做审批流（我建议不做），
项目成员变化可以先用"项目内系统消息"代替。

### 9.3 发现页先做规则排序 + 手工精选

"推荐项目"里的招募状态机、加入关系权重，在第一版没有足够数据时无法验证效果。
**建议：四个模块都保留，排序用最简单的规则（最近活跃 + 已加入优先），
并留一个"编辑精选"的开关**（管理后台里改几个 id 即可）。等有 50 个真实项目再谈排序。

---

## 10. 工时与成本

以"P2 五项"为 1 个单位（那是我实际做过的量）：

| 阶段 | 相对工作量 | 备注 |
|---|---|---|
| 0. 可见性基座 | **0.5** | 代码量不大，但触及 9 处调用 + 测试矩阵，返工风险最高 |
| 1. 社群 | 0.6 | 含导航彻底改版 |
| 2. 讨论串 | 0.15 | 复用 messages，最小 |
| 3. 项目 + 成果 | 0.6 | 两套成员关系 + 一帖一页 |
| 4. AI | **0.8** | 流式、取消、配额、用量页、上下文组装 |
| 5. 发现/搜索/通知/收藏 | 0.5 | 搜索要重写权限部分 |
| **合计** | **约 3.1** | 阶段 0 与 4 是风险集中点 |

运行成本增量：

- 服务器：现有 1.6GB 机器继续够用（SSE 连接 = 内存，千级并发才需要加内存）
- AI：单次总结（8k 输入 / 500 输出）按主流模型约 ¥0.01–0.05 量级；
  按 20 次/人/天 × 100 日活估算，**月成本量级在几十到几百元** —— 可控，
  但必须有配额，否则一个脚本就能刷爆

---

## 11. 需要你决定的问题

有几个 PRD 自己列为"待决策"或表述模糊的点，我需要在动手前知道答案：

1. **私密社群的加入方式**：邀请制（建议）／申请审批制／两者都要？
2. **是否保留一个"系统公共社群"**（把现有 9 个频道迁进去）？
   我强烈建议保留 —— 否则冷启动时新用户注册后无处可去。
3. **AI 用哪家模型**：决定了流式协议细节、成本量级、以及是否需要国内合规的
   备案/审核（大陆对生成式 AI 服务有单独要求）。有没有预算上限？
4. **首批种子内容从哪来**：PRD §1.2 假设 1 是"用户愿意参与讨论"，
   而这需要先有内容。谁来产出前 20–30 条？
5. **域名与备案状态**：影响邮件（密码重置现在默认不发信）、AI 服务接入、
   以及是否能在大陆部署。
6. **是否接受 URL 结构变更**（`/c/x` → `/s/community/c/x`）：
   现在免费，上线后要付收录丢失的代价。

---

## 12. 一句话总结

**现有代码不是要推倒的东西，而是这次重设计里最省时间的部分** ——
Snowflake 主键、SSE 多路复用、附件链路、治理闭环这四块可以原样留用。

真正要投入的是：**把"默认公开"改造成"访问控制贯穿四读路径"（阶段 0），
然后把社群、讨论串、项目、AI 挂在同一个可见性 resolver 上。**

顺序上唯一的硬约束是：**可见性必须最先做**。不是因为它是最大的功能，
而是因为后做它的代价是"每个已完成的接口各改一遍"，而中间那段时间线上真有越权。
