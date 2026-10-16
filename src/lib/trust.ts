/**
 * 新人限流策略 —— 纯策略层，**零 import**。
 *
 * ── 为什么是一个零依赖的独立文件 ────────────────────────────────────
 *
 * 和 `password-policy.ts` 同样的理由：这份策略有两个消费者，而它们的
 * 模块解析方式不同。
 *
 *   1. 应用内（发消息 / 传附件的路由）走 Next 的打包器，import 可省扩展名
 *   2. 测试脚本（`scripts/test-trust.mjs`）走 Node 原生类型擦除，
 *      import 必须带 `.ts` 扩展名
 *
 * 只要这个文件不 import 任何东西，两边就都能安全引用。
 *
 * 代价是它拿不到 `consume()` 和 `hasPerm()`，所以两者都**由调用方注入**：
 *   - 计数器：`consume` 作为参数传入（`CounterFn`）
 *   - 员工判定：`isStaff` 由路由算好传入（它已经 import 了 permissions）
 *
 * 这不是为了"优雅"，而是为了**可测**：时间边界（10 分钟 / 24 小时）是这份
 * 策略里最容易写错、也最难手工验证的部分。注入一个假计数器之后，
 * 这两个边界可以在毫秒内被穷举验证，不需要起数据库、不需要等 10 分钟。
 *
 * ── 策略本身 ────────────────────────────────────────────────────────
 *
 * 开放注册的社区必然被刷广告。但"一刀切地限制所有新用户"会误伤真实的
 * 首次提问者，所以这里用**台阶式放宽**：越新的账号越受限，随时间自动解除。
 *
 *   cooldown    注册后 10 分钟内  发言间隔 30 秒 / 每小时 5 条 / 禁止附件
 *   ramp        10 分钟 ~ 24 小时 发言间隔 10 秒 / 每小时 20 条 / 附件 5 个
 *   established 24 小时后         无额外限制（走基础限流规则）
 *
 * `trust_level >= 1` 或员工身份可以直接跳到 established —— 这样
 * "邮箱验证通过"或"管理员手动信任"将来都能立刻解除限制，不需要改这里。
 *
 * ── 一个刻意的取舍 ──────────────────────────────────────────────────
 *
 * 冷却期**完全禁止附件**，而技术社区最需要的就是贴日志和截图。
 * 之所以仍然这么做：图片是开放社区里最难事后清理、也最常被用来刷广告的
 * 载体；而代码块（Markdown 已支持）能覆盖绝大多数技术求助场景。
 * 代价是"注册后立刻想贴截图"的用户要等 10 分钟。
 *
 * 如果实测误伤明显，把 `COOLDOWN_MS` 调小即可 —— 它是唯一的旋钮，
 * 不必改动任何判断逻辑。
 */

/** 冷却期：注册后这段时间内限制最严 */
export const COOLDOWN_MS = 10 * 60 * 1000

/** 爬坡期：到这段时间为止逐步放宽，之后视为老用户 */
export const RAMP_MS = 24 * 60 * 60 * 1000

export type TrustStage = 'cooldown' | 'ramp' | 'established'

/** 受新人策略约束的动作。加新动作时记得补 STAGE_POLICIES 的每一格 */
export type GateAction = 'postMessage' | 'upload'

export type LimitRule = {
  windowMs: number
  max: number
  /**
   * 触发时展示给用户的原因。
   *
   * 必须具体到"等多久"。用户看到"操作过于频繁"只会以为站点坏了，
   * 看到"新账号有 30 秒发言间隔，请 24 秒后重试"才知道这是一条规则。
   */
  label: string
}

export type StagePolicy =
  /**
   * 完全不允许。
   * `unblockAfterMs` 是"账号年龄达到多少毫秒后解除"，用于算出还要等多久。
   */
  | { blocked: true; reason: string; unblockAfterMs: number }
  /** 允许，但要逐条通过 rules（按顺序检查，第一个不通过即拒绝） */
  | { blocked: false; rules: readonly LimitRule[] }

/**
 * 每个阶段、每个动作的策略。
 *
 * ★ 用显式的 `blocked` 判别联合，而不是 `rules: []` 表示禁止 ★
 * 空数组和"没有限制"在类型上无法区分，写成 `null` 又容易漏判 ——
 * 这类歧义在策略代码里迟早会变成"以为限制了其实没有"。
 *
 * established 用空 rules：基础限流（RATE_RULES）在路由里单独生效，
 * 这里不重复，避免同一个额度被两处各算一遍。
 */
export const STAGE_POLICIES: Record<TrustStage, Record<GateAction, StagePolicy>> = {
  cooldown: {
    postMessage: {
      blocked: false,
      rules: [
        { windowMs: 30_000, max: 1, label: '新账号有 30 秒发言间隔' },
        { windowMs: 3_600_000, max: 5, label: '新账号每小时最多 5 条消息' },
      ],
    },
    upload: {
      blocked: true,
      reason: '注册后 10 分钟内不能上传附件（可以先用代码块贴日志）',
      unblockAfterMs: COOLDOWN_MS,
    },
  },
  ramp: {
    postMessage: {
      blocked: false,
      rules: [
        { windowMs: 10_000, max: 1, label: '账号注册未满 24 小时，发言间隔 10 秒' },
        { windowMs: 3_600_000, max: 20, label: '账号注册未满 24 小时，每小时最多 20 条消息' },
      ],
    },
    upload: {
      blocked: false,
      rules: [
        { windowMs: 3_600_000, max: 5, label: '账号注册未满 24 小时，每小时最多 5 个附件' },
      ],
    },
  },
  established: {
    postMessage: { blocked: false, rules: [] },
    upload: { blocked: false, rules: [] },
  },
}

function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value
}

/**
 * 判断账号处于哪个阶段。
 *
 * 时钟回拨或数据异常导致 age 为负时按 `cooldown` 处理 —— **失败要往严的方向倒**，
 * 否则一个畸形的时间戳就等于免检通行证。
 */
export function trustStage(
  input: { trustLevel: number; createdAt: Date | number; isStaff?: boolean },
  now: number = Date.now(),
): TrustStage {
  if (input.isStaff) return 'established'
  if (input.trustLevel >= 1) return 'established'

  const ageMs = now - toMillis(input.createdAt)
  if (ageMs < COOLDOWN_MS) return 'cooldown'
  if (ageMs < RAMP_MS) return 'ramp'
  return 'established'
}

/** 把毫秒变成人话，用于错误提示 */
export function humanizeWait(ms: number): string {
  if (ms <= 0) return '现在'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.ceil(minutes / 60)} 小时`
}

/** 调用方注入的计数器。与 `src/lib/ratelimit.ts` 的 `consume` 同签名子集 */
export type CounterFn = (key: string, rule: LimitRule) => { ok: boolean; retryAfterMs: number }

export type GateVerdict =
  | { ok: true; stage: TrustStage }
  | {
      ok: false
      stage: TrustStage
      /** 与普通限流的 `rate_limited` 区分开，便于客户端与运维分辨来源 */
      code: 'new_user_limited' | 'new_user_blocked'
      error: string
      retryAfterMs: number
    }

/**
 * 门卡：判定这次动作是否放行。
 *
 * 检查顺序 = STAGE_POLICIES 里 rules 的书写顺序（先短窗口、后长窗口）。
 * 先报"等 30 秒"比先报"等 1 小时"对用户更有用，而且两条都超时的情况下
 * 短的确实是先能满足的那个。
 *
 * 已知的小副作用：若次数配额已经用满，本次仍会消耗掉一个间隔名额。
 * 影响是用户本来就要等，重试时间不变 —— 不值得为此引入事务。
 */
export function evaluateGate(input: {
  action: GateAction
  userId: number
  trustLevel: number
  createdAt: Date | number
  isStaff: boolean
  now?: number
  consume: CounterFn
}): GateVerdict {
  const now = input.now ?? Date.now()
  const stage = trustStage(
    {
      trustLevel: input.trustLevel,
      createdAt: input.createdAt,
      isStaff: input.isStaff,
    },
    now,
  )

  const policy = STAGE_POLICIES[stage][input.action]

  if (policy.blocked) {
    const ageMs = now - toMillis(input.createdAt)
    const retryAfterMs = Math.max(0, policy.unblockAfterMs - ageMs)
    return {
      ok: false,
      stage,
      code: 'new_user_blocked',
      error: `${policy.reason}，还需 ${humanizeWait(retryAfterMs)}`,
      retryAfterMs,
    }
  }

  for (let i = 0; i < policy.rules.length; i += 1) {
    const rule = policy.rules[i]!
    // key 必须同时带**阶段**与**规则下标**：
    //   - 带下标：不同窗口的计数器必须彼此独立，否则"30 秒内 1 条"和
    //     "每小时 5 条"会共用同一个桶，两个额度都失真
    //   - 带阶段：冷却期与爬坡期各有自己的小时配额，共用一个桶会让
    //     "5 条/小时"的计数残留到爬坡期去比 "20 条/小时"的阈值。
    //     将来任何一方改了窗口长度，共用桶都会变成一个说不清的行为。
    //
    // 跨阶段重置计数不会带来绕过空间：阶段只随时间单向前进，
    // 而且是从严到宽，重置只会对用户更宽松，不可能被用来刷新额度。
    const key = `newuser:${stage}:${input.action}:${i}:user:${input.userId}`
    const result = input.consume(key, rule)
    if (!result.ok) {
      return {
        ok: false,
        stage,
        code: 'new_user_limited',
        error: `${rule.label}，请 ${humanizeWait(result.retryAfterMs)}后重试`,
        retryAfterMs: result.retryAfterMs,
      }
    }
  }

  return { ok: true, stage }
}
