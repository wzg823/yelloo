'use client'

/**
 * 发言框。
 *
 * ── 交互约定 ────────────────────────────────────────────────────
 *   Enter        发送
 *   Shift+Enter  换行
 *   Esc          取消回复引用；若无引用则清空附件
 *   输入法组合中 不触发发送（中文输入必需，否则选词回车会把半句话发出去）
 *
 * ── 关于附件 ────────────────────────────────────────────────────
 * 附件不在本组件上传：这里只负责"选中与暂存"，发送时把 File 列表交给上层。
 * 原因：上传必须发生在消息创建之后（拿到 message_id 才能挂），
 * 而这个顺序只有上层知道。组件保持"只收集输入"的单一职责。
 */
import { useEffect, useRef, useState } from 'react'
import { useSession } from '@/lib/session-context'
import type { PublicMessage } from '@/lib/serialize'

const MAX_LEN = 8000
const MAX_FILES = 6
const MAX_FILE_BYTES = 8 * 1024 * 1024

/** 与 src/lib/storage.ts 的 ALLOWED_TYPES 保持一致 */
const ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/zip,application/gzip'

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function Composer({
  placeholder,
  disabled,
  replyTo,
  onSend,
  onCancelReply,
}: {
  placeholder: string
  disabled: boolean
  replyTo?: PublicMessage | null
  onSend: (
    content: string,
    replyTo: PublicMessage | null,
    files: File[],
  ) => Promise<string | null>
  onCancelReply?: () => void
}) {
  const user = useSession()
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 高度自适应：最多 320px，超过则内部滚动
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [value])

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return
    setError(null)

    const next = [...files]
    for (const f of Array.from(incoming)) {
      if (next.length >= MAX_FILES) {
        setError(`最多 ${MAX_FILES} 个附件`)
        break
      }
      if (f.size > MAX_FILE_BYTES) {
        setError(`「${f.name}」超过 ${humanSize(MAX_FILE_BYTES)} 上限`)
        continue
      }
      if (f.size === 0) {
        setError(`「${f.name}」是空文件`)
        continue
      }
      // 同名同大小视为重复，避免误选两次
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue
      next.push(f)
    }
    setFiles(next)

    // 清空 input.value，否则连续选择同一个文件不会触发 change 事件
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const submit = async () => {
    if (sending || disabled) return
    const content = value.trim()

    // 允许"只有附件没有文字"：贴截图往往不需要配文
    if (!content && files.length === 0) return
    if (content.length > MAX_LEN) {
      setError(`内容过长，上限 ${MAX_LEN} 字符`)
      return
    }

    setSending(true)
    setError(null)
    const err = await onSend(content, replyTo ?? null, files)
    setSending(false)

    if (err) {
      // 失败时**保留草稿与附件**——技术讨论里常是长段落，
      // 发失败还清空会让人很恼火
      setError(err)
      return
    }
    setValue('')
    setFiles([])
    onCancelReply?.()
  }

  if (!user) {
    return (
      <div className="composer">
        <div className="composer-signin">
          <span>登录后即可参与讨论</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <a className="btn btn-ghost" href="/login">
              登录
            </a>
            <a className="btn btn-primary" href="/register">
              注册
            </a>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        {replyTo && (
          <div className="composer-context">
            <span>
              正在回复{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>
                {replyTo.author?.display_name ?? replyTo.author?.handle ?? '已注销用户'}
              </strong>
            </span>
            <button type="button" className="icon-btn" onClick={onCancelReply}>
              取消
            </button>
          </div>
        )}

        {files.length > 0 && (
          <div className="composer-files">
            {files.map((f, i) => (
              <div className="composer-file" key={`${f.name}-${f.size}-${i}`}>
                <span className="composer-file-name" title={f.name}>
                  {f.name}
                </span>
                <span className="composer-file-size">{humanSize(f.size)}</span>
                <button
                  type="button"
                  className="composer-file-remove"
                  onClick={() => removeFile(i)}
                  aria-label={`移除 ${f.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          disabled={disabled || sending}
          maxLength={MAX_LEN}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
            if (e.key === 'Escape') {
              if (replyTo) onCancelReply?.()
              else if (files.length > 0) setFiles([])
            }
          }}
        />

        {error && <div className="composer-error">{error}</div>}

        <div className="composer-bar">
          <span className="composer-hint">
            Enter 发送 · Shift+Enter 换行 · 支持 Markdown 与 ``` 代码块
          </span>
          <div className="composer-actions">
            <span className="composer-hint">
              {value.length > MAX_LEN - 500 ? `${value.length}/${MAX_LEN}` : ''}
            </span>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => addFiles(e.target.files)}
            />
            <button
              type="button"
              className="icon-btn"
              title="添加附件（图片、PDF、文本、压缩包；单文件 8MB）"
              disabled={disabled || sending || files.length >= MAX_FILES}
              onClick={() => fileInputRef.current?.click()}
            >
              附件
            </button>

            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || sending || (!value.trim() && files.length === 0)}
              onClick={() => void submit()}
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
