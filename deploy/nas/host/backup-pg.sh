#!/bin/sh
# pi-system 每日数据库备份：pg_dump -Fc + 校验 + 14 天滚动清理
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -u
BACKUP_DIR=/home/Jessie/backups
KEEP_DAYS=14
STAMP=$(date +%Y%m%d-%H%M)
LOG=$BACKUP_DIR/backup.log
TMP=$BACKUP_DIR/.tmp-daily-$STAMP.dump
FINAL=$BACKUP_DIR/pi-system-daily-$STAMP.dump

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$TMP"' EXIT

if ! docker exec supabase-db pg_dump -U supabase_admin -Fc postgres > "$TMP" 2>>"$LOG"; then
  log "FAILED: pg_dump 执行失败，已丢弃本次备份"
  exit 1
fi

OBJECTS=$(docker exec -i supabase-db pg_restore --list < "$TMP" 2>/dev/null | grep -c ';')
SIZE=$(wc -c < "$TMP" | tr -d ' ')
if [ "${SIZE:-0}" -lt 1000000 ] || [ "${OBJECTS:-0}" -lt 100 ]; then
  log "FAILED: 备份校验不通过 size=${SIZE:-0} objects=${OBJECTS:-0}，已丢弃"
  exit 1
fi

mv "$TMP" "$FINAL"
log "OK: $FINAL size=$SIZE objects=$OBJECTS"

find "$BACKUP_DIR" -maxdepth 1 -name 'pi-system-daily-*.dump' -mtime +$KEEP_DAYS -print -delete >> "$LOG" 2>&1

# 手工快照（迁移前备份等，非 daily）同样保留 30 天
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' ! -name 'pi-system-daily-*.dump' -mtime +30 -print -delete >> "$LOG" 2>&1
