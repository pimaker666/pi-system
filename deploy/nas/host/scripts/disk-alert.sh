#!/bin/bash
# disk-alert.sh — 每日检查系统盘与 docker 卷使用率，超过阈值写入告警日志
# 用法：crontab 调度，例如 0 8 * * * /home/Jessie/scripts/disk-alert.sh
set -euo pipefail

LOG_DIR="${PI_LOG_DIR:-/home/Jessie/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/disk-alert.log"
HOSTNAME_STR=$(hostname)
NOW=$(date '+%Y-%m-%d %H:%M:%S')

WARN_PCT=85
CRIT_PCT=92

# 检查一个挂载点的磁盘使用率。$1 = 挂载点, $2 = 标签
check_mount() {
  local mnt="$1"
  local label="$2"
  local line pct

  line=$(df -P "$mnt" 2>/dev/null | awk 'NR==2 {print $0}')
  if [[ -z "$line" ]]; then
    echo "[$NOW] [$HOSTNAME_STR] WARN  无法读取 $mnt ($label)" >> "$LOG_FILE"
    return
  fi

  pct=$(echo "$line" | awk '{gsub(/%/,"",$5); print $5}')
  if [[ ! "$pct" =~ ^[0-9]+$ ]]; then
    echo "[$NOW] [$HOSTNAME_STR] WARN  解析 $mnt 使用率失败: $line" >> "$LOG_FILE"
    return
  fi

  if (( pct >= CRIT_PCT )); then
    echo "[$NOW] [$HOSTNAME_STR] CRIT  $label ($mnt) = ${pct}%  >= ${CRIT_PCT}%" >> "$LOG_FILE"
  elif (( pct >= WARN_PCT )); then
    echo "[$NOW] [$HOSTNAME_STR] WARN  $label ($mnt) = ${pct}%  >= ${WARN_PCT}%" >> "$LOG_FILE"
  else
    echo "[$NOW] [$HOSTNAME_STR] OK    $label ($mnt) = ${pct}%" >> "$LOG_FILE"
  fi
}

if [[ -n "${PI_MOUNT_POINTS:-}" ]]; then
  for entry in $PI_MOUNT_POINTS; do
    mnt="${entry%%|*}"
    label="${entry#*|}"
    [[ -n "$mnt" && -n "$label" && "$mnt" != "$label" ]] && check_mount "$mnt" "$label"
  done
else
  check_mount "/"             "系统盘"
  check_mount "/volume2"     "数据卷(含 /volume2/@docker)"
fi

# 日志自旋：超过 2MB 只保留最近 500 行
if [[ -f "$LOG_FILE" ]]; then
  bytes=$(stat -c '%s' "$LOG_FILE" 2>/dev/null || echo 0)
  if (( bytes > 2 * 1024 * 1024 )); then
    tail -n 500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi
