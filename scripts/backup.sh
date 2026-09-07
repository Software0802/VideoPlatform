#!/usr/bin/env bash
# Genius 数据备份（在服务器上跑）。方案见 docs/plan-architecture-2026-09.md §3.2「数据安全」。
#
#   bash scripts/backup.sh                              # 用默认路径
#   DATA_DIR=/srv/data BACKUP_DIR=/srv/bak KEEP=7 bash scripts/backup.sh
#   bash scripts/backup.sh --data-dir /srv/data --keep 7
#
# 只打「丢了就重建不出来」的事实源：
#   users/      账号（含密码哈希）、users/index.json 派生缓存
#   invites/    一次性邀请码
#   gift-codes/ 礼品码（面额 + 认领状态；丢了等于凭空多出一批可兑换的钱）
#   ledger/     余额流水（余额模型上线后才有，不存在就跳过）
#   agent/      智能体会话（2026-09-07 起；每人一个目录，不存在就跳过）
#   templates/  模板（可由 data-seed 重建，但线上可能被手改过，顺带打）
#   jobs/*/job.json  任务记录本身
# **不打**产物（outputs / inputs / shots / tmp）：几十上百 MB，且 30 天后本来就会被
# 留存清理删掉；备份的目的是「账号与账目不丢」，不是留存成片。这一点靠先用 find 列出
# 白名单文件、再 `tar --files-from` 保证——不是靠 --exclude，漏一个模式就会把 mp4 打进去。
# idempotency/ 也不打：24 小时就过期，重建无损。
#
# 退出码：0 成功；非 0 表示这次备份没有产出可用的包，cron 日志里会有原因。
set -euo pipefail
# 包里有密码哈希与邀请码，别让同机其它用户读到。
umask 077

DATA_DIR="${DATA_DIR:-/opt/genius/data}"
BACKUP_DIR="${BACKUP_DIR:-/opt/genius/backups}"
KEEP="${KEEP:-14}"

usage() {
  cat <<'USAGE'
用法: backup.sh [--data-dir DIR] [--backup-dir DIR] [--keep N]
  --data-dir    数据目录，默认 $DATA_DIR 或 /opt/genius/data
  --backup-dir  备份落地目录，默认 $BACKUP_DIR 或 /opt/genius/backups
  --keep        保留最近 N 份，默认 $KEEP 或 14
USAGE
}

die() {
  echo "backup fail: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) [ $# -ge 2 ] || die "--data-dir 缺少参数"; DATA_DIR="$2"; shift 2 ;;
    --data-dir=*) DATA_DIR="${1#*=}"; shift ;;
    --backup-dir) [ $# -ge 2 ] || die "--backup-dir 缺少参数"; BACKUP_DIR="$2"; shift 2 ;;
    --backup-dir=*) BACKUP_DIR="${1#*=}"; shift ;;
    --keep) [ $# -ge 2 ] || die "--keep 缺少参数"; KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "KEEP 必须是非负整数，收到: $KEEP" ;;
esac
[ "$KEEP" -ge 1 ] || die "KEEP 至少为 1，收到: $KEEP"
[ -d "$DATA_DIR" ] || die "DATA_DIR 不存在: $DATA_DIR"

mkdir -p "$BACKUP_DIR" || die "无法创建 BACKUP_DIR: $BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/genius-data-$STAMP.tgz"
# 先落 .tmp 再 mv：mv 在同一文件系统内是原子的，所以 BACKUP_DIR 里出现的
# genius-data-*.tgz 一定是写完的包，半截文件不会被下次的保留策略当成有效备份。
TMP_OUT="$OUT.tmp"

LIST=""
LISTING=""
cleanup() {
  if [ -n "$LIST" ]; then rm -f "$LIST"; fi
  if [ -n "$LISTING" ]; then rm -f "$LISTING"; fi
  if [ -n "$TMP_OUT" ]; then rm -f "$TMP_OUT"; fi
  return 0
}
trap cleanup EXIT

LIST="$(mktemp "${TMPDIR:-/tmp}/genius-backup-list-XXXXXX")"
LISTING="$(mktemp "${TMPDIR:-/tmp}/genius-backup-verify-XXXXXX")"

# 白名单清单，NUL 分隔，路径相对 DATA_DIR。
(
  cd "$DATA_DIR"
  for d in users invites gift-codes ledger agent templates; do
    if [ -d "$d" ]; then find "$d" -print0; fi
  done
  # jobs/<id>/job.json 且只有它：mindepth/maxdepth 2 天然挡掉 outputs/ inputs/ shots/。
  if [ -d jobs ]; then
    find jobs -mindepth 2 -maxdepth 2 -type f -name job.json -print0
  fi
) > "$LIST" || die "扫描 $DATA_DIR 失败"

[ -s "$LIST" ] || die "$DATA_DIR 里没有可备份的内容（users/ invites/ gift-codes/ ledger/ agent/ templates/ jobs/*/job.json 全为空）"

# 服务是活的，job.json 可能正好在写。GNU tar 遇到「读的时候文件变了」退出 1，
# 这不是致命错误（原子 rename 保证读到的是完整的旧版或新版），退出 ≥2 才是真失败。
set +e
# --no-recursion 是关键：清单里既有目录也有文件，没有它 tar 会再把目录整个递归一遍，
# 于是 jobs/ 之外的东西重复入包，users/ 下的文件也会存两遍。
tar --create --gzip --file "$TMP_OUT" --directory "$DATA_DIR" \
  --no-recursion --null --files-from "$LIST"
tar_status=$?
set -e
if [ "$tar_status" -eq 1 ]; then
  echo "backup warn: 打包过程中有文件被改写（服务在跑，属正常），包仍可用" >&2
elif [ "$tar_status" -ne 0 ]; then
  die "tar 退出码 $tar_status"
fi
[ -s "$TMP_OUT" ] || die "生成的包是空的: $TMP_OUT"

# 复核：包里除了白名单四类，不许有别的东西（尤其是 jobs/<id>/outputs/*.mp4）。
tar --list --gzip --file "$TMP_OUT" > "$LISTING" || die "无法读回刚生成的包"
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  case "$entry" in
    users|users/*|invites|invites/*|gift-codes|gift-codes/*|ledger|ledger/*|agent|agent/*|templates|templates/*) ;;
    jobs/*/job.json) ;;
    *) die "包内出现不该有的条目「$entry」，已丢弃 $TMP_OUT" ;;
  esac
done < "$LISTING"

SIZE_BYTES="$(wc -c < "$TMP_OUT" | tr -d ' ')"
human_size() {
  if [ "$1" -ge 1048576 ]; then
    awk -v b="$1" 'BEGIN{printf "%.1fMB", b/1048576}'
  elif [ "$1" -ge 1024 ]; then
    awk -v b="$1" 'BEGIN{printf "%.1fKB", b/1024}'
  else
    printf '%dB' "$1"
  fi
}

mv -f "$TMP_OUT" "$OUT" || die "改名失败: $TMP_OUT -> $OUT"
TMP_OUT=""
chmod 600 "$OUT"

# 保留最近 KEEP 份：按 mtime 新→旧，同秒的按文件名（本身就是时间戳）二次排序，
# 保证顺序确定，不会因为并列而误删今天的包。
files=()
while IFS= read -r f; do
  # 用 if 而不是 `[ -n "$f" ] && files+=(...)`：后者在 $f 为空时整条 and-list 非零，
  # 作为循环体最后一条命令会被 set -e 判成失败直接退出。
  if [ -n "$f" ]; then files+=("$f"); fi
done < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'genius-data-*.tgz' -printf '%T@\t%p\n' \
    | sort -t "$(printf '\t')" -k1,1rn -k2,2r \
    | cut -f2-
)
total=${#files[@]}
removed=0
if [ "$total" -gt "$KEEP" ]; then
  for f in "${files[@]:$KEEP}"; do
    rm -f -- "$f"
    removed=$((removed + 1))
  done
fi
kept=$total
if [ "$kept" -gt "$KEEP" ]; then kept=$KEEP; fi

echo "backup ok $OUT $(human_size "$SIZE_BYTES") kept=$kept"
if [ "$removed" -gt 0 ]; then
  echo "backup prune removed=$removed"
fi
