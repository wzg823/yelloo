/**
 * 密码强度策略 —— 单一来源。
 *
 * ── 为什么单独一个文件，而不是留在 auth.ts 里 ──────────────────────
 *
 * 这个策略有**两个消费者，且它们的模块解析方式不同**：
 *
 *   1. 应用内（`src/lib/auth.ts`）走 Next 的打包器，import 可以省略扩展名
 *   2. 运维脚本（`scripts/set-password.mjs`）走 Node 原生类型擦除，
 *      import 必须带 `.ts` 扩展名
 *
 * 于是脚本不能从 `auth.ts` 取值 —— auth.ts 内部有省略扩展名的 import
 * （`./password`、`./permissions` 等），Node 原生解析不了。
 *
 * 放在这个**零依赖的叶子模块**里，两边都能安全引用，而且规则只有一处定义。
 * 若留在 auth.ts，命令行改密就会与注册接口各有一套规则，迟早分叉：
 * 出现"命令行能设的密码，注册接口认为太弱"这种自相矛盾。
 */

/** 注册与改密共用的最小长度。长度远比大小写混合重要，故不做复杂度要求 */
export const MIN_PASSWORD_LENGTH = 10

/**
 * 弱口令判定。返回 `null` 表示通过，否则返回可直接展示给用户的原因。
 *
 * 调用方约定：注册接口把原因包成 `{ code: 'weak_password', error }` 返回，
 * 命令行脚本打印后以非零码退出。
 */
export function weakPasswordReason(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 位`
  }
  // 复杂度只做最低要求：拦掉 "aaaaaaaaaa" 这类，其余交给长度
  if (/^(.)\1+$/.test(plain)) {
    return '密码不能是重复的单一字符'
  }
  return null
}
