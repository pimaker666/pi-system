#!/usr/bin/env bash
# 带记录的迁移 runner：public.applied_migrations 里已有的迁移自动跳过，
# 新迁移单事务应用成功后才登记，可反复重跑。
# 用法：在仓库根目录执行 bash deploy/nas/apply-migrations-tracked.sh [migrations_dir]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="${1:-$REPO_ROOT/supabase/migrations}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
DB_USER="${DB_USER:-supabase_admin}"
DB_NAME="${DB_NAME:-postgres}"

psql_exec() {
  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

# 记录表由 0130_applied_migrations.sql 创建；表不存在时先应用该文件完成引导。
if ! psql_exec -tAc "select to_regclass('public.applied_migrations')" | grep -q applied_migrations; then
  bootstrap="$(ls "$MIGRATIONS_DIR"/*_applied_migrations.sql 2>/dev/null | head -1 || true)"
  if [ -z "$bootstrap" ]; then
    echo "public.applied_migrations 不存在，且找不到 *_applied_migrations.sql 引导文件" >&2
    exit 1
  fi
  echo "bootstrap $(basename "$bootstrap")"
  psql_exec -1 -f - < "$bootstrap"
fi

applied=0
shopt -s nullglob
for file in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$file")"
  if psql_exec -tAc "select 1 from public.applied_migrations where name = '$name'" | grep -q 1; then
    echo "skip  $name"
    continue
  fi
  echo "apply $name"
  psql_exec -1 -f - < "$file"
  psql_exec -c "insert into public.applied_migrations (name) values ('$name') on conflict (name) do nothing"
  applied=$((applied + 1))
done

if [ "$applied" -gt 0 ]; then
  psql_exec -c "notify pgrst, 'reload schema'" || true
fi
echo "done, applied $applied migration(s)"
