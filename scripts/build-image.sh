#!/usr/bin/env bash
#
# 本地构建镜像并导出为归档文件，供服务器直接 `docker load`。
#
# 用法（在 WSL 里执行，不是 Windows）：
#     cd "/mnt/e/dsh project bbs"
#     bash scripts/build-image.sh
#     # 产出：dist/bbs-images.tar.gz
#
# 或者从 Windows 直接调：
#     npm run build:image
#
# ── 为什么需要这个流程 ──────────────────────────────────────────────
# 在 1.6GB 内存的服务器上直接 `docker compose build` 会导致内核换页抖动，
# 严重时连 sshd 都无法完成握手 —— 实测发生过，只能去云控制台硬重启。
# 在本地构建、服务器只 `docker load`，服务器内存压力从约 1.8GB 降到几乎为零。
#
# ── 为什么构建前把源码复制进 Linux 文件系统 ─────────────────────────
# /mnt/e 是 Windows 盘，通过 9p 协议访问，跨文件系统的 IO 开销很大。
# 构建上下文只有 ~1MB，先复制到 ~/ 再做构建约需 1 秒，
# 但能让 `COPY . .` 这一层以及后续构建明显更快。
#
# ── 关于镜像标签（重要）─────────────────────────────────────────────
# docker-compose.yml 里给 app / migrate / seed 都写了显式 `image: bbs-*`。
# 不加的话 compose 会按**项目目录名**推导标签（~/bbs-build 下是 bbs-build-app），
# 于是本地导出、服务器加载、服务器 compose 查找三处的名字对不上，
# 表现为服务起不来或静默用了旧镜像 —— 报错完全不指向真正原因。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$PROJECT_DIR/dist"
OUT_FILE="$OUT_DIR/bbs-images.tar.gz"

BUILD_DIR="$HOME/bbs-image-build"

# 必须与 docker-compose.yml 里的 `image:` 一致
IMAGES=(bbs-app bbs-migrate bbs-seed)
SERVICES=(app migrate seed)

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查 ───────────────────────────────────────────────────────────
log "检查环境"
command -v docker >/dev/null 2>&1 || die "未找到 docker。安装：sudo bash scripts/wsl-install-docker.sh"
docker info >/dev/null 2>&1 || die "无法连接 Docker daemon。WSL 里可能需要：sudo systemctl start docker"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件。重装：sudo bash scripts/wsl-install-docker.sh"
ok "Docker $(docker --version | cut -d, -f1) / Compose $(docker compose version --short)"
ok "项目位置：$PROJECT_DIR"

# ── 准备构建目录 ───────────────────────────────────────────────────────
log "准备构建上下文（$BUILD_DIR）"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# 用 tar 管道复制并排除大目录/机密。
# 显式排除 .env：构建不需要它，也不该把本地机密带进构建上下文。
tar -czf - \
  --exclude=node_modules --exclude=.next --exclude=var --exclude=data \
  --exclude=backups --exclude=dist --exclude=.git --exclude=.ssh-local \
  --exclude=.env --exclude='*.log' --exclude=tsconfig.tsbuildinfo \
  --exclude='docker-compose.override.yml' \
  -C "$PROJECT_DIR" . | tar -xzf - -C "$BUILD_DIR"

ok "已复制 $(find "$BUILD_DIR" -type f | wc -l) 个文件"

# ── 构建必需的 .env ────────────────────────────────────────────────────
# docker compose 在**插值阶段**就读取 .env（compose 文件用 ${VAR:?} 强制要求），
# 必须早于任何 compose 子命令存在。这里的值只服务于 build 阶段的插值，
# 既不会打进镜像，也不会影响服务器的运行配置。
log "生成构建用的临时 .env"
cat > "$BUILD_DIR/.env" <<'ENVEOF'
# 仅供本地构建时的变量插值，不是运行时配置。
DOMAIN=localhost
SITE_ADDRESS=:80
SITE_URL=http://localhost
SITE_NAME=技术社区
NEXT_PUBLIC_SITE_NAME=技术社区
POSTGRES_USER=bbs
POSTGRES_PASSWORD=build-time-placeholder
POSTGRES_DB=bbs
DATABASE_POOL_MAX=10
SESSION_SECRET=build-time-placeholder-secret-not-used-at-runtime
COOKIE_SECURE=false
SNOWFLAKE_EPOCH=1704067200000
SNOWFLAKE_WORKER_ID=1
PG_SHARED_BUFFERS=256MB
PG_EFFECTIVE_CACHE_SIZE=768MB
PG_WORK_MEM=8MB
PG_MAX_CONNECTIONS=100
ENVEOF
ok "已生成"

# ── 构建 ───────────────────────────────────────────────────────────────
# 逐个显式构建三个服务。虽然它们共用同一个 Dockerfile，
# 但各自的镜像标签独立，漏掉哪个都会导致服务器上用到旧镜像或找不到镜像。
log "构建镜像（app / migrate / seed）"
cd "$BUILD_DIR"

START=$(date +%s)
for svc in "${SERVICES[@]}"; do
  printf '%s    → %s%s\n' "$(printf '\033[2m')" "$svc" "$(printf '\033[0m')"
  if ! DOCKER_BUILDKIT=1 docker compose build "$svc"; then
    die "构建 $svc 失败。常见原因：
    · Docker daemon 未运行：sudo systemctl start docker
    · 拉取基础镜像超时（大陆网络）：确认 /etc/docker/daemon.json 配了镜像加速器
    · 磁盘不足：docker system df 然后 docker system prune -a"
  fi
done
END=$(date +%s)
ok "构建完成，耗时 $((END - START)) 秒"

# ── 校验镜像并导出 ─────────────────────────────────────────────────────
log "校验镜像标签"
EXPORTABLE=()
for img in "${IMAGES[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    SIZE="$(docker image inspect "$img" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1024/1024}')"
    ok "$img  ($SIZE)"
    EXPORTABLE+=("$img")
  else
    warn "$img 不存在（构建是否被跳过？）"
  fi
done

[[ ${#EXPORTABLE[@]} -gt 0 ]] || die "没有任何可导出的镜像"

log "导出镜像归档"
mkdir -p "$OUT_DIR"

# 用 pigz 并行压缩（docker-buildx-plugin 会带上它），比单线程 gzip 快数倍
COMPRESSOR="gzip"
if command -v pigz >/dev/null 2>&1; then
  COMPRESSOR="pigz"
  ok "使用 pigz 并行压缩"
fi

docker save "${EXPORTABLE[@]}" | $COMPRESSOR > "$OUT_FILE"

[[ -s "$OUT_FILE" ]] || die "导出文件为空，可能是磁盘空间不足"
ok "已导出：$OUT_FILE（$(du -h "$OUT_FILE" | cut -f1)）"

# ── 提示下一步 ─────────────────────────────────────────────────────────
echo
printf '\033[1;32m══════════════════════════════════════════════════\033[0m\n'
printf '\033[1;32m  镜像已就绪\033[0m\n'
printf '\033[1;32m══════════════════════════════════════════════════\033[0m\n'
echo
echo "归档：$OUT_FILE"
echo
echo "下一步（在 Windows 上执行）——上传代码与镜像并部署，服务器不做任何构建："
echo
echo "    cd \"$PROJECT_DIR\""
echo "    npm run deploy:local -- -Server admin@<服务器IP> -Images -Smoke"
echo
