#!/usr/bin/env bash
# Genius 生产部署：本机（Windows / Git Bash）构建 → 阿里云 Linux 运行。
#
#   bash scripts/deploy.sh            # pnpm build 后部署
#   bash scripts/deploy.sh --no-build # 复用现有 .next
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

if [[ "${1:-}" != "--no-build" ]]; then
  echo "== 1/4 构建"
  pnpm build
fi

echo "== 2/4 打包（排除本地缓存）"
PKG="$(mktemp -t genius-deploy-XXXXXX)"
tar czf "$PKG" \
  --exclude=.next/cache --exclude=.next/dev --exclude=.next/types --exclude=.next/standalone \
  .next public package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts \
  scripts/mint-invites.mjs
ls -lh "$PKG" | awk '{print "   包大小:", $5}'

echo "== 3/4 上传"
"${SCP[@]}" "$PKG" "$HOST:$REMOTE_DIR/deploy.tgz"
rm -f "$PKG"

echo "== 4/4 服务器切换"
"${SSH[@]}" "$HOST" bash -s <<'REMOTE' 2>&1 | grep -v "post-quantum\|store now\|openssh.com/pq\|^\*\* "
set -euo pipefail
cd /opt/genius
systemctl stop genius
rm -rf .next.prev
[ -d .next ] && mv .next .next.prev
tar xzf deploy.tgz && rm deploy.tgz
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
systemctl start genius
sleep 8
echo "   服务: $(systemctl is-active genius)"
curl -sS --max-time 20 -o /dev/null -w "   health: HTTP=%{http_code}\n" http://127.0.0.1:3000/api/health
REMOTE

echo "== 完成。公网验证："
curl -sS --max-time 25 -o /dev/null -w "   https://genius.homeaistack.online -> HTTP=%{http_code}\n" https://genius.homeaistack.online/
