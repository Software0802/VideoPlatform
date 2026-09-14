#!/usr/bin/env bash
# Genius 生产部署：Windows / Git Bash 本地构建，阿里云按 release 目录原子切换。
#
#   bash scripts/deploy.sh                  # 门禁 → build → releases/<id> → current
#   bash scripts/deploy.sh --no-build       # 复用现有 .next（门禁仍跑）
#   bash scripts/deploy.sh --allow-dirty    # 脏工作树包以 -dirty 结尾
#   bash scripts/deploy.sh --list           # 只列远端 releases/current/PREVIOUS
#   bash scripts/deploy.sh --rollback [id]  # 不跑门禁与构建，切到 id 或 PREVIOUS
#
# 每个 release 自带整份发布包与 Linux node_modules，data 软链到 /opt/genius/data；
# /opt/genius/current 用临时软链 + mv -T 原子切换。health 失败只切回 PREVIOUS，
# 不改 .env、data、backups 或其它共享物。
#
# 两个跨平台坑仍由远端安装步骤处理：
#   - sharp / ffmpeg-static 是平台相关原生二进制，必须在服务器 pnpm install；
#   - Turbopack 把 serverExternalPackages 编成 `<pkg>-<hash>`，必须补 node_modules 别名。
# output:"standalone" 的 Windows 软链写死构建机路径，仍禁止用于 Windows→Linux 发布。
set -euo pipefail

HOST="root@8.209.212.178"
KEY="$HOME/.ssh/lumen_server"
REMOTE_DIR="/opt/genius"
REMOTE_SCRIPT="scripts/deploy-remote.sh"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes)
SCP=(scp -i "$KEY" -o IdentitiesOnly=yes)

cd "$(dirname "$0")/.."

usage() {
  sed -n '2,18p' "$0"
}

remote_action() {
  local action="$1" target="${2:-}" keep="${KEEP_RELEASES:-3}" status
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=3
  if [ -n "$target" ] && [[ ! "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "非法 release id: $target" >&2
    return 2
  fi
  set +e
  if [ -n "$target" ]; then
    "${SSH[@]}" "$HOST" "GENIUS_ROOT=$REMOTE_DIR KEEP_RELEASES=$keep bash -s -- $action $target" \
      < "$REMOTE_SCRIPT" 2>&1 | grep -v "post-quantum\|store now\|openssh.com/pq\|^\*\* "
  else
    "${SSH[@]}" "$HOST" "GENIUS_ROOT=$REMOTE_DIR KEEP_RELEASES=$keep bash -s -- $action" \
      < "$REMOTE_SCRIPT" 2>&1 | grep -v "post-quantum\|store now\|openssh.com/pq\|^\*\* "
  fi
  status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

case "${1:-}" in
  --list)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    remote_action list
    exit $?
    ;;
  --rollback)
    shift
    [ "$#" -le 1 ] || { usage >&2; exit 2; }
    remote_action rollback "${1:-}"
    exit $?
    ;;
  -h|--help)
    usage
    exit 0
    ;;
esac

BUILD=1
ALLOW_DIRTY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" = 1 ]; then
    echo "!! 工作树不干净（--allow-dirty 已放行），变更将进发布包但不对应任何 commit："
    git status --porcelain
    git diff --stat
  else
    echo "!! 工作树不干净，拒绝部署。先提交/暂存，或显式传 --allow-dirty：" >&2
    git status --porcelain >&2
    git diff --stat >&2
    exit 2
  fi
fi

echo "== 1/5 本地门禁（typecheck / eslint / vitest，不可跳过）"
pnpm exec next typegen
pnpm exec tsc --noEmit
pnpm exec eslint src e2e scripts
pnpm test

if [ "$BUILD" = 1 ]; then
  echo "== 2/5 构建"
  pnpm build
else
  echo "== 2/5 构建（已跳过，复用现有 .next）"
fi

echo "== 3/5 打包（排除本地缓存）"
node -e '
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const sha = execSync("git rev-parse HEAD").toString().trim();
fs.writeFileSync("BUILD_INFO.json", JSON.stringify({
  sha,
  shortSha: sha.slice(0, 7),
  builtAt: new Date().toISOString(),
  node: process.version,
  dirty: process.argv[1] === "1",
}, null, 2) + "\n");
' "$ALLOW_DIRTY"
cat BUILD_INFO.json
PKG="$(mktemp -t genius-deploy-XXXXXX)"
tar czf "$PKG" \
  --exclude=.next/cache --exclude=.next/dev --exclude=.next/types --exclude=.next/standalone \
  --exclude=.next/node_modules \
  .next public package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts BUILD_INFO.json \
  scripts/mint-invites.mjs scripts/backup.sh scripts/grant-balance.mjs scripts/mint-gift-codes.mjs \
  scripts/reset-password.mjs scripts/disable-user.mjs scripts/usage.mjs scripts/migrate-billing.mjs \
  scripts/lib scripts/migrate-canvas-assets.mjs scripts/alert-test.mjs scripts/restore-check.mjs data-seed \
  src/lib/assets/files.mjs src/lib/assets/migrate.mjs \
  src/lib/billing/protocol.mjs src/lib/billing/file-ledger.mjs
ls -lh "$PKG" | awk '{print "   包大小:", $5}'

echo "== 4/5 上传"
"${SCP[@]}" "$PKG" "$HOST:$REMOTE_DIR/deploy.tgz"
rm -f "$PKG"

echo "== 5/5 服务器 release 切换"
if remote_action deploy; then
  status=0
else
  status=$?
fi
if [ "$status" -ne 0 ]; then
  echo "!! 部署失败（远端退出码 $status）。未切链的失败不会停当前服务；health 失败已自动切回。" >&2
  exit "$status"
fi

echo "== 完成。公网验证："
PUBLIC="$(curl -sS --max-time 25 -o /dev/null -w '%{http_code}' https://genius.homeaistack.online/login)" || PUBLIC=000
echo "   https://genius.homeaistack.online/login -> HTTP=$PUBLIC"
if [ "$PUBLIC" != 200 ]; then
  echo "   （非 200：服务器本机 health 是绿的，先查 Caddy 站点块与 DNS）"
fi
