/**
 * 消息列表的归并逻辑 —— 纯函数，零依赖。
 *
 * ── 为什么把它从组件里抽出来 ────────────────────────────────────────
 *
 * 这段逻辑原本内联在 `ChannelStream` 的 `useCallback` 里，靠 `useRef` 读最新
 * 状态。结果是它**没法被测试**，而它恰恰是最容易写错的一段：去重、乐观认领、
 * "更新"与"新增"的区别，三者混在一起时，错误的表现是静默的 ——
 * 消息不显示、或者显示旧内容，都不会报错。
 *
 * 抽出成纯函数之后，`scripts/test-message-list.mjs` 可以把这些情况穷举掉。
 *
 * ── 它修掉的那个真实缺陷 ────────────────────────────────────────────
 *
 * 原先 `message.created` / `message.updated` / `message.deleted` 三种事件
 * **走的是同一条回调**，而那条回调按 id 去重：
 *
 *     if (seen.current.has(m.id)) continue
 *
 * 于是"已存在消息的变更"被无条件丢弃。表现是：
 *   · A 补充了附件，B 那边要刷新页面才看得到
 *   · A 编辑了消息，B 那边一直显示旧内容
 *   · A 删了消息，B 那边那条消息还在
 *
 * 服务端广播是对的（smoke.mjs 能收到事件），错在客户端把它丢了 ——
 * 所以从外部看"实时已连接"，实际却不同步。这就是把"新增"和"变更"
 * 分成两个函数的原因：**新增要按 id 去重，变更必须按 id 覆盖**。
 */

/** 归并所需的最小字段集。用结构化类型而不是 import PublicMessage，保持零依赖 */
export type BasicMessage = {
  id: string
  channel_id: number
  content_md: string
  author: { id: number } | null
}

export type IngestResult<T> = {
  messages: T[]
  pending: T[]
}

/**
 * 处理**新消息**（`message.created`，含 SSE 与降级轮询两条来源）。
 *
 * 三件事：
 *   1. 按 id 去重（同一条消息可能从 SSE、轮询、补齐三条路径重复到达）
 *   2. 认领乐观条目 —— 自己刚发的那条本地已经渲染了，服务端回显要替换掉它
 *   3. 只把**本频道**的消息放进列表，但所有消息都记入 `seen`
 *      （否则切换频道回来后，之前见过的消息会被当成新的重新插入）
 *
 * @param seen 会被就地修改。跨批次共享同一个 Set 是刻意的：去重必须跨批次生效。
 */
export function ingestCreated<T extends BasicMessage>(input: {
  messages: T[]
  pending: T[]
  seen: Set<string>
  incoming: readonly T[]
  channelId: number
  /** 当前登录用户 id，未登录传 null */
  selfId: number | null
}): IngestResult<T> {
  const { seen, incoming, channelId, selfId } = input

  let messages = input.messages
  let pending = input.pending
  let messagesChanged = false
  let pendingChanged = false

  // 每个批次只允许认领**一个**乐观条目。
  // 放宽成"每个匹配都认领"会出错：纯附件消息的 content_md 是空串，
  // 连续上传两张图时，第二个回显会把另一个空内容的待确认条目也一起认掉。
  let claimed = false

  for (const m of incoming) {
    if (
      !claimed &&
      selfId !== null &&
      m.author?.id === selfId &&
      m.channel_id === channelId
    ) {
      const idx = pending.findIndex((p) => p.content_md === m.content_md)
      if (idx !== -1) {
        claimed = true
        // 只移除命中的那一条，而不是"所有同内容的"：
        // 用户连发两条相同内容时，后者仍是独立的待确认条目
        pending = pending.filter((_, i) => i !== idx)
        pendingChanged = true

        if (!seen.has(m.id)) {
          seen.add(m.id)
          if (!messagesChanged) messages = [...messages]
          messages.push(m)
          messagesChanged = true
        }
        continue
      }
    }

    if (seen.has(m.id)) continue
    seen.add(m.id)
    if (m.channel_id === channelId) {
      if (!messagesChanged) messages = [...messages]
      messages.push(m)
      messagesChanged = true
    }
  }

  // 没有任何变化时返回**原引用**，让调用方（React setState）能直接跳过重渲染
  return {
    messages: messagesChanged ? messages : input.messages,
    pending: pendingChanged ? pending : input.pending,
  }
}

/**
 * 处理**已存在消息的变更**（`message.updated` / `message.deleted`）。
 *
 * 按 id **覆盖**，而不是去重跳过 —— 这正是上面那个缺陷的修复点。
 *
 * 列表里没有的 id 一律忽略：消息列表是一个窗口（当前频道最近 N 条），
 * 变更事件完全可能指向窗口之外的消息（别的频道、或更早的历史）。
 * 把它们插进来会让时间线出现"凭空多出一条"的诡异现象。
 *
 * 没有任何命中时返回原引用，避免无意义的重渲染。
 */
export function applyMessageUpdate<T extends { id: string }>(
  messages: T[],
  updates: readonly T[],
): T[] {
  if (updates.length === 0) return messages

  const byId = new Map(updates.map((u) => [u.id, u]))
  let changed = false

  const next = messages.map((m) => {
    const u = byId.get(m.id)
    if (!u) return m
    changed = true
    return u
  })

  return changed ? next : messages
}

/**
 * 从列表与待确认集合里移除某条消息（本地删除成功后立即生效，不等广播）。
 * 同样在无变化时返回原引用。
 */
export function removeMessage<T extends { id: string }>(
  messages: T[],
  id: string,
): T[] {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx === -1) return messages
  return [...messages.slice(0, idx), ...messages.slice(idx + 1)]
}
