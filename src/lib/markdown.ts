/**
 * Markdown 渲染 —— 白名单式，先转义再按规则替换。
 *
 * 为什么不用 markdown-it / react-markdown：
 * 那些库默认允许内联 HTML，必须再挂一个 HTML 消毒器（rehype-sanitize 之类）。
 * 消毒器配置错一处就是存储型 XSS，而论坛的 XSS 直接等于"后台被拿下"。
 *
 * 这里的策略更保守也更难写错：
 *   1. 第一步就把全部 `& < > "` 转义 —— 此后 HTML 已不可能被注入
 *   2. 只识别我们显式支持的语法，其余原样呈现为文本
 *   3. 链接单独校验协议，拒绝 javascript:/data:
 *
 * 代价：不支持表格、脚注、内联 HTML。对技术社区来说完全可接受。
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c)
}

/** 链接协议白名单。相对链接（/path、#anchor）也放行 */
function sanitizeUrl(raw: string): string | null {
  const url = raw.trim()
  if (url === '') return null
  if (/^[/#]/.test(url)) return url
  if (/^(https?:|mailto:)/i.test(url)) return url
  // 其余一律拒绝：javascript:、data:、vbscript:、file: 等
  return null
}

/** 代码高亮用的语言标识，只允许字母数字，防止被拼进 class 属性做注入 */
function normalizeLang(raw: string | undefined): string {
  if (!raw) return 'plaintext'
  const lang = raw.trim().toLowerCase()
  return /^[a-z0-9+#._-]{1,20}$/.test(lang) ? lang : 'plaintext'
}

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; lines: string[] }

/** 第一阶段：把文本切成块级结构（代码块必须先摘出来，否则内部会被当语法解析） */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 围栏代码块 ``` 或 ~~~
    const fence = /^\s*(```|~~~)\s*([^\s`]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1] as string
      const lang = normalizeLang(fence[2])
      const body: string[] = []
      i += 1
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1 // 跳过结束围栏（若缺失则到文件末尾）
      blocks.push({ kind: 'code', lang, code: body.join('\n') })
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        text: (heading[2] as string).trim(),
      })
      i += 1
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', lines: quote })
      continue
    }

    // 列表（有序 / 无序连续收集）
    const bullet = /^\s*([-*+])\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(cur) : /^\s*[-*+]\s+(.*)$/.exec(cur)
        if (!m) break
        items.push(m[1] as string)
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // 空行
    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }

    // 普通段落：收集到空行或下一个块级标记为止
    const para: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ''
      if (
        /^\s*$/.test(cur) ||
        /^\s*(```|~~~)/.test(cur) ||
        /^(#{1,6})\s+/.test(cur) ||
        /^\s*>\s?/.test(cur) ||
        /^\s*([-*+])\s+/.test(cur) ||
        /^\s*\d+[.)]\s+/.test(cur)
      ) {
        break
      }
      para.push(cur)
      i += 1
    }
    blocks.push({ kind: 'para', lines: para })
  }

  return blocks
}

/**
 * 行内语法。输入必须已经过 escapeHtml。
 * 顺序很重要：先处理代码片段并替换为占位符，避免 `**` 出现在代码里被误解析。
 */
function renderInline(input: string): string {
  const codeSpans: string[] = []

  // 1) 行内代码 → 占位符（\u0000 不会出现在正常文本中）
  let text = input.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code class="inline-code">${code}</code>`)
    return `\u0000${codeSpans.length - 1}\u0000`
  })

  // 2) 加粗
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')

  // 3) 斜体（避免吃掉已生成的 strong 标签）
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')

  // 4) 删除线
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')

  // 5) 链接。原文已是 HTML 转义态，URL 里若含 " 已变成 &quot;，不影响属性闭合
  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const safe = sanitizeUrl(url.replace(/&amp;/g, '&'))
    if (!safe) return match // 不安全就原样显示，不生成 <a>
    const href = escapeHtml(safe)
    return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow ugc">${label}</a>`
  })

  // 6) 裸链接自动转链（技术社区里贴 URL 是常态）
  text = text.replace(
    /(^|[\s(])((?:https?:\/\/)[^\s<>()]+)/g,
    (match, pre: string, url: string) =>
      `${pre}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow ugc">${url}</a>`,
  )

  // 7) 还原行内代码
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => codeSpans[Number(idx)] ?? '')

  // 8) 换行转 <br>（GFM 风格软换行）
  text = text.replace(/\n/g, '<br>')

  return text
}

export function renderMarkdown(source: string): string {
  if (!source) return ''

  const blocks = parseBlocks(source)
  const out: string[] = []

  for (const block of blocks) {
    switch (block.kind) {
      case 'code':
        // 代码内容必须转义，且不能参与行内解析——预格式文本里一切都是字面量
        out.push(
          `<div class="code-block" data-lang="${escapeHtml(block.lang)}">` +
            `<div class="code-head"><span class="code-lang">${escapeHtml(block.lang)}</span></div>` +
            `<pre><code class="language-${escapeHtml(block.lang)}">${escapeHtml(block.code)}</code></pre>` +
            `</div>`,
        )
        break
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.level))
        out.push(`<h${level}>${renderInline(escapeHtml(block.text))}</h${level}>`)
        break
      }
      case 'hr':
        out.push('<hr>')
        break
      case 'quote': {
        const inner = parseBlocks(block.lines.join('\n'))
          .map((b) => (b.kind === 'para' ? renderInline(escapeHtml(b.lines.join('\n'))) : ''))
          .filter(Boolean)
          .join('<br>')
        out.push(`<blockquote>${inner}</blockquote>`)
        break
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul'
        const items = block.items
          .map((it) => `<li>${renderInline(escapeHtml(it))}</li>`)
          .join('')
        out.push(`<${tag}>${items}</${tag}>`)
        break
      }
      case 'para':
        out.push(`<p>${renderInline(escapeHtml(block.lines.join('\n')))}</p>`)
        break
    }
  }

  return out.join('\n')
}

/** 从 Markdown 提取纯文本，用于 <title>/meta description/sitemap */
export function markdownToPlainText(source: string, limit = 200): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题符
    .replace(/^\s*>\s?/gm, '') // 引用符
    .replace(/^\s*[-*+]\s+/gm, '') // 列表符
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}
