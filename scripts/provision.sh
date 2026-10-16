#!/usr/bin/env bash
#
# 服务器一键初始化。
#
# 适用：Ubuntu 22.04 / 24.04 LTS（全新机器）
# 用法：以 root 执行
#     bash provision.sh
#   或指定参数
#     SWAP_SIZE=2G DOCKER_MIRROR=https://xxx.mirror.aliyuncs.com bash provision.sh
#
# 做六件事：
#   1. 建立日常使用的非 root 用户并授予 sudo
#   2. 加固 SSH（禁 root 登录、禁密码登录）—— 改完会用 sshd -t 校验，防止把自己锁在外面
#   3. 配置防火墙（只放行 SSH / 80 / 443；应用与数据库端口不对公网暴露）
#   4. 配置 swap（2GB 内存机器构建镜像必需，否则 docker build 会 OOM）
#   5. 提高文件描述符上限（SSE 长连接应用最经典的容量陷阱）
#   6. 安装 Docker + 可用镜像加速器 + fail2ban + 自动安全更新
#
# 幂等：可重复执行，已完成的步骤会跳过。
#
set -euo pipefail

# ── 可调参数 ────────────────────────────────────────────────────────────
DEPLOY_USER="${DEPLOY_USER:-deploy}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
# Docker 镜像加速器。国内服务器留空会导致拉取 node:22-bookworm-slim 超时。
# 阿里云用户请从「容器镜像服务 → 镜像加速器」复制专属地址填入。
DOCKER_MIRROR="${DOCKER_MIRROR:-}"
# SSH 端口，改过默认端口的机器需要同步设置
SSH_PORT="${SSH_PORT:-22}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请以 root 执行（sudo bash provision.sh）"

# ── 0. 基础环境 ─────────────────────────────────────────────────────────
log "更新软件包索引"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg lsb-release ufw fail2ban unattended-upgrades openssl
ok "基础工具就绪"

# ── 1. 非 root 用户 ─────────────────────────────────────────────────────
log "配置用户 ${DEPLOY_USER}"
if id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  ok "用户已存在，跳过创建"
else
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
  ok "已创建 ${DEPLOY_USER}"
fi
usermod -aG sudo "${DEPLOY_USER}"

# 把 root 的 authorized_keys 复制过去，保证新用户能免密登录。
# ⚠️ 执行完本脚本后，务必先用新用户登录成功再断开当前会话。
if [[ -f /root/.ssh/authorized_keys ]]; then
  install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
  install -m 600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
    /root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  ok "已复制 SSH 公钥到 ${DEPLOY_USER}"
else
  warn "/root/.ssh/authorized_keys 不存在。请确认你能用密码登录 ${DEPLOY_USER}，"
  warn "否则接下来的 SSH 加固会让你无法登录。"
fi

# ── 2. SSH 加固 ─────────────────────────────────────────────────────────
log "加固 SSH"
SSHD_CONFIG=/etc/ssh/sshd_config
cp -n "${SSHD_CONFIG}" "${SSHD_CONFIG}.bak.$(date +%Y%m%d%H%M%S)" || true

# 用 drop-in 而不是直接改主配置：Ubuntu 上主文件常有 Include，
# 直接改容易被后续 Include 覆盖，产生"改了但没生效"的困惑。
install -d -m 755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/99-hardening.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
Port ${SSH_PORT}
EOF

# ★ 关键：先校验语法再重启。语法错误 + 重启 = 永久失去服务器访问权。
if sshd -t 2>/dev/null; then
  ok "sshd 配置语法正确"
  # 部分镜像用 ssh.service，部分用 sshd.service
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  ok "SSH 配置已重载"
else
  warn "sshd 配置校验失败，已回滚，保持原配置"
  rm -f /etc/ssh/sshd_config.d/99-hardening.conf
fi

# ── 3. 防火墙 ───────────────────────────────────────────────────────────
log "配置防火墙 ufw"
# 先放行 SSH 再启用，否则会立刻断开自己的连接
ufw allow "${SSH_PORT}/tcp" comment 'SSH'
ufw allow 80/tcp  comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ok "已放行 SSH / 80 / 443（应用 3000 与数据库 5432 不对公网开放）"
warn "若使用云厂商安全组，还需在控制台再放行一次 80/443 —— 这是两层独立过滤"

# ── 4. swap ─────────────────────────────────────────────────────────────
log "配置 swap（${SWAP_SIZE}）"
if swapon --show | grep -q '/swapfile'; then
  ok "swap 已存在，跳过"
else
  if [[ ! -f /swapfile ]]; then
    fallocate -l "${SWAP_SIZE}" /swapfile 2>/dev/null \
      || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap 已启用"
fi

# swappiness 调低：默认 60 会让内核过早把内存换出，反而拖慢正常请求。
# 我们的目的是"构建时不 OOM"，不是"平时用 swap"。
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness = 10' >> /etc/sysctl.conf
sysctl -w vm.overcommit_memory=1 >/dev/null
ok "swappiness=10"

# ── 5. 文件描述符上限 ───────────────────────────────────────────────────
log "提高文件描述符上限"
# SSE 是长连接，每个连接占一个 fd。默认 1024 会在 300~400 并发连接时开始报错。
cat >/etc/security/limits.d/99-bbs.conf <<'EOF'
*    soft nofile 65535
*    hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF

cat >/etc/sysctl.d/99-bbs.conf <<'EOF'
fs.file-max = 200000
# 连接跟踪表上限：SSE 长连接会长期占用表项
net.netfilter.nf_conntrack_max = 262144
# TCP keepalive 调紧，更快回收死连接
net.ipv4.tcp_keepalive_time = 120
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 3
EOF
sysctl --system >/dev/null 2>&1 || true
ok "fd 上限 65535，已放宽 conntrack 与 keepalive"

# ── 6. Docker ───────────────────────────────────────────────────────────
log "安装 Docker"
if command -v docker >/dev/null 2>&1; then
  ok "Docker 已安装：$(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  ok "Docker 安装完成：$(docker --version)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
usermod -aG docker "${DEPLOY_USER}"

log "配置 Docker daemon"
install -d -m 755 /etc/docker
cat >/etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  },
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Soft": 65535, "Hard": 65535 }
  }$( [[ -n "${DOCKER_MIRROR}" ]] && printf ',\n  "registry-mirrors": ["%s"]' "${DOCKER_MIRROR}" )
}
EOF
systemctl restart docker
ok "已配置日志轮转（单文件 20MB × 5）与 fd 上限"

if [[ -z "${DOCKER_MIRROR}" ]]; then
  warn "未设置 DOCKER_MIRROR。大陆服务器拉取 node:22-bookworm-slim 可能超时。"
  warn "请从云厂商「容器镜像服务 → 镜像加速器」取得地址后重新执行："
  warn "  DOCKER_MIRROR=https://<你的地址>.mirror.aliyuncs.com bash provision.sh"
fi

# ── 7. fail2ban 与自动安全更新 ──────────────────────────────────────────
log "配置 fail2ban 与自动安全更新"
cat >/etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
port     = ssh
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable --now fail2ban >/dev/null 2>&1 || true

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ── 完成 ────────────────────────────────────────────────────────────────
PROJECT_DIR="/opt/bbs"
install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${PROJECT_DIR}"

echo
printf '\033[1;32m══════════════════════════════════════════════════\033[0m\n'
printf '\033[1;32m  初始化完成\033[0m\n'
printf '\033[1;32m══════════════════════════════════════════════════\033[0m\n'
echo
echo "机器概况："
printf '  CPU      %s 核\n' "$(nproc)"
printf '  内存     %s\n' "$(free -h | awk '/^Mem:/{print $2}')"
printf '  swap     %s\n' "$(free -h | awk '/^Swap:/{print $2}')"
printf '  磁盘     %s 可用\n' "$(df -h / | awk 'NR==2{print $4}')"
printf '  fd 上限  %s\n' "$(ulimit -n)"
echo
echo "下一步："
echo "  1) 开一个新终端，确认可以用新用户登录："
echo "       ssh ${DEPLOY_USER}@<服务器IP>"
echo "     ★ 确认成功后再关闭当前 root 会话"
echo "  2) 部署项目："
echo "       sudo -iu ${DEPLOY_USER}"
echo "       cd ${PROJECT_DIR}"
echo "       # 上传代码后见 docs/DEPLOY.md 第 4 节"
echo
if [[ "$(free -m | awk '/^Mem:/{print $2}')" -lt 3000 ]]; then
  warn "内存小于 3GB：首次 docker compose build 前建议先 docker compose stop postgres"
  warn "或参考 docs/DEPLOY.md 的「低内存机器构建」一节改用 CI 构建"
fi
