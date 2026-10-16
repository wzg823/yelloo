-- ─────────────────────────────────────────────────────────────────────────
-- attachments.message_id 改为 NOT NULL
--
-- 理由：附件必须先挂到一条已存在的消息上（流程见 /api/attachments 的说明），
-- "没有归属消息的附件"这个状态没有任何业务含义，却迫使每个查询都判空。
--
-- 注意：如果库里已有 message_id 为 NULL 的历史行，这条语句会失败——
-- 那正是我们想要的行为（暴露脏数据），而不是静默丢弃它们。
-- 清理方式：
--     DELETE FROM attachments WHERE message_id IS NULL;
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "attachments" ALTER COLUMN "message_id" SET NOT NULL;
--> statement-breakpoint

-- ★ 下面这行是 drizzle-kit 自动生成的，必须手工加 IF NOT EXISTS ★
--
-- 原因：`messages_content_trgm_idx` 是手写迁移 0001 建的（GIN + pg_trgm），
-- 同时又在 src/db/schema.ts 里声明过（为了让后续 schema diff 不把它删掉）。
-- drizzle-kit 因此认为"schema 里有、快照里没有"，于是在这里重复创建。
-- 不加 IF NOT EXISTS 的话，迁移会在这一步报：
--     ERROR: relation "messages_content_trgm_idx" already exists
-- 而它发生在首次部署的迁移阶段，会把整个部署中断。
CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx"
  ON "messages" USING gin ("content_md" gin_trgm_ops);
