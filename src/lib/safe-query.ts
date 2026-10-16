/**
 * 查询容错包装。
 *
 * 为什么需要它（两个都真实存在的原因）：
 *
 * 1. **构建期无数据库。** 根布局会在每个页面渲染时执行，包括 /login 这类
 *    不依赖数据的页面。Next.js 在 `next build` 时会尝试预渲染它们，
 *    于是布局里的频道查询会连库并失败，直接中断整个构建。
 *    在 Docker builder 阶段（没有数据库可用）这是必然发生的。
 *
 * 2. **运行期数据库抖动不该让全站白屏。** 频道列表是"装饰性但全局"的数据：
 *    拿不到时侧栏为空，但用户仍然应该能读到自己正在看的消息。
 *    把这类查询降级为空数组，比返回 500 页面体验好得多。
 *
 * 注意：**只对装饰性/导航类查询使用**。消息正文、权限判定这类数据
 * 绝不能静默降级——那会让人误判"没有权限"或"没有内容"，比报错更危险。
 */
export async function safeQuery<T>(
  fn: () => Promise<T>,
  fallback: T,
  label: string,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: string }).code
        : undefined
    // 构建期属于预期情况，用 warn 而不是 error，避免日志噪音掩盖真问题
    console.warn(`[query] ${label} 降级为空结果${code ? ` (${code})` : ''}`)
    return fallback
  }
}
