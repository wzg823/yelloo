/**
 * 主题解析的单元测试 —— 纯函数，不碰数据库与浏览器。
 *
 * 用法：node scripts/test-theme.mjs
 *
 * 这里钉住两件容易被忽略的事：
 *
 * 1. **Cookie 的 Path 必须是 `/`。** 少了它，浏览器只会在这个 Cookie
 *    设定的那条路径及其子路径下回传 —— 表现为"在首页切了深色，进频道页
 *    又变回浅色"，而用户完全无法理解发生了什么。
 *
 * 2. **无法识别的 Cookie 值必须当成"没选过"（null），而不是猜一个默认值。**
 *    猜错的后果是用户看到与系统相反的主题，而且他没有任何办法回到"跟随系统"。
 */
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  htmlThemeAttribute,
  nextTheme,
  parseTheme,
  themeCookieValue,
} from '../src/lib/theme.ts'

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

console.log('\x1b[1m主题解析\x1b[0m')

ok('light 被识别', parseTheme('light') === 'light')
ok('dark 被识别', parseTheme('dark') === 'dark')
ok('空值 → null（跟随系统）', parseTheme('') === null && parseTheme(null) === null && parseTheme(undefined) === null)
ok('未知值 → null（不猜默认值）', parseTheme('auto') === null && parseTheme('LIGHT') === null)
ok('注入式的脏值不会漏过去', parseTheme('light; dark') === null && parseTheme('../../etc') === null)

ok('nextTheme 往返', nextTheme('light') === 'dark' && nextTheme('dark') === 'light')

ok('有值时才写 data-theme', htmlThemeAttribute('light') === 'light' && htmlThemeAttribute('dark') === 'dark')
ok('无值时不写属性（交给 CSS 跟随系统）', htmlThemeAttribute(null) === undefined && htmlThemeAttribute('') === undefined)
ok('脏值同样不写属性', htmlThemeAttribute('nonsense') === undefined)

const cookie = themeCookieValue('light')
ok('Cookie 名符合约定', cookie.startsWith(`${THEME_COOKIE}=`), THEME_COOKIE)
ok('★ Cookie 的 Path 是 /（否则子页面收不到，主题会自己变回去）', /;\s*Path=\//.test(cookie))
ok('有 Max-Age（否则是个会话 Cookie，关浏览器就丢）', cookie.includes(`Max-Age=${THEME_COOKIE_MAX_AGE}`))
ok('SameSite=Lax（不能被跨站请求顺手改掉）', cookie.includes('SameSite=Lax'))
ok('值为 dark 时同样正确', themeCookieValue('dark').startsWith(`${THEME_COOKIE}=dark;`))
ok('有效期是一年量级', THEME_COOKIE_MAX_AGE === 365 * 24 * 3600)

console.log(`\n\x1b[1m${'─'.repeat(52)}\x1b[0m`)
console.log(`\x1b[1m结果\x1b[0m  通过 ${passed}  失败 ${failures.length}`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('\n\x1b[32m全部通过。\x1b[0m')
}
