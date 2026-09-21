#!/bin/bash
set -euo pipefail

LOG_DIR="${PI_LOG_DIR:-/home/Jessie/logs}"
LOG_FILE="$LOG_DIR/business-order-purge.log"
DB_CONTAINER="supabase-db"
APP_CONTAINER="pi-app"
LOCK_DIR="/tmp/business-order-purge.lock"

mkdir -p "$LOG_DIR"
exec >> "$LOG_FILE" 2>&1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "WARN  上一次清除仍在运行，本次跳过"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

db_scalar() {
  docker exec "$DB_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 \
    -U supabase_admin -d postgres -c "$1"
}

delete_storage_objects() {
  docker exec -i "$APP_CONTAINER" node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  try {
    const objects = JSON.parse(input);
    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!baseUrl || !serviceKey) throw new Error("pi-app 缺少 Storage API 环境变量");

    const groups = new Map();
    for (const object of objects) {
      if (!object || typeof object.bucket !== "string" || typeof object.object_path !== "string") continue;
      const path = object.object_path.trim();
      if (!path) continue;
      const paths = groups.get(object.bucket) || [];
      paths.push(path);
      groups.set(object.bucket, paths);
    }

    for (const [bucket, paths] of groups) {
      const uniquePaths = [...new Set(paths)];
      for (let offset = 0; offset < uniquePaths.length; offset += 100) {
        const prefixes = uniquePaths.slice(offset, offset + 100);
        const response = await fetch(
          `${baseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}`,
          {
            method: "DELETE",
            headers: {
              apikey: serviceKey,
              authorization: `Bearer ${serviceKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ prefixes })
          }
        );
        if (!response.ok) throw new Error(`Storage API HTTP ${response.status} (${bucket})`);
        console.log(`OK    Storage bucket=${bucket} deleted=${prefixes.length}`);
      }
    }
  } catch (error) {
    console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});
'
}

log "INFO  终止订单清除开始"
before_id="$(db_scalar "select coalesce(max(id), 0) from public.business_order_purge_log")"
storage_rows="$(db_scalar "select count(*) from public.purge_terminated_business_orders(interval '3 months', 500)")"
purged_orders="$(db_scalar "select count(*) from public.business_order_purge_log where id > ${before_id}")"
log "INFO  数据库清除完成 orders=${purged_orders} storage_objects=${storage_rows}"

success=0
failed=0
while IFS= read -r log_id; do
  [[ "$log_id" =~ ^[0-9]+$ ]] || continue
  objects_json="$(db_scalar "select storage_objects::text from public.business_order_purge_log where id = ${log_id}")"

  if printf '%s' "$objects_json" | delete_storage_objects; then
    db_scalar "update public.business_order_purge_log set storage_cleanup_attempted_at = now(), storage_cleanup_at = now(), storage_cleanup_error = null where id = ${log_id} returning 1" >/dev/null
    success=$((success + 1))
  else
    db_scalar "update public.business_order_purge_log set storage_cleanup_attempted_at = now(), storage_cleanup_error = 'Storage API deletion failed; see business-order-purge.log' where id = ${log_id} returning 1" >/dev/null
    failed=$((failed + 1))
  fi
done < <(db_scalar "select id from public.business_order_purge_log where storage_cleanup_at is null order by id limit 500")

log "INFO  文件清理完成 success=${success} failed=${failed}"

if [[ -f "$LOG_FILE" ]]; then
  bytes="$(stat -c '%s' "$LOG_FILE" 2>/dev/null || echo 0)"
  if (( bytes > 2 * 1024 * 1024 )); then
    tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi

if (( failed > 0 )); then
  exit 1
fi
