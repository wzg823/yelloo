/**
 * 密码哈希与会话令牌。
 *
 * 用 @node-rs/argon2：预编译二进制，不需要在 Docker 镜像里装编译工具链
 * （node-argon2 需要 node-gyp，会在国内网络和 Alpine 镜像上反复出事）。
 *
 * ⚠️ 本文件刻意保持"零外部依赖"（只依赖 node:crypto 与 argon2 参数模块），
 * 因为 `scripts/seed.mjs` 需要直接 import 它。详见 argon2-options.ts 的说明。
 */
import { hash, verify } from '@node-rs/argon2'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ARGON2_OPTIONS } from './argon2-options'

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, ARGON2_OPTIONS)
  } catch {
    // 哈希串损坏 / 算法不匹配一律视为验证失败，不要把异常抛给调用方
    return false
  }
}

/**
 * 会话令牌：生成 32 字节随机串，DB 里只存 SHA-256。
 * 这样即使数据库泄露，攻击者也无法直接拿去登录（与密码同理）。
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 常量时间比较，用于校验事件的签名/CSRF token */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
