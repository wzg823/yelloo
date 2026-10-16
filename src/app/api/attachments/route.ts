/**
 * POST /api/attachments —— 上传附件并挂到已存在的消息上。
 *
 * ── 为什么是"先发消息，再传附件" ────────────────────────────────────
 * 反过来（先传后发）需要一个 drafts 表 + 定时清理孤儿文件，复杂度高很多。
 * 当前顺序的代价是：消息先以无附件状态短暂出现（前端显示上传中），
 * 上传完成后通过 SSE 的 message.updated 事件把附件补上。
 * 对"贴一张截图/一段日志"这个场景，这个折中完全够用。
 *
 * ── 校验顺序（从便宜到昂贵，且先鉴权后落盘）────────────────────────
 *   登录 → 频率限制 → 消息存在且属于自己 → 类型白名单 → 大小上限 → 写盘 → 记账
 */
import type { NextRequest } from 'next/server'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { attachments, messages } from '@/db/schema'
import { AUDIT, audit } from '@/lib/audit'
import { PERM, hasPerm } from '@/lib/permissions'
import { RATE_RULES, clientIp, consume } from '@/lib/ratelimit'
import { deliver } from '@/lib/realtime/hub'
import { errorResponse, jsonResponse } from '@/lib/serialize'
import { getCurrentUser, isMuted } from '@/lib/session'
import { getMessageById } from '@/lib/queries'
import {
  ALLOWED_TYPES,
  IMAGE_TYPES,
  attachmentUrl,
  buildStorageKey,
  maxUploadBytes,
  sanitizeFilename,
  saveUpload,
} from '@/lib/storage'
import { parseId } from '@/lib/snowflake'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 单条消息最多多少个附件，防止刷屏与磁盘滥用 */
const MAX_PER_MESSAGE = 6

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return errorResponse(401, '需要登录', 'unauthorized')

  if (!hasPerm(user.perms, PERM.ATTACH_FILES)) {
    return errorResponse(403, '你没有上传附件的权限', 'forbidden')
  }
  if (isMuted(user)) {
    return errorResponse(403, '禁言期间不能上传附件', 'muted')
  }

  const ip = clientIp(req.headers)
  const limit = consume(`upload:user:${user.id}`, RATE_RULES.upload)
  if (!limit.ok) {
    return jsonResponse(
      { error: '上传过于频繁，请稍后再试', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    )
  }

  // Content-Length 预检：在解析 multipart 之前就拒绝超大请求，
  // 避免把 100MB 读进内存后才报错（那是一台小机器被打死的常见方式）
  const declared = Number(req.headers.get('content-length') ?? 0)
  const cap = maxUploadBytes()
  if (Number.isFinite(declared) && declared > cap + 64 * 1024) {
    return errorResponse(
      413,
      `文件过大，上限 ${Math.round(cap / 1024 / 1024)}MB`,
      'payload_too_large',
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return errorResponse(400, '请求体不是合法的 multipart/form-data', 'bad_form')
  }

  const messageId = parseId(form.get('message_id'))
  if (messageId === null) {
    return errorResponse(400, 'message_id 无效', 'invalid_message')
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return errorResponse(400, '缺少 file 字段', 'missing_file')
  }

  // 找到消息并确认归属：只能给自己的消息加附件
  const msgRows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      authorId: messages.authorId,
      attachmentCount: messages.attachmentCount,
      isDeleted: messages.isDeleted,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)

  const msg = msgRows[0]
  if (!msg || msg.isDeleted) {
    return errorResponse(404, '消息不存在或已删除', 'message_not_found')
  }
  if (msg.authorId !== user.id) {
    // 不区分"消息不存在"与"不是你的"，避免探测他人消息是否存在
    return errorResponse(403, '只能给自己发送的消息添加附件', 'not_owner')
  }
  if (msg.attachmentCount >= MAX_PER_MESSAGE) {
    return errorResponse(
      400,
      `单条消息最多 ${MAX_PER_MESSAGE} 个附件`,
      'too_many_attachments',
    )
  }

  const mime = (file.type || 'application/octet-stream').toLowerCase().split(';')[0]!.trim()
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, mime)) {
    return errorResponse(
      415,
      `不支持的文件类型：${mime}。允许：${Object.keys(ALLOWED_TYPES).join(', ')}`,
      'unsupported_type',
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.byteLength === 0) {
    return errorResponse(400, '文件为空', 'empty_file')
  }
  if (buffer.byteLength > cap) {
    return errorResponse(
      413,
      `文件过大，上限 ${Math.round(cap / 1024 / 1024)}MB`,
      'payload_too_large',
    )
  }

  // key 完全由服务端生成。原始文件名只入库用于展示，不参与路径拼接
  const storageKey = buildStorageKey(mime)
  const filename = sanitizeFilename(file.name || 'file')

  let saved
  try {
    saved = await saveUpload(storageKey, buffer)
  } catch (err) {
    console.error('[attachments] save failed:', err)
    return errorResponse(500, '文件保存失败', 'storage_error')
  }

  let insertedId: number
  try {
    insertedId = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(attachments)
        .values({
          messageId,
          uploaderId: user.id,
          filename,
          mime,
          size: saved.size,
          storageKey: saved.storageKey,
        })
        .returning({ id: attachments.id })

      await tx
        .update(messages)
        .set({
          attachmentCount: sql`${messages.attachmentCount} + 1`,
          // 带附件视为一次编辑，让客户端知道要刷新该消息
          editedAt: new Date(),
        })
        .where(eq(messages.id, messageId))

      return rows[0]!.id
    })
  } catch (err) {
    console.error('[attachments] db failed:', err)
    // 数据库记账失败则删掉刚落盘的文件，避免产生无法访问的孤儿文件
    const { deleteUpload } = await import('@/lib/storage')
    await deleteUpload(storageKey)
    return errorResponse(500, '附件记录写入失败', 'db_error')
  }

  const payload = {
    id: insertedId,
    message_id: messageId.toString(),
    filename,
    mime,
    size: saved.size,
    url: attachmentUrl(saved.storageKey),
    is_image: IMAGE_TYPES.has(mime),
  }

  await audit({
    actorId: user.id,
    action: AUDIT.MESSAGE_EDIT,
    targetType: 'message',
    targetId: messageId,
    meta: { attachment: filename, mime, size: saved.size },
    ip,
  })

  // 广播更新后的消息（含新附件），让其他客户端立刻看到
  const updated = await getMessageById(messageId)
  if (updated) {
    deliver({
      type: 'message.updated',
      cursor: updated.id,
      channelId: msg.channelId,
      payload: { message: updated },
    })
  }

  return jsonResponse({ attachment: payload }, { status: 201 })
}

/** GET /api/attachments?message_ids=a,b,c —— 批量取附件元数据 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('message_ids') ?? ''
  const ids = raw
    .split(',')
    .map((s) => parseId(s.trim()))
    .filter((v): v is bigint => v !== null)
    .slice(0, 100)

  if (ids.length === 0) return jsonResponse({ attachments: {} })

  const rows = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      filename: attachments.filename,
      mime: attachments.mime,
      size: attachments.size,
      storageKey: attachments.storageKey,
    })
    .from(attachments)
    // 用 inArray 而不是 sql`in ${ids}`：后者不会把数组展开成占位符列表
    .where(inArray(attachments.messageId, ids))

  const grouped: Record<string, unknown[]> = {}
  for (const r of rows) {
    const key = r.messageId.toString()
    ;(grouped[key] ??= []).push({
      id: r.id,
      message_id: key,
      filename: r.filename,
      mime: r.mime,
      size: r.size,
      url: attachmentUrl(r.storageKey),
      is_image: IMAGE_TYPES.has(r.mime),
    })
  }

  return jsonResponse({ attachments: grouped })
}
