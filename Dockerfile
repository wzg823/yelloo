# ─────────────────────────────────────────────────────────────────────────
# 生产镜像。多阶段构建。
#
# 为什么用 bookworm-slim 而不是 alpine：
#   @node-rs/argon2 依赖预编译的原生二进制。alpine 用 musl，一旦该包没有
#   对应的 musl 产物，构建会退化到从源码编译，需要 python3/make/g++，
#   在国内网络下极易失败。bookworm-slim（glibc）能直接用官方预编译产物，
#   镜像大 ~60MB，换来的是"构建必定成功"。
# ─────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# openssl 是某些原生模块的运行时依赖；ca-certificates 保证 HTTPS 出网
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# postinstall 若存在也不跳过，让原生模块在此阶段完成准备
RUN npm ci --no-audit --no-fund


FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建期不能连数据库：页面全部是动态渲染或 ISR，
# 但为了绝对安全，给一个占位连接串，避免任何模块在 import 阶段抛错。
ENV DATABASE_URL=postgres://placeholder:placeholder@127.0.0.1:5432/placeholder
ENV NEXT_TELEMETRY_DISABLED=1

# ★ NEXT_PUBLIC_* 变量在构建期被内联进客户端 bundle，运行时设置不生效 ★
# 因此站点名必须在这里以 build arg 传入。改了站点名必须重新构建镜像，
# 仅仅重启容器是没用的（这是 Next.js 项目最常见的部署误判之一）。
ARG NEXT_PUBLIC_SITE_NAME=技术社区
ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME

RUN npm run build


FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl gosu \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行。node 镜像自带 uid 1000 的 node 用户；这里单独建 uid 1001 的 app
RUN groupadd --system --gid 1001 app 2>/dev/null || true \
    && useradd --system --uid 1001 --gid app app 2>/dev/null || true

# 整体拷贝而不是只拷 .next：迁移脚本与 drizzle/ 目录需要在容器内可执行，
# 否则每次发版都要额外挂载一个迁移容器。
COPY --from=builder --chown=app:app /app ./

# 上传目录与日志目录需要可写
RUN mkdir -p /app/var/uploads && chown -R app:app /app/var

# ★ 不要在这里 USER app ★
# 入口脚本需要以 root 启动，才能修正命名卷的属主（见 docker-entrypoint.sh），
# 随后它会用 gosu 降权到 uid 1001 再执行真正的命令。
# 直接 USER app 的话，挂载空命名卷后 app 用户对 /app/var/uploads 没有写权限，
# 上传会以 EACCES 失败，而日志里看不出是权限问题。
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
