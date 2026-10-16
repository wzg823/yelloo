-- ─────────────────────────────────────────────────────────────────────────
-- 手写迁移：中文可用的消息搜索
--
-- 为什么必须手写：
--   PostgreSQL 内置的全文检索（to_tsvector）**不支持中文分词**。
--   'simple' 配置会把一整句中文当成一个词元，导致搜"数据库"匹配不到
--   "我们的数据库设计"。常见的解法是 zhparser / pg_jieba，但它们要求
--   在数据库服务器上安装额外扩展，国内云数据库（RDS）通常不允许。
--
-- 采用的方案：pg_trgm（三元组相似度）。
--   - 完全内置，云数据库都默认提供，无需编译或安装
--   - 对中英文都能工作：中文按字符三元组切分，英文按字符 n-gram
--   - GIN + gin_trgm_ops 索引让 `%` 与 `similarity()` 走索引，而不是全表扫描
--
-- 取舍（务必知悉）：
--   - **不做词干化/同义词**。搜"索引"不会自动匹配"indexes"。
--     对技术社区可以接受：开发者倾向精确术语检索。
--   - 索引体积比 tsvector 大。按消息正文算约为原文的 1.5~3 倍。
--     若数据量增长到磁盘吃紧，改用 zhparser 或外置搜索引擎是正常的演进路径。
--
-- 规模提醒：pg_trgm 的 GIN 索引在千万行级别仍可用，但写入放大会变明显。
-- 到那个量级时应考虑把搜索剥离到独立服务（Meilisearch 等），
-- 而不是继续加大这个索引。
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- 消息正文检索。GIN 索引支持 % 相似度运算符与 similarity() 阈值过滤
CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx"
  ON "messages" USING gin ("content_md" gin_trgm_ops);
--> statement-breakpoint

-- 频道名/主题检索（首页与侧栏搜索）
CREATE INDEX IF NOT EXISTS "channels_name_trgm_idx"
  ON "channels" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint

-- 用户名检索（@提及补全、用户查找）
CREATE INDEX IF NOT EXISTS "users_handle_trgm_idx"
  ON "users" USING gin ("handle" gin_trgm_ops);
