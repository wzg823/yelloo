/**
 * Snowflake ID 生成器。
 *
 * 位布局（共 64 位，最高位恒为 0 以保证 BigInt→PG bigint 为正数）：
 *   41 位 毫秒时间戳（相对 SNOWFLAKE_EPOCH）
 *   10 位 worker/machine id（0-1023）
 *   12 位 同毫秒内序列号（0-4095）
 *
 * 为什么不用 bigserial：Snowflake 自带时间序，使得
 *   - 游标分页 = `WHERE channel_id = ? AND id < ? ORDER BY id DESC`（无需额外排序键）
 *   - SSE 补齐 = `WHERE id > :lastEventId`（无需额外事件表）
 *
 * 约束：SNOWFLAKE_EPOCH 一旦上线有数据就不可更改，多实例部署时
 * SNOWFLAKE_WORKER_ID 必须各不相同，否则会撞主键。
 */

const EPOCH = BigInt(process.env.SNOWFLAKE_EPOCH ?? '1704067200000')
const WORKER_BITS = 10n
const SEQUENCE_BITS = 12n
const MAX_WORKER_ID = (1n << WORKER_BITS) - 1n
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n

const workerId = BigInt(process.env.SNOWFLAKE_WORKER_ID ?? '1')
if (workerId < 0n || workerId > MAX_WORKER_ID) {
  throw new Error(`SNOWFLAKE_WORKER_ID 必须在 0-${MAX_WORKER_ID} 之间，当前 ${workerId}`)
}

let lastMs = -1n
let sequence = 0n

/** 上一个 ID 的字符串形式，仅用于调试与断言 */
export const snowflakeMeta = {
  epoch: EPOCH.toString(),
  workerId: workerId.toString(),
}

export function nextId(): bigint {
  let now = BigInt(Date.now())

  if (now < lastMs) {
    // 时钟回拨：Snowflake 的经典失效场景。
    // 正常情况下 NTP 只会微调（<10ms），自旋等待即可；
    // 若回拨幅度大，宁可阻塞也不生成重复 ID。
    const drift = lastMs - now
    if (drift > 5_000n) {
      console.error(`[snowflake] 时钟回拨 ${drift}ms，等待追平`)
    }
    while (now < lastMs) now = BigInt(Date.now())
  }

  if (now === lastMs) {
    sequence = (sequence + 1n) & MAX_SEQUENCE
    if (sequence === 0n) {
      // 本毫秒序列号用尽，等到下一毫秒
      while (BigInt(Date.now()) <= lastMs) {
        /* spin */
      }
      now = BigInt(Date.now())
    }
  } else {
    sequence = 0n
  }

  lastMs = now

  return ((now - EPOCH) << (WORKER_BITS + SEQUENCE_BITS)) | (workerId << SEQUENCE_BITS) | sequence
}

/** 从 ID 反解生成时间（用于排查与数据修复，不用于业务判断） */
export function idToDate(id: bigint): Date {
  return new Date(Number((id >> (WORKER_BITS + SEQUENCE_BITS)) + EPOCH))
}

/** 把字符串游标安全转成 BigInt；非法输入返回 null */
export function parseId(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? BigInt(raw) : null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^\d{1,20}$/.test(trimmed)) return null
  try {
    return BigInt(trimmed)
  } catch {
    return null
  }
}
