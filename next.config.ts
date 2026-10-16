import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // `pg` / argon2 是原生或 Node 专有模块，不能被打进浏览器 bundle
  serverExternalPackages: ['pg', '@node-rs/argon2'],

  // 生产环境由 Caddy 反代，这里信任反代传来的协议头，保证 cookie secure 判断正确
  poweredByHeader: false,

  experimental: {
    // Server Action 默认 1MB，附件直传走独立的预签名接口，这里只放宽表单文本
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  async headers() {
    return [
      {
        // SSE 端点绝不能被任何中间层缓存或缓冲
        source: '/api/events',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, no-transform' },
          { key: 'X-Accel-Buffering', value: 'no' },
          { key: 'Connection', value: 'keep-alive' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
