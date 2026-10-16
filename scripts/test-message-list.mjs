/**
 * 消息列表归并逻辑的单元测试 —— 纯函数，不碰数据库、不发网络请求。
 *
 * 用法：
 *     node scripts/test-message-list.mjs
 *     npm run test:list
 *
 * ── 为什么值得单独测 ────────────────────────────────────────────────
 *
 * 这段逻辑原本内联在 React 组件的 useCallback 里，无法测试，而它已经出过
 * 一个很隐蔽的缺陷：**变更事件被去重逻辑丢弃**，导致"别人看不到你的编辑、
 * 也看不到消息被删"。它不报错、不崩溃，只是悄悄显示旧内容 ——
 * 属于最难靠手工点页面发现的那一类问题。
 *
 * 所以这里把补上修复之后的行为逐条钉住：
 *   · 新增：跨批次去重、乐观认领、只收本频道
 *   · 变更：按 id **覆盖**（而不是跳过）
 *   · 无变化时返回原引用（React 靠它跳过重渲染）
 */
import {
  applyMessageUpdate,
  ingestCreated,
  removeMessage,
} from '../src/lib/message-list.ts'

let passed = 0
const failures = []

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`\x1b[32m  ✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  } else {
    failures.push(name)
    console.log(`\x1b[31m  ✗\x1b[0m ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/** 造一条消息。字段刻意与 PublicMessage 对齐（snake_case） */
function msg(id, { channel = 1, content = `c${id}`, authorId = 100 } = {}) {
  return {
    id: String(id),
    channel_id: channel,
    content_md: content,
    author: { id: authorId },
  }
}

const CH = 1
const ME = 100

// ── 1. 新增：去重 ────────────────────────────────────────────────────
section('1. 新增消息（message.created）')

{
  const seen = new Set()
  const r = ingestCreated({
    messages: [],
    pending: [],
    seen,
    incoming: [msg(1), msg(2)],
    channelId: CH,
    selfId: ME,
  })
  ok('新消息按顺序追加', r.messages.map((m) => m.id).join(',') === '1,2')

  const r2 = ingestCreated({
    messages: r.messages,
    pending: r.pending,
    seen,
    incoming: [msg(2), msg(3)],
    channelId: CH,
    selfId: ME,
  })
  ok('重复到达的 id 被去重', r2.messages.map((m) => m.id).join(',') === '1,2,3')
}

{
  // SSE + 降级轮询 + 断线补齐三条路径可能送来同一批消息
  const seen = new Set()
  let state = { messages: [], pending: [] }
  for (let i = 0; i < 3; i += 1) {
    const r = ingestCreated({ ...state, seen, incoming: [msg(7), msg(8)], channelId: CH, selfId: ME })
    state = { messages: r.messages, pending: r.pending }
  }
  ok('三条路径重复投递同一批，列表仍只有两条', state.messages.length === 2, `实际 ${state.messages.length}`)
}

{
  const seen = new Set()
  const r = ingestCreated({
    messages: [],
    pending: [],
    seen,
    incoming: [msg(1, { channel: 9 }), msg(2, { channel: CH })],
    channelId: CH,
    selfId: ME,
  })
  ok('只收本频道的消息', r.messages.map((m) => m.id).join(',') === '2')
  ok('但其它频道的 id 也记入 seen', seen.has('1') && seen.has('2'), '否则切回频道会被当成新消息重复插入')
}

// ── 2. 新增：乐观认领 ────────────────────────────────────────────────
section('2. 乐观条目认领（自己刚发的那条）')

{
  const seen = new Set()
  const optimistic = msg(-1, { content: '你好', authorId: ME })
  const r = ingestCreated({
    messages: [],
    pending: [optimistic],
    seen,
    incoming: [msg(5, { content: '你好', authorId: ME })],
    channelId: CH,
    selfId: ME,
  })
  ok('服务端回显认领了乐观条目', r.pending.length === 0)
  ok('并且只插入一条（不会重复显示）', r.messages.length === 1 && r.messages[0].id === '5')
}

{
  const seen = new Set()
  const r = ingestCreated({
    messages: [],
    pending: [msg(-1, { content: '你好', authorId: ME })],
    seen,
    incoming: [msg(5, { content: '你好', authorId: 999 })],
    channelId: CH,
    selfId: ME,
  })
  ok('别人的同内容消息不会误认领我的乐观条目', r.pending.length === 1 && r.messages.length === 1)
}

{
  // 纯附件消息 content_md 是空串。两条空内容消息在同一个批次到达时，
  // 如果允许"每条都认领"，第二条会把另一个待确认条目也吃掉。
  const seen = new Set()
  const r = ingestCreated({
    messages: [],
    pending: [msg(-1, { content: '', authorId: ME }), msg(-2, { content: '', authorId: ME })],
    seen,
    incoming: [msg(5, { content: '', authorId: ME }), msg(6, { content: '', authorId: ME })],
    channelId: CH,
    selfId: ME,
  })
  ok(
    '一个批次只认领一个乐观条目',
    r.messages.length === 2 && r.pending.length === 1,
    `messages=${r.messages.length} pending=${r.pending.length}`,
  )
}

{
  // 用户连发两条相同内容：只应移除命中的那一条
  const seen = new Set()
  const r = ingestCreated({
    messages: [],
    pending: [msg(-1, { content: '重复', authorId: ME })],
    seen,
    incoming: [msg(5, { content: '重复', authorId: ME })],
    channelId: CH,
    selfId: ME,
  })
  ok('认领后 pending 为空', r.pending.length === 0 && r.messages.length === 1)
}

{
  const seen = new Set()
  const r = ingestCreated({
    messages: [],
    pending: [msg(-1, { content: '内容', authorId: ME })],
    seen,
    incoming: [msg(5, { content: '内容', authorId: ME })],
    channelId: CH,
    selfId: null, // 未登录
  })
  ok('未登录时不认领', r.pending.length === 1 && r.messages.length === 1)
}

// ── 3. 无变化时返回原引用 ────────────────────────────────────────────
section('3. 无变化时保持引用不变（React 靠它跳过重渲染）')

{
  const seen = new Set(['1'])
  const messages = [msg(1)]
  const pending = []
  const r = ingestCreated({ messages, pending, seen, incoming: [msg(1)], channelId: CH, selfId: ME })
  ok('重复消息：messages 引用不变', r.messages === messages)
  ok('重复消息：pending 引用不变', r.pending === pending)
}

{
  const seen = new Set(['1'])
  const messages = [msg(1)]
  const incoming = [msg(1, { channel: 9 })] // 别的频道，但已见过
  const r = ingestCreated({ messages, pending: [], seen, incoming, channelId: CH, selfId: ME })
  ok('其它频道消息不触发列表变化', r.messages === messages)
}

// ── 4. 变更：这是修掉缺陷的核心 ──────────────────────────────────────
section('4. 变更消息（message.updated / message.deleted）—— 必须覆盖而不是跳过')

{
  const messages = [msg(1, { content: '原文' }), msg(2)]
  const updated = applyMessageUpdate(messages, [msg(1, { content: '改过' })])
  ok('已存在消息被覆盖', updated[0].content_md === '改过')
  ok('其它消息保持不变', updated[1] === messages[1])
  ok('位置不变（不是追加到末尾）', updated.map((m) => m.id).join(',') === '1,2')
}

{
  const messages = [msg(1)]
  const deleted = { ...msg(1, { content: '' }), is_deleted: true }
  const updated = applyMessageUpdate(messages, [deleted])
  ok('删除事件把消息替换成墓碑', updated[0].is_deleted === true && updated[0].content_md === '')
}

{
  const messages = [msg(1)]
  const updated = applyMessageUpdate(messages, [msg(99, { content: '窗口之外' })])
  ok('列表里没有的 id 被忽略（不凭空插入）', updated === messages && updated.length === 1)
}

{
  const messages = [msg(1), msg(2)]
  const same = messages.map((m) => ({ ...m }))
  ok('无命中时返回原引用', applyMessageUpdate(messages, []) === messages)
  ok('命中时返回新数组', applyMessageUpdate(messages, [msg(1)]) !== messages)
  void same
}

{
  const messages = [msg(1), msg(2), msg(3)]
  const updated = applyMessageUpdate(messages, [msg(1, { content: 'a' }), msg(3, { content: 'c' })])
  ok('一个批次里的多条变更都生效', updated[0].content_md === 'a' && updated[2].content_md === 'c')
  ok('未命中的中间那条保持原对象', updated[1] === messages[1])
}

// ── 5. 本地移除 ──────────────────────────────────────────────────────
section('5. 本地移除（删除成功后立即生效，不等广播）')

{
  const messages = [msg(1), msg(2)]
  const next = removeMessage(messages, '1')
  ok('移除命中项', next.map((m) => m.id).join(',') === '2')
  ok('未命中时返回原引用', removeMessage(messages, '99') === messages)
}

// ── 6. 端到端串起来：编辑与删除的完整时序 ────────────────────────────
section('6. 时序串联：A 编辑 / 删除，B 端应当看到什么')

{
  // B 端已有这条消息
  const seen = new Set(['10'])
  let messages = [msg(10, { content: '第一版', authorId: 200 })]
  let pending = []

  // A 编辑 → 服务端广播 message.updated
  messages = applyMessageUpdate(messages, [msg(10, { content: '第二版', authorId: 200 })])
  ok('编辑后 B 端看到新内容', messages[0].content_md === '第二版')
  ok('编辑不会产生重复条目', messages.length === 1)

  // A 删除 → 服务端广播 message.deleted
  messages = applyMessageUpdate(messages, [
    { ...msg(10, { content: '', authorId: 200 }), is_deleted: true },
  ])
  ok('删除后 B 端看到墓碑', messages[0].is_deleted === true)
  ok('墓碑仍占原位（不消失）', messages.length === 1 && messages[0].id === '10')

  // 用 ingestCreated 模拟"有人把变更当新增投递"——应当被去重挡住，
  // 这正是修复前发生的事：变更被当成已见过的消息丢弃
  const before = messages
  const r = ingestCreated({
    messages,
    pending,
    seen,
    incoming: [msg(10, { content: '第二版', authorId: 200 })],
    channelId: CH,
    selfId: ME,
  })
  pending = r.pending
  ok(
    '对照：变更若走"新增"路径会被丢弃（这就是修复前的行为）',
    r.messages === before,
    '所以必须分成两个函数，而不是靠调用方自觉',
  )
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
console.log(`\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failures.length}`)
if (failures.length > 0) {
  console.log('\n\x1b[31m失败项：\x1b[0m')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('\n\x1b[32m全部通过。去重、乐观认领与变更覆盖均已验证。\x1b[0m')
}
