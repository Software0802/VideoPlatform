#!/usr/bin/env bash
# Genius 数据备份（在服务器上跑）。方案见 docs/plan-architecture-2026-09.md §3.2「数据安全」。
#
#   bash scripts/backup.sh                              # 热备份（cron 每日走这条）
#   DATA_DIR=/srv/data BACKUP_DIR=/srv/bak KEEP=7 bash scripts/backup.sh
#   bash scripts/backup.sh --data-dir /srv/data --keep 7
#   sudo bash scripts/backup.sh --stop-service          # 一致性快照：停服→打包→拉起
#
# --stop-service 的取舍（R4.0）：data/ 全量 < 1MB、打包 < 1s，停服窗口 ≈ 10s，
# 换来包内跨文件一致。热备份里唯一可能撞上的不一致是「run 预留 vs user 余额」
# 这类两个原子写之间的窗口，restore-check.mjs 能对账发现；一致性快照连这也没有。
# 仅限 root + 有 systemctl 时用（要停起 genius.service）；trap 保证无论打包成败
# 都会把服务拉回来。
#
# 只打「丢了就重建不出来」的事实源：
#   users/      账号（含密码哈希）、users/index.json 派生缓存
#   invites/    一次性邀请码
#   gift-codes/ 礼品码（面额 + 认领状态；丢了等于凭空多出一批可兑换的钱）
#   ledger/     余额流水（余额模型上线后才有，不存在就跳过）
#   agent/      智能体会话（2026-09-07 起；每人一个目录，不存在就跳过）
#   canvases/   画布文档（2026-09-11 起；每人一个目录，不存在就跳过）
#   canvas-runs/ 画布运行记录（2026-09-12 起；含冻结图快照与逐节点执行位，不存在就跳过）
#   notifications/ 通知落盘（2026-09-12 H 包起；每用户一份，含已读游标，不存在就跳过）
#   prefs/      账号偏好（2026-09-15 起；智能体技能开关，每用户一份，不存在就跳过）
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
STOP_SERVICE=0
SERVICE_STOPPED=0

usage() {
  cat <<'USAGE'
用法: backup.sh [--data-dir DIR] [--backup-dir DIR] [--keep N] [--stop-service]
  --data-dir      数据目录，默认 $DATA_DIR 或 /opt/genius/data
  --backup-dir    备份落地目录，默认 $BACKUP_DIR 或 /opt/genius/backups
  --keep          保留最近 N 份，默认 $KEEP 或 14
  --stop-service  一致性快照：systemctl stop genius → 打包 → start → 等 health 200。
                  仅 root 且有 systemctl 时可用，否则退出码 2
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
    --stop-service) STOP_SERVICE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$STOP_SERVICE" = 1 ]; then
  # 退出码 2 = 用法/前提不满足，与 die（1 = 备份没产出）区分开。
  [ "$(id -u)" = "0" ] || { echo "backup fail: --stop-service 需要 root（要 systemctl 停起 genius.service）" >&2; exit 2; }
  command -v systemctl >/dev/null 2>&1 || { echo "backup fail: --stop-service 需要 systemctl，这台机器上没有" >&2; exit 2; }
fi

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
  # --stop-service 的兜底：无论打包成败，服务都得拉回来，这是这条模式的全部意义。
  if [ "$SERVICE_STOPPED" = 1 ]; then
    systemctl start genius || echo "backup fail: systemctl start genius 返回非 0，需人工拉起" >&2
  fi
  return 0
}
trap cleanup EXIT

LIST="$(mktemp "${TMPDIR:-/tmp}/genius-backup-list-XXXXXX")"
LISTING="$(mktemp "${TMPDIR:-/tmp}/genius-backup-verify-XXXXXX")"

# 一致性快照：先停服再扫描+打包。停服窗口里只做这两件 <1s 的事，
# 校验/改名/保留策略都在服务拉起来之后才跑（它们不碰 DATA_DIR）。
if [ "$STOP_SERVICE" = 1 ]; then
  echo "backup stop-service: systemctl stop genius（一致性快照，窗口 ≈10s）"
  systemctl stop genius || die "systemctl stop genius 失败，未产生快照"
  SERVICE_STOPPED=1
fi

# 白名单清单，NUL 分隔，路径相对 DATA_DIR。
(
  cd "$DATA_DIR"
  for d in users invites gift-codes ledger agent templates canvases canvas-runs notifications prefs assets; do
    if [ -d "$d" ]; then find "$d" -print0; fi
  done
  if [ -f relays.json ]; then printf '%s\0' relays.json; fi
  # jobs/<id>/job.json 且只有它：mindepth/maxdepth 2 天然挡掉 outputs/ inputs/ shots/。
  if [ -d jobs ]; then
    find jobs -mindepth 2 -maxdepth 2 -type f -name job.json -print0
  fi
) > "$LIST" || die "扫描 $DATA_DIR 失败"

[ -s "$LIST" ] || die "$DATA_DIR 里没有可备份的内容（users/ invites/ gift-codes/ ledger/ agent/ templates/ canvases/ canvas-runs/ notifications/ prefs/ assets/ relays.json jobs/*/job.json 全为空）"

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
    users|users/*|invites|invites/*|gift-codes|gift-codes/*|ledger|ledger/*|agent|agent/*|templates|templates/*|canvases|canvases/*|canvas-runs|canvas-runs/*|notifications|notifications/*|prefs|prefs/*|assets|assets/*|relays.json) ;;
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

if [ "$SERVICE_STOPPED" = 1 ]; then
  # 包已落盘，先把服务拉回来再核健康。wait 沿用 deploy.sh 的思路（轮询
  # /api/health 直到 200），上限 60 秒；拉不起来要算失败——宁可 cron 报警，
  # 不能让「备份成功但服务没回来」悄悄过去。
  systemctl start genius || die "systemctl start genius 返回非 0（包 $OUT 已生成，服务需人工拉起）"
  SERVICE_STOPPED=0
  health=""
  for i in $(seq 1 30); do
    health="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
      http://127.0.0.1:3000/api/health 2>/dev/null)" || health="000"
    if [ "$health" = "200" ]; then break; fi
    sleep 2
  done
  [ "$health" = "200" ] || die "服务已启动但 60s 内 health 未到 200（HTTP=$health，包 $OUT 已生成）"
  echo "backup stop-service: 服务已恢复，health 200"
fi

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

if [ "$STOP_SERVICE" = 1 ]; then
  echo "backup ok $OUT $(human_size "$SIZE_BYTES") kept=$kept 一致性快照"
else
  echo "backup ok $OUT $(human_size "$SIZE_BYTES") kept=$kept"
fi
if [ "$removed" -gt 0 ]; then
  echo "backup prune removed=$removed"
fi

# ---- 异地加密副本（R4.0，已决落阿里云 OSS）----
# 本地 .tgz 已经算成功；这里是附加步骤，失败只打 `backup offsite ...` 日志行，
# 脚本退出码不受影响——备份事故不能在「本地有包」和「异地没传成」之间混淆。
# 变量只从 /opt/genius/.env 里挑 BACKUP_*/OSS_* 两组，不整文件 source（那里面
# 还有 LUMEN_SESSION_SECRET 等无关项）。
GENIUS_ENV_FILE="/opt/genius/.env"
if [ -f "$GENIUS_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . <(grep -E '^(BACKUP_|OSS_)[A-Za-z0-9_]*=' "$GENIUS_ENV_FILE" || true)
  set +a
fi

if [ -z "${BACKUP_OSS_BUCKET:-}" ]; then
  # 未配 bucket 就不产生 .enc，本地备份照常算成功。
  exit 0
fi

OSS_PREFIX="${BACKUP_OSS_PREFIX:-genius/}"
OSS_OBJECT="oss://${BACKUP_OSS_BUCKET}/${OSS_PREFIX}$(basename "$OUT").enc"
ENC_OUT="$OUT.enc"

if ! command -v ossutil >/dev/null 2>&1; then
  echo "backup offsite warn: 已配 BACKUP_OSS_BUCKET 但 ossutil 不在 PATH，异地副本跳过（安装见 runbook「备份」节）" >&2
  exit 0
fi
if [ -z "${BACKUP_ENC_PASSPHRASE:-}" ]; then
  echo "backup offsite fail: BACKUP_OSS_BUCKET 已配但 BACKUP_ENC_PASSPHRASE 为空，未生成加密副本（本地包 $OUT 完好）" >&2
  exit 0
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "backup offsite fail: openssl 不在 PATH，无法加密（本地包 $OUT 完好）" >&2
  exit 0
fi

# openssl enc：AES-256-CBC + PBKDF2（20 万次迭代 + 随机 salt）。口令经
# `-pass env:` 传递，不进命令行参数（ps 看不见）。
if ! openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -pass env:BACKUP_ENC_PASSPHRASE -in "$OUT" -out "$ENC_OUT"; then
  echo "backup offsite fail: openssl 加密失败（本地包 $OUT 完好）" >&2
  rm -f "$ENC_OUT"
  exit 0
fi

# ossutil 2.x：凭证/地域走环境变量 OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET、
# OSS_REGION（或 OSS_ENDPOINT，2.x 起签名 V4 必须给 region）——官方文档：
# https://help.aliyun.com/zh/oss/developer-reference/ossutil-overview
if ossutil cp "$ENC_OUT" "$OSS_OBJECT" >/dev/null; then
  rm -f "$ENC_OUT"
  echo "backup offsite ok $OSS_OBJECT"
else
  # 上传失败时 .enc 留在原地：已加密、可手工重传；本地 .tgz 始终不删。
  echo "backup offsite fail: ossutil cp 到 $OSS_OBJECT 失败，加密副本留在 $ENC_OUT（本地包 $OUT 完好）" >&2
fi
