#!/usr/bin/env bash
#
# 部署 / 更新。**在服务器上执行。**
#
# 用法：
#     ./scripts/deploy.sh                 # 更新代码 → 构建 → 迁移 → 重启 → 健康检查
#     ./scripts/deploy.sh --smoke         # 上面全部 + 端到端验证
#     ./scripts/deploy.sh --no-pull       # 不拉 git，用当前代码（配合本地 rsync/scp 上传）
#     ./scripts/deploy.sh --no-build      # 跳过构建（只改了 .env 等运行时配置时用）
#     ./scripts/deploy.sh --rollback      # 回到上一个 git 提交并重新部署
#
# 为什么要有这个脚本，而不是手敲命令：
#
#   1. **顺序是硬约束**。必须「先迁移，再滚动更新应用」。
#      反过来的话，新代码会访问还不存在的列/表，表现为 500 而不是清晰的报错。
#   2. **构建期变量容易漏**。NEXT_PUBLIC_* 在构建期内联，只 restart 容器无效。
#      脚本统一把 build 和 up 绑在一起，杜绝"改了没生效"。
#   3. **失败要能回滚**。构建失败时应该保留旧容器继续服务，
#      而不是把站点留在一个半更新状态。脚本用 `set -e` + 显式顺序保证这点。
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

# ── 参数 ────────────────────────────────────────────────────────────────
DO_PULL=1
DO_BUILD=1
DO_SMOKE=0
DO_ROLLBACK=0

for arg in "$@"; do
  case "$arg" in
    --no-pull)   DO_PULL=0 ;;
    --no-build)  DO_BUILD=0 ;;
    --smoke)     DO_SMOKE=1 ;;
    --rollback)  DO_ROLLBACK=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

# ── 输出助手 ────────────────────────────────────────────────────────────
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

step()  { printf '\n%s==>%s %s\n' "$BLUE" "$RESET" "$1"; }
ok()    { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '\n%s  ✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────
step "环境检查"

[[ -f docker-compose.yml ]] || die "当前目录不是项目根（找不到 docker-compose.yml）"
command -v docker >/dev/null 2>&1 || die "未安装 Docker"

# compose v2 是子命令；v1 是独立的 docker-compose。这里统一成数组调用。
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
  warn "检测到 Compose v1，建议升级到 v2（v1 已停止维护）"
else
  die "未找到 docker compose"
fi
ok "Docker 可用：$(docker --version | cut -d, -f1)"

if [[ -f .env ]]; then
  ok ".env 存在"
else
  die ".env 不存在。请从 .env.example 复制并填写（至少 DATABASE_URL / SESSION_SECRET / SITE_URL）"
fi

# 危险配置检查：上了生产却还用占位值
if grep -qE '^SESSION_SECRET=(请替换|changeme|)$' .env 2>/dev/null; then
  die ".env 里的 SESSION_SECRET 还是占位值。用 openssl rand -base64 48 生成一个"
fi

# 记录当前提交，供回滚与排查使用
PREV_COMMIT=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  PREV_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi

# ── 1. 更新代码 ─────────────────────────────────────────────────────────
if [[ $DO_ROLLBACK -eq 1 ]]; then
  step "回滚到上一个提交"
  git rev-parse --git-dir >/dev/null 2>&1 || die "不是 git 仓库，无法自动回滚。
    请手动切到上一个版本的代码，再执行 ./scripts/deploy.sh --no-pull"

  CURRENT_COMMIT="$(git rev-parse HEAD)"
  TARGET_COMMIT="$(git rev-parse HEAD~1 2>/dev/null || true)"
  [[ -n "$TARGET_COMMIT" ]] || die "找不到上一个提交（可能只有一次提交）"

  git checkout "$TARGET_COMMIT" || die "git checkout 失败"
  ok "已回滚：${CURRENT_COMMIT:0:8} → ${TARGET_COMMIT:0:8}"

  # 回滚后不能再去 pull，否则会立刻覆盖回滚结果
  DO_PULL=0

  # 数据库迁移**不回滚**：Drizzle 不生成 down 迁移。
  # 若上一个版本缺少本次新增的列/表，回滚后应用会报错——
  # 这也是"迁移只做加法"这条纪律存在的原因。
  warn "注意：数据库迁移不会回滚。若新版本引入了破坏性变更，回滚后应用可能报错"
  warn "回到分支：git checkout <分支名>"
elif [[ $DO_PULL -eq 1 ]]; then
  step "更新代码"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    if [[ -n "$(git status --porcelain)" ]]; then
      warn "工作区有未提交的改动，跳过 git pull 以免冲突"
      warn "若这些改动是上传的代码，请用 --no-pull"
    else
      git fetch --depth=1 origin >/dev/null 2>&1 || warn "git fetch 失败（网络？）"
      git pull --ff-only || die "git pull 失败。若有本地改动请先处理，或用 --no-pull"
      ok "已更新到 $(git rev-parse --short HEAD)"
    fi
  else
    warn "不是 git 仓库，跳过拉取（使用当前代码）"
  fi
else
  step "更新代码"
  ok "已跳过（--no-pull）"
fi

# ── 2. 构建镜像 ─────────────────────────────────────────────────────────
# ★ 必须显式列出三个服务 ★
#
# `docker compose build` 不带参数只构建**有 build: 段且未被依赖的服务**。
# 我们的 migrate / seed 是独立服务，它们各自有自己的镜像标签
# （bbs-migrate:latest / bbs-seed:latest）。如果只构建 app，
# 那么 `docker compose run --rm migrate` 会去用**上次构建的旧镜像**，
# 结果就是"代码改了但迁移脚本还是旧的"——这个坑真实发生过：
# 修好了 SSL 判断却仍报 "does not support SSL connections"，
# 因为容器里跑的是几十分钟前的 migrate.mjs。
#
# 内存不足时会以 exit 137 失败。提前给出明确提示，而不是让用户对着
# "Killed" 猜原因——这是低配机器部署最常见的一次性故障。
if [[ $DO_BUILD -eq 1 ]]; then
  step "构建镜像"
  MEM_MB="$(free -m | awk '/^Mem:/{print $2}')"
  SWAP_MB="$(free -m | awk '/^Swap:/{print $2}')"
  printf '%s    内存 %sMB / swap %sMB%s\n' "$DIM" "$MEM_MB" "$SWAP_MB" "$RESET"

  # ★ 低内存保护：构建前主动停掉其它服务 ★
  #
  # 这不是"优化"，是必需步骤。实测教训：在 1.6GB 的机器上直接构建，
  # `npm ci` + `next build` 峰值约 1.8GB，超出部分全压到 swap，
  # 内核换页抖动严重到 **sshd 收下 TCP 连接却无法完成 banner 交换**，
  # 表现为 SSH 完全连不上、机器无法管理，最终只能去云控制台硬重启。
  #
  # 停掉 Postgres 与 Caddy 后可用内存从约 990MB 升到约 1.4GB，
  # 构建时间从"不可用"降到 1 分钟以内（基础层命中缓存时）。
  #
  # 代价：构建期间站点短暂不可访问（本机部署无法避免）。
  # 想彻底避开这一点就走镜像仓库方案，见 docs/DEPLOY.md 第 1 节。
  STOPPED_FOR_BUILD=""
  if [[ "$MEM_MB" -lt 3000 ]]; then
    if [[ "$SWAP_MB" -lt 1500 ]]; then
      die "内存 ${MEM_MB}MB 且没有 swap。构建必然 OOM 并可能把机器拖到无法 SSH。
    先执行 scripts/provision.sh 配置 2GB swap，或改用镜像仓库方案（docs/DEPLOY.md 第 1 节）。"
    fi

    warn "内存 ${MEM_MB}MB < 3GB：构建前先停掉 postgres / caddy 腾出内存"
    warn "（构建期间站点短暂不可访问；实在不想中断请改用镜像仓库方案）"
    "${COMPOSE[@]}" stop caddy postgres >/dev/null 2>&1 || true
    STOPPED_FOR_BUILD=1
    free -m | awk '/^Mem:/{printf "    停服后可用 %sMB\n", $7}'
  fi

  # 无论构建成功与否都要把服务拉起来，否则一次构建失败会把站点留在停机状态
  restore_services() {
    if [[ -n "$STOPPED_FOR_BUILD" ]]; then
      "${COMPOSE[@]}" up -d >/dev/null 2>&1 || true
    fi
  }
  trap restore_services EXIT

  if ! "${COMPOSE[@]}" build app migrate seed; then
    die "构建失败。若退出码为 137，说明内存不足：
      · 配 2GB swap：bash scripts/provision.sh
      · 或改用镜像仓库：docs/DEPLOY.md 第 1 节"
  fi
  ok "镜像构建完成（app / migrate / seed）"
else
  step "构建镜像"
  ok "已跳过（--no-build）"
fi

# ── 2b. 校验 Caddyfile 语法 ─────────────────────────────────────────────
# Caddy 配置写错时不会"部分生效"，而是**拒绝启动并进入重启循环**，
# 表现为 80/443 上完全没有监听 —— 从应用日志里完全看不出问题。
# 提前校验能把这类故障挡在重启之前。
if [[ -f Caddyfile ]]; then
  step "校验 Caddyfile"
  if "${COMPOSE[@]}" run --rm --no-deps --entrypoint caddy caddy \
       validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
    ok "Caddyfile 语法正确"
  else
    tail -5 /tmp/caddy-validate.log
    die "Caddyfile 语法错误，已中止。Caddy 会因配置无法解析而反复重启，
    导致 80/443 没有任何监听。请修正后重试（常见错误：在 file_server 块内写 header）。"
  fi
fi

# ── 3. 数据库迁移（必须在应用更新之前）──────────────────────────────────
step "执行数据库迁移"
"${COMPOSE[@]}" run --rm migrate || die "迁移失败。**应用未更新**，站点仍在运行旧版本。
    排查：${COMPOSE[*]} logs postgres"
ok "迁移完成"

# ── 4. 启动 / 滚动更新 ──────────────────────────────────────────────────
step "启动服务"
"${COMPOSE[@]}" up -d --remove-orphans || die "启动失败。排查：${COMPOSE[*]} logs app"
ok "已启动"

# ── 5. 健康检查 ─────────────────────────────────────────────────────────
step "健康检查"

# ★ 必须在容器内检查，不能在宿主机 curl 127.0.0.1:3000 ★
#
# compose 里 app 只有 `expose: 3000`（仅 compose 内网可达），
# 刻意**不映射到宿主机**——数据库与应用端口都不对公网开放是本方案的安全边界。
# 因此从宿主机 curl :3000 必然连接被拒，那是"设计如此"，不是故障。
#
# 改为在容器内检查有两个好处：
#   1. 真正验证应用自身与数据库连通性，排除了 Caddy 的干扰
#   2. 不需要给 app 开端口，保持最小暴露面
WAIT_SECONDS=90
elapsed=0
healthy=0

while [[ $elapsed -lt $WAIT_SECONDS ]]; do
  if "${COMPOSE[@]}" exec -T app curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/tmp/bbs-health.json 2>/dev/null; then
    # 用宽松匹配：JSON 可能被格式化带空格
    if grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' /tmp/bbs-health.json; then
      healthy=1
      break
    fi
  fi
  sleep 2
  elapsed=$((elapsed + 2))
  if (( elapsed % 10 == 0 )); then
    printf '%s    ...已等待 %ss%s\n' "$DIM" "$elapsed" "$RESET"
  fi
done

if [[ $healthy -eq 0 ]]; then
  echo
  warn "健康检查未通过（等待 ${WAIT_SECONDS}s）。最近的应用日志："
  "${COMPOSE[@]}" logs --tail 40 app || true
  echo
  die "部署未成功。排查方向：
    · 数据库未就绪：${COMPOSE[*]} logs postgres
    · 迁移未执行：${COMPOSE[*]} run --rm migrate
    · 应用内错误：${COMPOSE[*]} logs app"
fi

# 展示健康检查详情，便于确认实时连接数与数据库延迟
printf '%s%s%s\n' "$DIM" "$(cat /tmp/bbs-health.json)" "$RESET"
rm -f /tmp/bbs-health.json
ok "应用健康（容器内 /api/health 返回 ok）"

# ── 5b. 探测对外入口（仅告警，不阻断部署）────────────────────────────────
#
# ★ 这一节刻意**不**在失败时 die ★
# 原因：Caddy 的行为取决于访问方式，很多"看起来失败"其实是正常的：
#   · DOMAIN 是真实域名 → Caddy 强制 HTTP→HTTPS 跳转，对 /api/health 返回 308
#   · DOMAIN=localhost   → Caddy 用内部 CA 签发证书，curl 必然报
#                          "tlsv1 alert internal error"（不是故障）
#   · 反代本身健康时它自己的 active health check 会在日志里持续输出 host is up
# 部署是否成功应以「应用健康」为准；入口异常只提示人去确认。
step "探测对外入口（经 Caddy）"

entry_ok=0
entry_http="000"
if command -v curl >/dev/null 2>&1; then
  # 不跟随跳转：308 本身就是"Caddy 已加载 vhost 并在正常工作"的证据
  entry_http="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/api/health 2>/dev/null || echo 000)"
  case "$entry_http" in
    200|301|302|307|308) entry_ok=1 ;;
  esac
fi

if [[ $entry_ok -eq 1 ]]; then
  ok "Caddy 正常应答（HTTP ${entry_http}）"
elif [[ "$entry_http" != "000" ]]; then
  warn "Caddy 返回了非预期状态码 HTTP ${entry_http}（可能是配置或上游问题）"
else
  warn "无法从宿主机访问 Caddy。检查容器与端口映射："
  "${COMPOSE[@]}" ps caddy || true
fi

# 反代自身的健康检查结果最可信：Caddy 会主动探测上游并记录
if "${COMPOSE[@]}" logs caddy --tail 40 2>/dev/null | grep -q '"msg":"host is up"'; then
  ok "Caddy 已探测到上游 app:3000 正常"
else
  warn "Caddy 日志中未见上游健康记录（可能刚启动，稍后再看）"
fi

if [[ $entry_ok -eq 0 ]]; then
  printf '%s    最近 Caddy 日志：%s\n' "$DIM" "$RESET"
  "${COMPOSE[@]}" logs --tail 15 caddy 2>&1 | sed 's/^/      /' || true
  printf '%s    排障：若日志出现 "unknown subdirective" 等解析错误，%s\n' "$DIM" "$RESET"
  printf '%s    Caddy 会反复重启并停止监听 80/443，而此时应用日志完全正常。%s\n' "$DIM" "$RESET"
fi

# ── 6. 容器状态 ─────────────────────────────────────────────────────────
step "容器状态"
"${COMPOSE[@]}" ps

# ── 7. 端到端验证（可选）────────────────────────────────────────────────
if [[ $DO_SMOKE -eq 1 ]]; then
  step "端到端验证"

  # ★ 在 app 容器内跑，不在宿主机跑 ★
  # app 端口没有映射到宿主机（见第 5 节说明），宿主机也未必装了 Node。
  # 镜像里已经有 node 与 scripts/smoke.mjs，容器内直接跑最省事，
  # 而且天然绕开 Caddy/DNS/证书这些与业务无关的变量。
  #
  # 若确实要验证对外域名（含 Caddy 的 SSE 配置），显式传 SMOKE_BASE_URL：
  #     SMOKE_BASE_URL=https://bbs.example.com ./scripts/deploy.sh --smoke
  if ! "${COMPOSE[@]}" exec -T app sh -c 'command -v node >/dev/null 2>&1'; then
    warn "app 镜像内没有 node，跳过端到端验证"
    SMOKE_FAILED=1
  elif "${COMPOSE[@]}" exec -T -e BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:3000}" app \
         node scripts/smoke.mjs 2>&1 | sed "s|^|    |"; then
    ok "端到端验证通过（针对 ${SMOKE_BASE_URL:-应用容器内自身}）"
  else
    warn "端到端验证有失败项（见上方输出）。详细解读见 docs/DEPLOY.md 第 5 节"
    SMOKE_FAILED=1
  fi
else
  step "端到端验证"
  ok "已跳过（加 --smoke 启用）"
  printf '%s    建议在正式开放访问前跑一次：./scripts/deploy.sh --no-pull --no-build --smoke%s\n' "$DIM" "$RESET"
fi

# ── 完成 ────────────────────────────────────────────────────────────────
echo
printf '%s══════════════════════════════════════════════════%s\n' "$BOLD$GREEN" "$RESET"
if [[ -n "${SMOKE_FAILED:-}" ]]; then
  printf '%s  部署完成（但端到端验证有失败项）%s\n' "$BOLD$YELLOW" "$RESET"
else
  printf '%s  部署完成%s\n' "$BOLD$GREEN" "$RESET"
fi
printf '%s══════════════════════════════════════════════════%s\n' "$BOLD$GREEN" "$RESET"
echo
printf '  站点      %s\n' "${SITE_URL:-（未设置 SITE_URL）}"
printf '  本机入口  http://127.0.0.1/ （经 Caddy；app 端口仅内网可达）\n'
[[ -n "$PREV_COMMIT" ]] && printf '  本次提交  %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
echo
printf '%s  常用命令%s\n' "$BOLD" "$RESET"
printf '    日志        %s logs -f app\n' "${COMPOSE[*]}"
printf '    数据库      %s exec postgres psql -U bbs -d bbs\n' "${COMPOSE[*]}"
printf '    备份        ./scripts/backup.sh\n'
printf '    回滚        ./scripts/deploy.sh --rollback\n'
echo
if [[ -n "$PREV_COMMIT" ]] && [[ "$DO_ROLLBACK" -eq 0 ]]; then
  printf '%s  上一个版本是 %s，需要回滚时执行 --rollback%s\n' "$DIM" "${PREV_COMMIT:0:8}" "$RESET"
fi

exit 0
