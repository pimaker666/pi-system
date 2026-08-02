#!/usr/bin/env bash
###############################################################
# 把 deploy/nas/supabase.env 里的值，合并进官方 supabase/docker/.env
# （匹配同名变量就替换其值；官方没有的键就追加到末尾）
#
# 用法（在 supabase/docker 目录下）：
#   bash merge-env.sh /volume1/docker/pi-system/deploy/nas/supabase.env .env
###############################################################
set -euo pipefail
OVERRIDE="${1:?用法: merge-env.sh <supabase.env路径> [目标.env路径]}"
TARGET="${2:-.env}"
[ -f "$OVERRIDE" ] || { echo "找不到覆盖文件 $OVERRIDE"; exit 1; }
[ -f "$TARGET" ]   || { echo "找不到 $TARGET，请先 cp .env.example .env"; exit 1; }

awk -F= '
  # 第一个文件：读入覆盖项
  NR==FNR {
    if ($0 ~ /^[[:space:]]*#/ || $0 !~ /=/) next
    key=$1; sub(/^[ \t]+/,"",key); sub(/[ \t]+$/,"",key)
    val=substr($0, index($0,"=")+1)
    ov[key]=val; order[++n]=key; seen[key]=0
    next
  }
  # 第二个文件：逐行重写目标 .env
  {
    if ($0 ~ /=/ && $0 !~ /^[[:space:]]*#/) {
      key=$1; sub(/^[ \t]+/,"",key); sub(/[ \t]+$/,"",key)
      if (key in ov) { print key"="ov[key]; seen[key]=1; next }
    }
    print
  }
  END { for (i=1;i<=n;i++){ k=order[i]; if(!seen[k]) print k"="ov[k] } }
' "$OVERRIDE" "$TARGET" > "$TARGET.merged" && mv "$TARGET.merged" "$TARGET"

echo "已把 $OVERRIDE 合并进 $TARGET"
