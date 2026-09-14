#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]] && [ "${SELFTEST_MSYS_LINKS:-0}" != 1 ]; then
  SELFTEST_MSYS_LINKS=1 MSYS=winsymlinks:sys exec "$BASH" "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d -t genius-layout-selftest-XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT

export GENIUS_ROOT="$ROOT"
export SKIP_SYSTEMD=1
export SKIP_INSTALL=1
export DEPLOY_REMOTE_SOURCE_ONLY=1
export KEEP_RELEASES=3
# shellcheck source=deploy-remote.sh
source "$SCRIPT_DIR/deploy-remote.sh"

assert_eq() {
  local actual="$1" expected="$2" message="$3"
  if [ "$actual" != "$expected" ]; then
    echo "SELFTEST FAIL: $message (actual=$actual expected=$expected)" >&2
    exit 1
  fi
}

make_legacy_layout() {
  mkdir -p "$ROOT/.next" "$ROOT/.next.prev" "$ROOT/.next.old" "$ROOT/node_modules/next/dist/bin" \
    "$ROOT/public" "$ROOT/scripts" "$ROOT/src" "$ROOT/data-seed/templates" "$ROOT/data" \
    "$ROOT/backups" "$ROOT/app" "$ROOT/.systemd/genius.service.d"
  printf '{"shortSha":"old1234"}\n' > "$ROOT/BUILD_INFO.json"
  printf 'legacy template\n' > "$ROOT/data-seed/templates/legacy.txt"
  printf '#!/usr/bin/env bash\n' > "$ROOT/scripts/backup.sh"
  : > "$ROOT/package.json"
  : > "$ROOT/pnpm-lock.yaml"
  : > "$ROOT/pnpm-workspace.yaml"
  : > "$ROOT/next.config.ts"
  : > "$ROOT/.env"
  : > "$ROOT/app/keep"
  : > "$ROOT/ "
  printf '[Service]\nWorkingDirectory=%s\n' "$ROOT" > "$ROOT/.systemd/genius.service"
  printf '[Service]\nUser=genius\n' > "$ROOT/.systemd/genius.service.d/user.conf"
}

make_archive() {
  local short="$1" built="$2" marker="$3" stage
  stage="$(mktemp -d -t genius-release-stage-XXXXXX)"
  mkdir -p "$stage/.next/server/chunks" "$stage/public" "$stage/scripts/lib" \
    "$stage/data-seed/templates" "$stage/src/lib/assets" "$stage/src/lib/billing"
  printf '{"shortSha":"%s","builtAt":"%s","dirty":false}\n' "$short" "$built" > "$stage/BUILD_INFO.json"
  printf '%s\n' "$marker" > "$stage/data-seed/templates/$marker.txt"
  printf '#!/usr/bin/env bash\n' > "$stage/scripts/backup.sh"
  : > "$stage/package.json"
  : > "$stage/pnpm-lock.yaml"
  : > "$stage/pnpm-workspace.yaml"
  : > "$stage/next.config.ts"
  : > "$stage/src/lib/assets/files.mjs"
  : > "$stage/src/lib/assets/migrate.mjs"
  : > "$stage/src/lib/billing/protocol.mjs"
  : > "$stage/src/lib/billing/file-ledger.mjs"
  (
    cd "$stage"
    tar czf "$DEPLOY_ARCHIVE" .next public package.json pnpm-lock.yaml pnpm-workspace.yaml \
      next.config.ts BUILD_INFO.json scripts data-seed src
  )
  rm -rf "$stage"
}

make_legacy_layout
echo "== SELFTEST migrate legacy"
migrate_legacy
assert_eq "$(current_id)" "legacy-old1234" "legacy current"
[ -d "$ROOT/releases/legacy-old1234/.next" ]
[ -L "$ROOT/releases/legacy-old1234/data" ]
[ -d "$ROOT/releases/legacy-old1234/data-seed" ]
[ -d "$ROOT/data-seed" ]
[ -L "$ROOT/scripts" ]
[ -L "$ROOT/BUILD_INFO.json" ]
[ -f "$ROOT/.env" ]
[ -f "$ROOT/ " ]
[ -f "$ROOT/.systemd/genius.service.d/user.conf" ]
[ -f "$ROOT/.systemd/genius.service.d/release.conf" ]

make_archive abc1234 2026-09-14T01:02:03.000Z release-one
echo "== SELFTEST deploy release one"
deploy_release
assert_eq "$(current_id)" "abc1234-20260914-010203" "first current"
assert_eq "$(previous_id)" "legacy-old1234" "first previous"
[ -L "$ROOT/releases/abc1234-20260914-010203/data" ]
[ -f "$ROOT/data/templates/release-one.txt" ]

make_archive def5678 2026-09-14T02:03:04.000Z release-two
echo "== SELFTEST deploy release two"
deploy_release
assert_eq "$(current_id)" "def5678-20260914-020304" "second current"
assert_eq "$(previous_id)" "abc1234-20260914-010203" "second previous"

echo "== SELFTEST rollback"
rollback_release abc1234-20260914-010203
assert_eq "$(current_id)" "abc1234-20260914-010203" "rollback current"
assert_eq "$(previous_id)" "def5678-20260914-020304" "rollback previous"

mkdir -p "$RELEASES_DIR/extra-old" "$RELEASES_DIR/old.failed" "$RELEASES_DIR/new.failed"
touch -d '2020-01-01 00:00:00' "$RELEASES_DIR/extra-old" "$RELEASES_DIR/old.failed"
touch -d '2021-01-01 00:00:00' "$RELEASES_DIR/new.failed"
KEEP_RELEASES=2
echo "== SELFTEST prune"
prune_releases
[ ! -d "$RELEASES_DIR/legacy-old1234" ]
[ ! -d "$RELEASES_DIR/extra-old" ]
[ ! -d "$RELEASES_DIR/old.failed" ]
[ -d "$RELEASES_DIR/new.failed" ]
assert_eq "$(current_id)" "abc1234-20260914-010203" "pruned current"
assert_eq "$(previous_id)" "def5678-20260914-020304" "pruned previous"

echo "== SELFTEST final tree"
find "$ROOT" -maxdepth 4 -printf '%P -> %l\n' | sort
echo "SELFTEST OK"
