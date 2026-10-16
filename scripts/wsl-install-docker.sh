#!/usr/bin/env bash
#
# 在 WSL2 的 Ubuntu 里安装 Docker Engine（不是 Docker Desktop）。
#
# 用法（在 WSL 终端里执行，会提示输入你的 Linux 密码）：
#
#     cd /mnt/e/dsh\ project\ bbs
#     sudo bash scripts/wsl-install-docker.sh
#
# ── 为什么用官方 apt 仓库而不是 get.docker.com ──────────────────────
# `curl -fsSL https://get.docker.com | sudo sh` 也能装上，但它是不透明的：
# 出问题时不告诉你哪一步失败，也不便于日后再执行 apt upgrade。
# 官方仓库方式每一步都是显式的，升级走常规 apt 流程。
#
# ── 为什么不用 Docker Desktop ───────────────────────────────────────
# Docker Desktop 要装 Windows 侧服务、占用常驻内存、需要 WSL 集成开关，
# 而且从 E: 盘通过 /mnt/e 挂载访问时 IO 性能很差。
# 直接在 WSL 里跑 Engine 更轻，且和服务器上的 Docker 行为一致
# （服务器用的是同样的 Engine，不是 Desktop）。
#
# ── 关于 systemd ────────────────────────────────────────────────────
# 本机的 WSL 已启用 systemd（PID 1 是 systemd），所以 `systemctl enable --now docker`
# 能真正生效，开机自启。若 systemd 未启用，脚本会自动回退到
# `service docker start` 并提示需要手动启动。
#
set -euo pipefail

# ── 前置检查 ───────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "✗ 请用 sudo 执行：" >&2
  echo "    sudo bash scripts/wsl-install-docker.sh" >&2
  exit 1
fi

# 在 WSL 里从 Windows 侧调用时可能没有 SUDO_USER，回退到第一个普通用户
TARGET_USER="${SUDO_USER:-$(id -un 1000 2>/dev/null || echo '')}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 环境校验 ────────────────────────────────────────────────────────
log "检查环境"
grep -qi microsoft /proc/version || warn "看起来不在 WSL 里，继续但请自行确认"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "系统：${PRETTY_NAME:-unknown}（$(dpkg --print-architecture)）"
  case "${ID:-}" in
    ubuntu|debian) : ;;
    *) warn "非 Ubuntu/Debian，官方仓库脚本可能不适用" ;;
  esac
  ok "内核：$(uname -r)"
fi

log "更新软件包索引"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# ── 1. 移除可能冲突的旧包 ──────────────────────────────────────────────
# docker.io / docker-doc / podman-docker 会与官方包冲突，
# 不先清掉的话 apt 会给出很难读的依赖错误。
log "清理冲突的旧包（若存在）"
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  apt-get remove -y -qq "$pkg" >/dev/null 2>&1 || true
done
ok "已清理"

# ── 2. 安装前置工具 ────────────────────────────────────────────────────
log "安装依赖"
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg iptables
ok "依赖就绪"

# ── 3. 添加官方 GPG 密钥 ───────────────────────────────────────────────
log "配置 Docker 官方 apt 仓库"
install -m 0755 -d /etc/apt/keyrings

if [[ -f /etc/apt/keyrings/docker.asc ]]; then
  ok "GPG 密钥已存在，跳过"
else
  curl -fsSL https://download.docker.com/linux/"${ID:-ubuntu}"/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ok "GPG 密钥已安装"
fi

# ── 4. 添加 apt 源 ─────────────────────────────────────────────────────
ARCH="$(dpkg --print-architecture)"
CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
[[ -n "$CODENAME" ]] || die "无法确定发行版代号（VERSION_CODENAME 为空）"

cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID:-ubuntu} ${CODENAME} stable
EOF
ok "已添加源：${ID:-ubuntu}/${CODENAME}/${ARCH}"

apt-get update -qq

# ── 5. 安装 Docker Engine ──────────────────────────────────────────────
# 包含 compose 插件：服务器上用的是 `docker compose`（v2 子命令），
# 本地保持一致才能用同一套命令，避免"本地能跑服务器不能"这类差异。
log "安装 Docker Engine + Compose 插件"
apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

ok "安装完成：$(docker --version)"
ok "Compose：$(docker compose version --short 2>/dev/null || echo unknown)"

# ── 6. 把当前用户加入 docker 组 ────────────────────────────────────────
if [[ -n "$TARGET_USER" ]]; then
  if id -nG "$TARGET_USER" 2>/dev/null | grep -qw docker; then
    ok "用户 $TARGET_USER 已在 docker 组"
  else
    usermod -aG docker "$TARGET_USER"
    ok "已把 $TARGET_USER 加入 docker 组（需重开终端或执行 newgrp docker 生效）"
  fi
else
  warn "未能确定普通用户名，请手动执行：sudo usermod -aG docker <你的用户名>"
fi

# ── 7. 启动并设为开机自启 ──────────────────────────────────────────────
log "启动 Docker 服务"
if [[ "$(ps -p 1 -o comm= 2>/dev/null)" == "systemd" ]]; then
  systemctl enable --now docker >/dev/null 2>&1 || true
  systemctl enable --now containerd >/dev/null 2>&1 || true
  ok "已通过 systemd 启用（并设为开机自启）"
else
  service docker start >/dev/null 2>&1 || true
  warn "systemd 未启用，Docker 不会开机自启"
  warn "每次重启 WSL 后需执行：sudo service docker start"
  warn "想让 WSL 使用 systemd：在 Windows 侧创建 /etc/wsl.conf 并加上 [boot] systemd=true"
fi

# ── 8. 冒烟测试 ────────────────────────────────────────────────────────
log "冒烟测试"
if docker run --rm hello-world >/dev/null 2>&1; then
  ok "hello-world 运行成功，Docker 完全可用"
  docker image rm hello-world >/dev/null 2>&1 || true
else
  warn "hello-world 失败。排查："
  echo "      systemctl status docker"
  echo "      docker info"
fi

# 验证能否读写 Windows 盘上的项目目录（构建上下文要从这里读）
PROJECT_DIR="/mnt/e/dsh project bbs"
if [[ -d "$PROJECT_DIR" ]]; then
  log "验证 Windows 盘访问"
  ok "项目目录可访问：$PROJECT_DIR"
  warn "提示：构建在 /mnt/e 上比在 Linux 文件系统内慢很多（跨文件系统 IO 开销）"
  warn "      本项目代码量小，实际可接受；若嫌慢可把仓库 clone 到 ~/bbs 再构建"
else
  warn "未找到 $PROJECT_DIR，请确认项目路径"
fi

echo
printf '\033[1;32m══════════════════════════════════════════════════\033[0m\n'
printf '\033[1;32m  Docker Engine 安装完成\033[0m\n'
printf '\033[1;32m══════════════════════════════════════════════════\033[0m\n'
echo
echo "下一步："
echo "  1) 让 docker 组权限生效（二选一）："
echo "       exit                              # 关掉 WSL 终端再重开"
echo "       newgrp docker                     # 或在当前终端立即生效"
echo "  2) 验证（应无需 sudo）："
echo "       docker run --rm hello-world"
echo "  3) 构建本项目镜像并导出，供服务器直接加载："
echo "       cd \"/mnt/e/dsh project bbs\""
echo "       bash scripts/wsl-build-and-export.sh"
echo
