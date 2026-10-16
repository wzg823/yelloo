/**
 * argon2 参数集中定义。
 *
 * 单独成文件的理由很实在：`src/db/index.ts` 是 Next.js 的模块
 * （含 `import * as schema from './schema'` 这类无扩展名导入），
 * **Node 的类型擦除不做扩展名解析**，脚本一旦间接 import 它就会
 * `ERR_MODULE_NOT_FOUND`。因此 `scripts/` 下的脚本只依赖叶子模块，
 * 不依赖任何被 Next 打包过的聚合模块。
 *
 * 参数取舍：argon2id + 19MiB 内存 + 2 次迭代，OWASP 推荐档位。
 * 内存成本是抗 GPU 爆破的关键，不要为了省 CPU 降到 8MiB 以下。
 */
export const ARGON2_OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19 * 1024, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const
