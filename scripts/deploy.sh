#!/usr/bin/env bash
# Genius 生产部署：本机（Windows / Git Bash）构建 → 阿里云 Linux 运行。
#
#   bash scripts/deploy.sh              # tsc 门禁 → pnpm build → 部署
#   bash scripts/deploy.sh --no-build   # 复用现有 .next
#   bash scripts/deploy.sh --skip-check # 跳过本地 tsc 门禁（赶时间时用，慎）
#
# 失败即回滚：服务器起来后 /api/health 不是 200 + ok:true 就把 .next.prev 换回去、
# 重启、再验一次，然后整个脚本非零退出（G4，见 docs/plan-architecture-2026-09.md §3.2）。
#
# 步骤与两个坑的来龙去脉见 docs/handoff.md §0.4。要点：
#   - sharp / ffmpeg-static 是平台相关的原生二进制，必须在服务器 pnpm install，不能传 Windows 的；
#   - Turbopack 把 serverExternalPackages 编成 `<pkg>-<hash>` 别名，部署机解析不到，
#     不补软链服务 500 起不来（下面的 node 片段就是补这一步）；
#   - output:"standalone" 在 Windows→Linux 行不通（符号链接写死构建机路径），别再试。
# 本脚本不碰服务器上的 .env 与 data/。
set -euo pipefail

HOST="root@8.209.212.178"
KEY="$HOME/.ssh/lumen_server"
REMOTE_DIR="/opt/genius"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes)
SCP=(scp -i "$KEY" -o IdentitiesOnly=yes)

cd "$(dirname "$0")/.."

BUILD=1
CHECK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --skip-check) CHECK=0; shift ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0 ;;
    *) echo "未知参数: $1（支持 --no-build / --skip-check）" >&2; exit 2 ;;
  esac
done

if [ "$CHECK" = 1 ]; then
  echo "== 1/5 类型检查（--skip-check 可跳过）"
  # 几十秒换掉「构建能过但类型错了照样上线」的一整类事故。tsc 非零时 set -e 直接中止，
  # 坏代码走不到打包这一步。
  pnpm exec tsc --noEmit
else
  echo "== 1/5 类型检查（已跳过）"
fi

if [ "$BUILD" = 1 ]; then
  echo "== 2/5 构建"
  pnpm build
else
  echo "== 2/5 构建（已跳过，复用现有 .next）"
fi

echo "== 3/5 打包（排除本地缓存）"
PKG="$(mktemp -t genius-deploy-XXXXXX)"
tar czf "$PKG" \
  --exclude=.next/cache --exclude=.next/dev --exclude=.next/types --exclude=.next/standalone \
  .next public package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts \
  scripts/mint-invites.mjs scripts/backup.sh scripts/grant-balance.mjs scripts/mint-gift-codes.mjs \
  scripts/reset-password.mjs scripts/disable-user.mjs scripts/usage.mjs scripts/migrate-billing.mjs \
  scripts/lib data-seed src/lib/billing/protocol.mjs src/lib/billing/file-ledger.mjs
ls -lh "$PKG" | awk '{print "   包大小:", $5}'

echo "== 4/5 上传"
"${SCP[@]}" "$PKG" "$HOST:$REMOTE_DIR/deploy.tgz"
rm -f "$PKG"

echo "== 5/5 服务器切换"
# 远端输出经 grep -v 滤掉 OpenSSH 的 post-quantum 提示。管道会把 ssh 的退出码换成
# grep 的（而且 grep 滤空一切时退出 1），所以这里关掉 errexit，直接读 PIPESTATUS[0]，
# 以 ssh 自己的退出码为准——远端回滚时的非零退出必须能传到本地。
set +e
"${SSH[@]}" "$HOST" bash -s <<'REMOTE' 2>&1 | grep -v "post-quantum\|store now\|openssh.com/pq\|^\*\* "
set -euo pipefail
cd /opt/genius

# 健康 = HTTP 200 且 body 里 ok:true。/api/health 在 ffmpeg 缺失或 data 不可写时
# 回 503 + ok:false，两个条件都要看。连不上时 code 记 000。
check_health() {
  local code
  code="$(curl -sS --max-time 20 -o /tmp/genius-health.json -w '%{http_code}' \
    http://127.0.0.1:3000/api/health)" || code="000"
  echo "$code"
}
health_ok() {
  [ "$1" = "200" ] && grep -q '"ok":[[:space:]]*true' /tmp/genius-health.json
}
# 2 核机上 Next 冷启动可能超过 8 秒，一次不通就回滚会把好构建也滚掉。
# 所以给 HEALTH_TRIES × HEALTH_GAP 秒的窗口，连不上时 curl 立刻返回，实际不会等满。
HEALTH_TRIES="${HEALTH_TRIES:-10}"
HEALTH_GAP="${HEALTH_GAP:-6}"
wait_healthy() {
  local i code=000
  for i in $(seq 1 "$HEALTH_TRIES"); do
    code="$(check_health)"
    if health_ok "$code"; then
      echo "$code"
      return 0
    fi
    echo "   等待就绪 $i/$HEALTH_TRIES（HTTP=$code）" >&2
    sleep "$HEALTH_GAP"
  done
  echo "$code"
  return 1
}

systemctl stop genius
rm -rf .next.prev
# 注意不能写成 `[ -d .next ] && mv ...`：首次部署没有 .next 时该 and-list 整体非零，
# set -e 会让脚本在这里静默退出。
if [ -d .next ]; then
  mv .next .next.prev
fi
tar xzf deploy.tgz && rm deploy.tgz
# cron 直接执行 /opt/genius/scripts/backup.sh，需要可执行位。
chmod +x scripts/*.sh 2>/dev/null || true
echo "   依赖: $(pnpm install --prod --no-frozen-lockfile 2>&1 | tail -1)"
# 补 Turbopack external 别名（部署固定一步，详见 handoff §0.4 坑一）
node -e '
const fs=require("fs"),path=require("path");
const dir=".next/server/chunks", nm="node_modules", names=new Set();
for(const f of fs.readdirSync(dir)){
  if(!f.endsWith(".js"))continue;
  const s=fs.readFileSync(path.join(dir,f),"utf8");
  for(const m of s.matchAll(/["\x27]([a-z0-9@\/._-]+)-([0-9a-f]{16})["\x27]/gi)) names.add(m[1]+"-"+m[2]);
}
for(const alias of names){
  const real=alias.replace(/-[0-9a-f]{16}$/,""), target=path.join(nm,real);
  if(!fs.existsSync(target)){ console.log("   跳过(无真实包):",real); continue; }
  const link=path.join(nm,alias);
  try{fs.rmSync(link,{recursive:true,force:true});}catch{}
  fs.symlinkSync(fs.realpathSync(target),link,"dir");
  console.log("   别名:",alias,"->",real);
}'
# 模板种子：data/ 不入库，首次部署把示例模板落到 data/templates（已存在则不覆盖）
if [ ! -d data/templates ] && [ -d data-seed/templates ]; then
  mkdir -p data && cp -r data-seed/templates data/templates && echo "   模板: 已从 data-seed 落种 $(ls data/templates | wc -l) 条"
fi
systemctl start genius
sleep 8
echo "   服务: $(systemctl is-active genius)"
if CODE="$(wait_healthy)"; then
  echo "   health: HTTP=$CODE ok=true"
  exit 0
fi

echo "   health 失败（HTTP=$CODE body=$(head -c 300 /tmp/genius-health.json 2>/dev/null)），回滚"
systemctl stop genius
if [ -d .next.prev ]; then
  rm -rf .next
  mv .next.prev .next
  echo "   已把 .next.prev 换回 .next"
else
  echo "   !! 没有 .next.prev 可回滚（首次部署？），仍以当前构建重启"
fi
systemctl start genius
sleep 8
BACK="$(wait_healthy)" || true
echo "   回滚后: 服务=$(systemctl is-active genius) health=HTTP=$BACK"
# 非零退出，本地据此判定这次部署失败。
exit 1
REMOTE
REMOTE_STATUS=${PIPESTATUS[0]}
set -e

if [ "$REMOTE_STATUS" -ne 0 ]; then
  echo "!! 部署失败（远端退出码 $REMOTE_STATUS）。若上面打了「回滚」，服务器已换回上一版 .next；"
  echo "   否则登服务器看 journalctl -u genius -n 100。"
  exit "$REMOTE_STATUS"
fi

echo "== 完成。公网验证："
# 公网这一跳过 Caddy / DNS，失败不代表这次部署坏（远端 health 已经绿），只提示不中止。
PUBLIC="$(curl -sS --max-time 25 -o /dev/null -w '%{http_code}' https://genius.homeaistack.online/)" || PUBLIC="000"
echo "   https://genius.homeaistack.online -> HTTP=$PUBLIC"
if [ "$PUBLIC" != "200" ]; then
  echo "   （非 200：服务器本机 health 是绿的，先查 Caddy 站点块与 DNS）"
fi
