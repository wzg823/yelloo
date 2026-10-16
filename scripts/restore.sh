#!/usr/bin/env bash
#
# 数据库恢复。**这是最后手段**，会覆盖现有数据。
#
# 用法：
#   ./scripts/restore.sh backups/bbs-20250101-040000.sql.gz
#
# 演练建议：上线前至少完整走一遍恢复流程到一台临时机器上。
# 没演练过的备份策略，等于没有备份策略。
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "用法: $0 <备份文件.sql.gz>" >&2
  exit 1
fi

BACKUP_FILE="$1"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "✗ 找不到备份文件：${BACKUP_FILE}" >&2
  exit 1
fi

if ! gzip -t "${BACKUP_FILE}"; then
  echo "✗ 备份文件已损坏，拒绝恢复" >&2
  exit 1
fi

echo "⚠️  即将用以下备份覆盖数据库：${BACKUP_FILE}"
echo "⚠️  应用应先停止写入（docker compose stop app）以避免不一致。"
read -r -p "输入 'yes' 继续：" CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "已取消"
  exit 0
fi

echo "[$(date -Iseconds)] 开始恢复…"

# --single-transaction 让恢复过程中的失败不会留下半截数据
gunzip -c "${BACKUP_FILE}" | docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  psql \
    --username="${POSTGRES_USER:-bbs}" \
    --dbname="${POSTGRES_DB:-bbs}" \
    --single-transaction \
    --set ON_ERROR_STOP=on

echo "[$(date -Iseconds)] ✓ 恢复完成，请执行 docker compose start app"
