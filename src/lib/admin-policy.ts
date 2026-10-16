/**
 * 管理动作的策略层 —— 纯函数，零 import。
 *
 * 与 `password-policy.ts` / `trust.ts` 同样的理由：这份策略会被 Node 原生
 * 类型擦除的脚本直接 import（`scripts/test-admin-policy.mjs`），所以不能有
 * 无扩展名的相对导入，也就不能引用 `permissions.ts`。
 *
 * ── 职责如何切分 ────────────────────────────────────────────────────
 *
 *   `permissions.ts`  回答"这个人有没有这个**能力**"（位运算）
 *   本文件            回答"这个人能不能对**那个对象**用这个能力"（等级关系）
 *
 * 两者必须都通过。缺了后者就会出现最危险的一类漏洞：
 * **横向提权** —— 一个版主把另一个版主封了，或者两个管理员互相封禁。
 * 位运算永远判不出这种问题，因为它看的是"能力"而不是"对象"。
 *
 * 这类规则一旦写错，后果是权限体系整体失效，而且往往要等到有人真的
 * 互相封禁才会被发现。所以它被写成纯函数并被穷举测试。
 */

// ─────────────────────────────────────────────────────────────
// 等级关系：防横向提权
// ─────────────────────────────────────────────────────────────

export type RoleName = 'member' | 'mod' | 'admin'

/**
 * 角色等级。数值只用于比较，任何时候都不要把它当权限位来用。
 *
 * 刻意与 `userRoleEnum` 的声明顺序无关：将来枚举里插一个新角色时，
 * 显式映射会逼着人想清楚它该排在哪一层，而 `indexOf` 会默默给出错答案。
 */
export function roleRank(role: string | null | undefined): number {
  switch (role) {
    case 'admin':
      return 2
    case 'mod':
      return 1
    case 'member':
      return 0
    default:
      // 未知角色按最低等级处理：宁可少给权限，也不要因为拼写错误放行
      return 0
  }
}

export type ModerationAction = 'mute' | 'ban' | 'kick' | 'set_role' | 'set_trust'

export type PolicyVerdict = { ok: true } | { ok: false; code: string; error: string }

const DENY = (code: string, error: string): PolicyVerdict => ({ ok: false, code, error })

/** 等级 → 中文名，只用于拼错误提示 */
function rankLabel(rank: number): string {
  if (rank >= 2) return '管理员'
  if (rank === 1) return '版主'
  return '普通成员'
}

/**
 * 能不能对某个用户执行某个处置动作。
 *
 * 只看**等级关系**，不看能力位（能力位由调用方用 `hasPerm` 判）。
 * 三条规则：
 *
 * 1. **不能处置自己**
 *    不只是防手滑：允许自我封禁等于给了一个"把自己锁在门外"的按钮，
 *    而恢复它需要命令行介入。禁言自己、修改自己的角色同理。
 *
 * 2. **只能处置等级严格低于自己的人**
 *    这是防横向提权的核心。`<=` 会让版主之间互相封禁、管理员互相封禁，
 *    而且双方都"有权限"，日志上看起来都合法。
 *
 * 3. **不能把别人提到与自己同级或更高**
 *    否则一个被盗的管理员账号可以立刻造出第二个管理员，把一次入侵
 *    变成永久占领。提升到 admin 必须走带外手段（`scripts/promote.mjs`
 *    或直接改库），那是需要深思熟虑并且会留下明显痕迹的操作。
 */
export function canModerateTarget(
  actor: { id: number; role: string | null | undefined },
  target: { id: number; role: string | null | undefined },
  action: ModerationAction,
): PolicyVerdict {
  if (actor.id === target.id) {
    return DENY('self_target', '不能对自己执行此操作')
  }

  const actorRank = roleRank(actor.role)
  const targetRank = roleRank(target.role)

  if (actorRank <= targetRank) {
    return DENY(
      'insufficient_rank',
      `不能对${rankLabel(targetRank)}执行此操作（只能处置等级低于自己的成员）`,
    )
  }

  if (action === 'set_role') {
    // 由调用方在拿到 newRole 后再调 canAssignRole；这里只保证基本关系成立
    return { ok: true }
  }

  return { ok: true }
}

/**
 * 能不能把某人设成某个角色。在 `canModerateTarget` 之上再加一条：
 * **新角色也必须严格低于自己**。
 */
export function canAssignRole(
  actor: { id: number; role: string | null | undefined },
  target: { id: number; role: string | null | undefined },
  newRole: string,
): PolicyVerdict {
  const base = canModerateTarget(actor, target, 'set_role')
  if (!base.ok) return base

  if (roleRank(actor.role) <= roleRank(newRole)) {
    return DENY(
      'role_too_high',
      `不能把成员提升为${newRole === 'admin' ? '管理员' : '同级或更高的角色'} —— ` +
        '这必须通过带外手段完成（scripts/promote.mjs），以免一个被盗账号立刻造出第二个管理员',
    )
  }

  return { ok: true }
}

// ─────────────────────────────────────────────────────────────
// 时长解析
// ─────────────────────────────────────────────────────────────

export type DurationResult =
  | { ok: true; ms: number | null }
  | { ok: false; error: string }

/** 单个时长单位的上限，防止输入 `999999d` 把 `until` 算到公元 4000 年 */
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000

/**
 * 解析处置时长：`30m` / `12h` / `7d` / `forever`。
 *
 * `forever`（以及 `0` / 空串）返回 `ms: null`，表示不设结束时间。
 * 之所以不做"默认值"，是因为静默选一个默认时长是危险的：
 * 想要永久封禁却拿到 1 天，和想要 1 小时却拿到永久，两者都是事故。
 * 调用方必须明确传入。
 */
export function parseDuration(raw: string | number | null | undefined): DurationResult {
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') {
    return { ok: true, ms: null }
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return { ok: false, error: '时长无效' }
    const ms = raw * 60_000
    if (ms > MAX_DURATION_MS) return { ok: false, error: '时长过长（上限 365 天）' }
    return { ok: true, ms }
  }

  const text = raw.trim().toLowerCase()
  if (text === 'forever' || text === 'permanent' || text === '永久') {
    return { ok: true, ms: null }
  }

  const m = /^(\d+)\s*([mhd])$/.exec(text)
  if (!m) {
    return { ok: false, error: `时长格式无效：${raw}（用 30m / 12h / 7d / forever）` }
  }

  const amount = Number(m[1])
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
  const ms = amount * unitMs

  if (amount === 0) return { ok: true, ms: null }
  if (ms > MAX_DURATION_MS) return { ok: false, error: '时长过长（上限 365 天）' }

  return { ok: true, ms }
}

// ─────────────────────────────────────────────────────────────
// 状态展示
// ─────────────────────────────────────────────────────────────

/**
 * 用户当前的**有效**状态，供管理列表展示。
 *
 * 与 `src/lib/session.ts` 的 `isMuted()` 必须保持一致 —— 那边负责拦截，
 * 这边负责显示。两边不一致的表现是"界面显示已解禁、实际还发不了言"，
 * 反过来则是"显示禁言中、其实早就能发了"。
 *
 * 刻意不共用同一个函数：`session.ts` 依赖 `next/headers`，脚本 import 不了它。
 * 折中办法是这里保持极简，并用 `test-admin-policy.mjs` 钉住它的语义。
 */
export function effectiveStatus(
  user: { status: string; mutedUntil: Date | number | null },
  now: number = Date.now(),
): 'active' | 'muted' | 'banned' {
  if (user.status === 'banned') return 'banned'
  if (user.status !== 'muted') return 'active'

  if (!user.mutedUntil) return 'muted'
  const until = user.mutedUntil instanceof Date ? user.mutedUntil.getTime() : user.mutedUntil
  return until > now ? 'muted' : 'active'
}

// ─────────────────────────────────────────────────────────────
// 频道
// ─────────────────────────────────────────────────────────────

/** slug 是公开 URL 的一部分，所以限制得比用户名更严（全小写、无下划线） */
export const CHANNEL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/

/**
 * 把用户输入的频道名规范化成 slug。
 *
 * 中文会被整体丢掉（slug 只允许 ASCII），所以中文名的频道必须同时填 slug，
 * 这里返回空串时调用方应当提示用户手填 —— 静默生成一个空 slug 会直接违反
 * 数据库的非空/唯一约束，报出一个与真实原因无关的错误。
 */
export function normalizeChannelSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

export type ChannelInput = {
  type: string
  readOnly?: boolean
  name: string
  slug: string
  topic?: string | null
  categoryId?: number | null
  position?: number
}

export type ChannelInputResult =
  | { ok: true; value: Required<Omit<ChannelInput, 'categoryId'>> & { categoryId: number | null } }
  | { ok: false; code: string; error: string }

/**
 * 校验并规范化频道输入。
 *
 * ★ 一条不能省的耦合 ★
 * `announce` 类型必须是只读的。若允许创建一个"非只读的公告频道"，
 * 权限判断里 `channel.readOnly` 与 `channel.type` 就会出现互相矛盾的组合，
 * 而发送消息的接口只看 `readOnly` —— 结果是人人都能在公告频道发言。
 * 这里强制把 announce 的 readOnly 纠正为 true，而不是报错：意图明显，
 * 没必要让调用方去猜。
 */
export function normalizeChannelInput(input: ChannelInput): ChannelInputResult {
  const name = (input.name ?? '').trim()
  if (name.length === 0) return { ok: false, code: 'invalid_name', error: '频道名不能为空' }
  if (name.length > 48) return { ok: false, code: 'invalid_name', error: '频道名最长 48 字符' }

  const slug = normalizeChannelSlug(input.slug ?? '')
  if (!CHANNEL_SLUG_RE.test(slug)) {
    return {
      ok: false,
      code: 'invalid_slug',
      error:
        'slug 需为 2-32 位小写字母/数字/连字符，且不能以连字符开头或结尾' +
        '（中文名请手填一个英文 slug，它是对外 URL 的一部分）',
    }
  }

  const type = ['text', 'forum', 'announce'].includes(input.type) ? input.type : 'text'
  const readOnly = type === 'announce' ? true : Boolean(input.readOnly)

  const topic = (input.topic ?? '')?.toString().trim() || null
  if (topic && topic.length > 200) {
    return { ok: false, code: 'invalid_topic', error: '话题最长 200 字符' }
  }

  const position = Number.isFinite(input.position) ? Math.trunc(input.position as number) : 0

  return {
    ok: true,
    value: {
      name,
      slug,
      type,
      readOnly,
      topic,
      categoryId: input.categoryId ?? null,
      position: position < 0 ? 0 : position,
    },
  }
}

/** 引用回复的显示长度等场景用得到：把长文本截断并加省略号 */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}
