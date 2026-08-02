#!/usr/bin/env bash
###############################################################
# 把 pi-system 的 11 个迁移脚本按顺序灌入自建 Supabase 数据库。
# 前提：Supabase 全家桶已 `docker compose up -d` 且 db/auth/storage
#       都已完成首启初始化（auth、storage schema 已存在）。
#
# 用法（在 supabase/docker 目录下执行，MIGRATIONS_DIR 指向本仓库的
#       supabase/migrations）：
#   MIGRATIONS_DIR=/volume1/docker/pi-system/supabase/migrations \
#     bash apply-migrations.sh
###############################################################
set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:?请设置 MIGRATIONS_DIR 指向 supabase/migrations 目录}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"

echo "==> 等待数据库就绪..."
for i in $(seq 1 30); do
  if docker compose exec -T "$DB_SERVICE" pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    echo "    数据库已就绪"
    break
  fi
  sleep 2
done

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "!! 在 $MIGRATIONS_DIR 未找到 .sql 文件"; exit 1
fi

for f in "${files[@]}"; do
  echo "==> 应用 $(basename "$f")"
  docker compose exec -T "$DB_SERVICE" \
    psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$f"
done

echo "==> 全部迁移已应用完成。"
echo "    存储桶（product-images / pi-pdfs / company-assets）由 0001_init.sql 自动创建。"
