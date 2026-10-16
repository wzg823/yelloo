#!/bin/sh
#
# 容器入口脚本。
#
# ── 为什么需要它 ────────────────────────────────────────────────────
# `uploads` 是 Docker **命名卷**。命名卷首次被挂载时，Docker 会把镜像里
# 该路径的内容复制进去 —— 但**只复制内容，不复制属主与权限**，
# 而且在空卷上会创建为 root:root。
#
# 于是问题来了：应用以非 root 用户（uid 1001）运行，
# 往 root 拥有的目录写文件会得到 EACCES，表现为"上传失败"，
# 而日志里只有一句 `storage_error`，很难定位到卷权限。
#
# 这个脚本先以 root 修好目录属主，再用 gosu 降权执行真正的命令。
# 这是"既能修卷权限、又不以 root 跑应用"的标准做法。
#
# ── 为什么不用 chown -R ─────────────────────────────────────────────
# 附件多起来以后 `chown -R` 会在每次启动时遍历整个卷，拖慢启动。
# 只 chown 顶层目录即可 —— 新建的子目录由 app 用户自己创建，天然属主正确。
#
set -e

UPLOAD_DIR="${UPLOAD_DIR:-/app/var/uploads}"

# 仅在需要且有能力（root）时才修权限
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$UPLOAD_DIR"
  if [ "$(stat -c '%u' "$UPLOAD_DIR" 2>/dev/null || echo 0)" != "1001" ]; then
    chown 1001:1001 "$UPLOAD_DIR" 2>/dev/null || true
  fi

  # 迁移/种子等一次性任务通常以默认 entrypoint 运行，也走这里降权
  exec gosu 1001:1001 "$@"
fi

# 已经不是 root（例如 compose 里指定了 user:），直接执行
exec "$@"
