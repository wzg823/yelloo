#!/usr/bin/env bash
#
# 数据库备份。挂到宿主 cron 上每天执行：
#   0 4 * * * /opt/bbs/scripts/backup.sh >> /var/log/bbs-backup.log 2>&1
#
# 单机部署没有托管数据库的自动 PITR，这个脚本就是唯一的数据安全保障。
# 不做备份的单机部署 = 迟早丢数据，这不是"以后再说"的事。
#
set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/opt/bbs/backups}"
# 保留天数。按日均数据量与目标盘容量调整；论坛文本数据增长很慢，30 天足够
RETAIN_DAYS="${RETAIN_DAYS:-30}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/bbs/docker-compose.yml}"
# 若设置了该变量，备份会额外上传到对象存储（建议：Cloudflare R2，零出口费）
R2_REMOTE="${R2_REMOTE:-}"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/bbs-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

# ── 导出 ────────────────────────────────────────────────────────────────
# 用自定义格式(-Fc)而不是纯 SQL：体积更小，且 pg_restore 支持并行与选择性恢复。
# 但为了跨大版本恢复的兼容性，这里用 plain + gzip，牺牲一点恢复速度换稳妥。
echo "[$(date -Iseconds)] 开始备份 → ${TARGET}"

docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  pg_dump \
    --username="${POSTGRES_USER:-bbs}" \
    --dbname="${POSTGRES_DB:-bbs}" \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
  | gzip -9 > "${TARGET}"

# ── 校验 ────────────────────────────────────────────────────────────────
# 关键步骤：gzip 完整性检查。没有这一步，一个被截断的备份文件
# 会在真正需要恢复时才发现不可用。
if ! gzip -t "${TARGET}"; then
  echo "[$(date -Iseconds)] ✗ 备份文件损坏，删除并退出" >&2
  rm -f "${TARGET}"
  exit 1
fi

SIZE="$(du -h "${TARGET}" | cut -f1)"
echo "[$(date -Iseconds)] ✓ 备份完成（${SIZE}）"

# ── 上传到对象存储（可选）──────────────────────────────────────────────
if [[ -n "${R2_REMOTE}" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "${TARGET}" "${R2_REMOTE}" && \
      echo "[$(date -Iseconds)] ✓ 已上传到 ${R2_REMOTE}"
  else
    echo "[$(date -Iseconds)] ! 未安装 rclone，跳过上传" >&2
  fi
fi

# ── 清理旧备份 ──────────────────────────────────────────────────────────
find "${BACKUP_DIR}" -name 'bbs-*.sql.gz' -type f -mtime "+${RETAIN_DAYS}" -delete
echo "[$(date -Iseconds)] 已清理 ${RETAIN_DAYS} 天前的备份"
