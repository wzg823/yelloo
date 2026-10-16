/**
 * 附件存储（本地卷实现）。
 *
 * ── 三条安全底线，改代码前务必先读 ─────────────────────────────────
 *
 * 1. **storageKey 绝不取用户提供的文件名。**
 *    用户文件名可以包含 `../`、`..\\`、绝对路径、NUL 字节。
 *    只要把它拼进路径，就等于开放任意文件写入 —— 攻击者可以覆盖
 *    `.env`、`docker-compose.yml`，甚至写进 authorized_keys。
 *    这里 key 完全由服务端生成：`YYYY/MM/<32位随机hex>.<白名单扩展名>`。
 *    原始文件名只作为**数据库字段**保存，用于展示与下载时的文件名。
 *
 * 2. **扩展名必须走白名单。**
 *    扩展名是唯一从用户输入保留到路径里的部分，所以它必须受控。
 *    同时它决定了浏览器/反代如何处理文件，因此 .html/.svg/.js 一律不放行
 *    （SVG 可以内嵌脚本，与前台同源时就是一个存储型 XSS）。
 *
 * 3. **单一根目录 + 落地前解析真实路径。**
 *    `resolveUploadPath()` 会校验解析结果仍在 UPLOAD_DIR 之内，
 *    这是对编码绕过（`%2e%2e%2f`、Unicode 变体）的最后一道防线。
 *
 * ── 为什么不存数据库 ──────────────────────────────────────────────
 * 大文件走 BLOB 会让 pg_dump 变得极慢、备份体积爆炸。
 * 文件系统 + 数据库只存元数据是标准做法，也便于将来换对象存储。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 允许的 MIME → 扩展名映射。未列出的类型一律拒绝 */
export const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // 刻意不支持 image/svg+xml：SVG 可内嵌 <script>，若被同源内联渲染即为存储型 XSS
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  // 开发日志常见格式
  'application/json': 'json',
  'text/csv': 'csv',
}

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** 单文件上限，默认 8MiB。与 .env 的 UPLOAD_MAX_BYTES 保持一致 */
export function maxUploadBytes(): number {
  const n = Number(process.env.UPLOAD_MAX_BYTES ?? 8 * 1024 * 1024)
  return Number.isFinite(n) && n > 0 ? n : 8 * 1024 * 1024
}

export function uploadRoot(): string {
  const dir = process.env.UPLOAD_DIR ?? './var/uploads'
  return path.resolve(dir)
}

/**
 * 生成存储 key 并返回落地信息。
 *
 * @param mime 已通过白名单校验的 MIME
 */
export function buildStorageKey(mime: string): string {
  const ext = ALLOWED_TYPES[mime]
  if (!ext) throw new Error(`不允许的类型：${mime}`)

  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')

  // 32 位十六进制随机名：不可猜测，避免"遍历 ID 就能下载别人的附件"
  const name = `${randomBytes(16).toString('hex')}.${ext}`
  return `${yyyy}/${mm}/${name}`
}

/**
 * 把 storageKey 解析为绝对路径，并确保结果不逃出根目录。
 *
 * 即使 buildStorageKey 是可信的，上传接口也可能收到被篡改的 key
 * （例如将来支持"客户端分片续传"），所以这里必须自校验。
 */
export function resolveUploadPath(storageKey: string): string {
  const root = uploadRoot()
  const full = path.resolve(root, storageKey)

  // 必须仍在 root 之内。注意比较时要带分隔符，
  // 否则 `/data/uploads-evil` 会被误判为在 `/data/uploads` 之内。
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new Error('非法的存储路径（越界）')
  }
  return full
}

export type SaveResult = {
  storageKey: string
  size: number
  sha256: string
}

/** 写入文件。返回 key、实际大小与内容摘要 */
export async function saveUpload(
  storageKey: string,
  data: Buffer,
): Promise<SaveResult> {
  const full = resolveUploadPath(storageKey)
  await mkdir(path.dirname(full), { recursive: true })

  // 权限 0644：Caddy 以另一个 uid 运行并需要读取该文件；
  // 若用 0600，反代直出附件时会得到 403 —— 这是很常见的一个坑。
  await writeFile(full, data, { mode: 0o644 })

  return {
    storageKey,
    size: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  }
}

export async function deleteUpload(storageKey: string): Promise<void> {
  try {
    await unlink(resolveUploadPath(storageKey))
  } catch {
    // 文件已不存在不算错误：删除消息时应当尽力而为，不应因此让事务失败
  }
}

/** 供健康检查/启动自检使用：确认目录存在且可写 */
export async function ensureUploadRoot(): Promise<{ dir: string; ok: boolean }> {
  const dir = uploadRoot()
  try {
    await mkdir(dir, { recursive: true })
    return { dir, ok: true }
  } catch {
    return { dir, ok: false }
  }
}

export function uploadRootExists(): boolean {
  return existsSync(uploadRoot())
}

/** 供前端展示：去掉平台分隔符，并且只保留安全字符 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? 'file'
  // 去掉控制字符与引号，避免 Content-Disposition 头注入
  const cleaned = base.replace(/[\u0000-\u001f\u007f"'`]/g, '').trim()
  return (cleaned || 'file').slice(0, 200)
}

/**
 * 附件的对外 URL。
 *
 * 路径前缀必须与 Caddyfile 的 `handle_path /_uploads/*` 一致 ——
 * Caddy 会剥掉该前缀，再从 `/srv/uploads` 下取文件，
 * 而 `/srv/uploads` 与应用的 `UPLOAD_DIR` 是同一个卷。
 * 两者错位会导致 404，且从应用日志里完全看不出问题。
 */
export function attachmentUrl(storageKey: string): string {
  return `/_uploads/${storageKey}`
}
