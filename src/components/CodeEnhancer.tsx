'use client'

/**
 * 给代码块挂"复制"按钮。
 *
 * 为什么用 DOM 增强而不是在 Markdown 渲染时输出 <button>：
 *   1. 渲染发生在服务端，服务端渲染的按钮没有事件处理（除非再水合每个代码块，
 *      那会让一条含 5 段代码的消息产生 5 个客户端组件边界）
 *   2. 消息内容会通过 SSE 动态追加，渲染期绑定会漏掉后到的消息
 *
 * MutationObserver 覆盖了上面两种情况：静态首屏与后续追加都能生效。
 *
 * 已知限制：`navigator.clipboard` 在非 HTTPS 环境不可用。
 * 中国大陆生产环境走备案域名 + HTTPS，因此正常；本地开发用 localhost 也允许。
 */
import { useEffect } from 'react'

export function CodeEnhancer() {
  useEffect(() => {
    const decorate = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>('.code-block').forEach((block) => {
        const head = block.querySelector('.code-head')
        if (!head || head.querySelector('.code-copy')) return

        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'code-copy'
        btn.textContent = '复制'

        btn.addEventListener('click', async () => {
          const code = block.querySelector('code')
          const text = code?.textContent ?? ''
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(text)
            } else {
              // 回退路径：clipboard API 不可用（HTTP 环境）时用 execCommand
              const ta = document.createElement('textarea')
              ta.value = text
              ta.style.position = 'fixed'
              ta.style.opacity = '0'
              document.body.appendChild(ta)
              ta.select()
              document.execCommand('copy')
              ta.remove()
            }
            btn.textContent = '已复制'
          } catch {
            btn.textContent = '复制失败'
          }
          setTimeout(() => {
            btn.textContent = '复制'
          }, 1500)
        })

        head.appendChild(btn)
      })
    }

    decorate(document)

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue
          const el = node as HTMLElement
          if (el.classList.contains('code-block')) {
            decorate(el.parentElement ?? document)
          } else if (el.querySelector?.('.code-block')) {
            decorate(el)
          }
        }
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return null
}
