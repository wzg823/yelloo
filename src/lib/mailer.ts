/**
 * 邮件发送 —— 可插拔的通道。
 *
 * ── 为什么默认通道是 "log" 而不是报错 ────────────────────────────────
 *
 * 绝大多数部署在前几周并没有配好邮件服务（要域名、要 SPF/DKIM 记录、
 * 大陆还要考虑送达率）。如果缺配置就让"忘记密码"接口直接 500，
 * 那这个功能在配好邮件之前等于**把站点搞出一个 500**。
 *
 * 所以默认行为是：**流程正常走完、令牌正常入库、邮件内容写进日志**。
 * 用户点不到链接（因为没收到邮件），但：
 *   · 服务端不报错，其他功能不受影响
 *   · 运维能从日志里看到"有人申请了重置"，必要时用 `set-password.mjs` 人工处理
 *   · 配置好通道后，同一个流程立刻开始真的发信，代码不用改
 *
 * ── 三个通道 ────────────────────────────────────────────────────────
 *
 *   log     默认。把收件人与主题写进 stdout，**不写正文**（正文里有令牌）
 *   file    开发/验证用。把整封邮件（含链接）写成 `MAIL_DIR` 下的 JSON 文件，
 *           相当于一个"本地信箱"，端到端验证脚本从那里取令牌。
 *           生产环境不要用 —— 它把可用的重置链接落到了磁盘上。
 *   resend  Resend 的 HTTP API（https://resend.com）。选它是因为接口最简单，
 *           一个 POST 就够。要接阿里云邮件推送/SendGrid，在这个文件里加一个
 *           adapter 即可，上层代码不用动。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export type MailMessage = {
  to: string
  subject: string
  text: string
}

export type MailSendResult = {
  ok: boolean
  transport: string
  /** 成功时的补充信息（如文件通道落盘的路径） */
  detail?: string
  error?: string
}

export type MailTransport = 'log' | 'file' | 'resend'

export function mailTransport(): MailTransport {
  const raw = (process.env.MAIL_TRANSPORT ?? 'log').trim().toLowerCase()
  if (raw === 'file' || raw === 'resend') return raw
  return 'log'
}

export function mailFrom(): string {
  return process.env.MAIL_FROM?.trim() || 'no-reply@localhost'
}

function mailDir(): string {
  return process.env.MAIL_DIR?.trim() || './var/mail'
}

/**
 * 发一封信。
 *
 * **刻意不抛异常**：调用方是"忘记密码"接口，它对外必须永远返回同一句
 * "如果该邮箱存在，我们已发送重置邮件"。邮件发送失败不能改变这个响应，
 * 否则"发信失败"就成了一个可观测的信号 —— 攻击者据此可以判断邮箱是否存在。
 * 失败信息通过返回值传出，由调用方记日志。
 */
export async function sendMail(msg: MailMessage): Promise<MailSendResult> {
  const transport = mailTransport()

  try {
    if (transport === 'log') {
      // 只记收件人与主题。正文里有一次性令牌，日志往往会长期留存、
      // 被同步到日志平台，把令牌写进去等于把它变成长期凭据
      console.info(`[mail:log] → ${msg.to} · ${msg.subject}`)
      return { ok: true, transport, detail: '已写入日志（未包含正文）' }
    }

    if (transport === 'file') {
      const dir = mailDir()
      await mkdir(dir, { recursive: true })
      const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`
      const path = join(dir, name)
      await writeFile(
        path,
        JSON.stringify({ ...msg, from: mailFrom(), sentAt: new Date().toISOString() }, null, 2),
        'utf8',
      )
      console.info(`[mail:file] → ${msg.to} · ${path}`)
      return { ok: true, transport, detail: path }
    }

    // ── resend ────────────────────────────────────────────────────
    const apiKey = process.env.MAIL_API_KEY?.trim()
    if (!apiKey) {
      return { ok: false, transport, error: 'MAIL_TRANSPORT=resend 但没有设置 MAIL_API_KEY' }
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailFrom(),
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      }),
      // 邮件服务偶发慢响应时不要拖住整个请求
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        transport,
        error: `HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`,
      }
    }

    return { ok: true, transport }
  } catch (err) {
    return {
      ok: false,
      transport,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
