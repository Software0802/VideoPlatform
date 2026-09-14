#!/usr/bin/env bash
set -euo pipefail

GENIUS_ROOT="${GENIUS_ROOT:-/opt/genius}"
RELEASES_DIR="$GENIUS_ROOT/releases"
DEPLOY_ARCHIVE="$GENIUS_ROOT/deploy.tgz"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
HEALTH_TRIES="${HEALTH_TRIES:-10}"
HEALTH_GAP="${HEALTH_GAP:-6}"
HEALTH_FILE="${TMPDIR:-/tmp}/genius-health.json"
SKIP_SYSTEMD="${SKIP_SYSTEMD:-0}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

current_id() {
  [ -L "$GENIUS_ROOT/current" ] || return 0
  basename "$(readlink "$GENIUS_ROOT/current")"
}

previous_id() {
  if [ -f "$RELEASES_DIR/PREVIOUS" ]; then
    tr -d '\r\n' < "$RELEASES_DIR/PREVIOUS"
  fi
}

valid_release_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

write_previous() {
  local id="$1" tmp="$RELEASES_DIR/.PREVIOUS.$$"
  printf '%s\n' "$id" > "$tmp"
  mv -Tf "$tmp" "$RELEASES_DIR/PREVIOUS"
}

restore_previous() {
  local id="$1"
  if [ -n "$id" ] && [ -d "$RELEASES_DIR/$id" ]; then
    write_previous "$id"
  else
    rm -f "$RELEASES_DIR/PREVIOUS"
  fi
}

switch_release() {
  local target="$1" record_previous="${2:-1}" old tmp
  valid_release_id "$target" || { echo "   !! 非法 release id: $target" >&2; return 2; }
  [ -d "$RELEASES_DIR/$target" ] || { echo "   !! release 不存在: $target" >&2; return 2; }
  old="$(current_id)"
  if [ "$record_previous" = 1 ] && [ -n "$old" ] && [ "$old" != "$target" ]; then
    write_previous "$old"
  fi
  tmp="$GENIUS_ROOT/.current.$$"
  rm -f "$tmp"
  ln -s "releases/$target" "$tmp"
  mv -Tf "$tmp" "$GENIUS_ROOT/current"
  echo "   current -> releases/$target"
}

service_stop() {
  [ "$SKIP_SYSTEMD" = 1 ] || systemctl stop genius
}

service_start() {
  [ "$SKIP_SYSTEMD" = 1 ] || systemctl start genius
}

service_restart() {
  [ "$SKIP_SYSTEMD" = 1 ] || systemctl restart genius
}

service_active() {
  if [ "$SKIP_SYSTEMD" = 1 ]; then echo active; else systemctl is-active genius; fi
}

daemon_reload() {
  [ "$SKIP_SYSTEMD" = 1 ] || systemctl daemon-reload
}

systemd_unit() {
  if [ "$SKIP_SYSTEMD" = 1 ]; then
    echo "$GENIUS_ROOT/.systemd/genius.service"
  else
    echo /etc/systemd/system/genius.service
  fi
}

systemd_dropins() {
  if [ "$SKIP_SYSTEMD" = 1 ]; then
    echo "$GENIUS_ROOT/.systemd/genius.service.d"
  else
    echo /etc/systemd/system/genius.service.d
  fi
}

check_health() {
  local code
  if [ "$SKIP_SYSTEMD" = 1 ]; then
    printf '{"ok":true}\n' > "$HEALTH_FILE"
    echo 200
    return
  fi
  code="$(curl -sS --max-time 20 -o "$HEALTH_FILE" -w '%{http_code}' \
    http://127.0.0.1:3000/api/health)" || code=000
  echo "$code"
}

health_ok() {
  [ "$1" = 200 ] && grep -q '"ok":[[:space:]]*true' "$HEALTH_FILE"
}

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

backup_systemd() {
  local stamp backup unit dropins
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="$GENIUS_ROOT/backups/systemd-$stamp"
  unit="$(systemd_unit)"
  dropins="$(systemd_dropins)"
  mkdir -p "$backup"
  [ -e "$unit" ] && cp -a "$unit" "$backup/"
  [ -d "$dropins" ] && cp -a "$dropins" "$backup/"
  echo "   systemd 备份: $backup"
}

write_release_dropin() {
  local dropins
  dropins="$(systemd_dropins)"
  mkdir -p "$dropins"
  cat > "$dropins/release.conf" <<EOF
[Service]
WorkingDirectory=$GENIUS_ROOT/current
ExecStart=
ExecStart=/usr/bin/node $GENIUS_ROOT/current/node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0
EOF
  daemon_reload
}

ensure_root_links() {
  local name target
  for name in scripts BUILD_INFO.json; do
    target="current/$name"
    if [ -e "$GENIUS_ROOT/$name" ] && [ ! -L "$GENIUS_ROOT/$name" ]; then
      echo "   !! 顶层 $name 仍是实体，拒绝覆盖" >&2
      return 1
    fi
    ln -sfn "$target" "$GENIUS_ROOT/$name"
  done
}

migrate_legacy() {
  [ ! -L "$GENIUS_ROOT/current" ] || return 0
  local short id release entry source dest code
  echo "== 首次迁移旧布局"
  service_stop
  mkdir -p "$RELEASES_DIR" "$GENIUS_ROOT/backups"
  short=unknown
  if [ -f "$GENIUS_ROOT/BUILD_INFO.json" ]; then
    short="$(node -e 'try{const d=require(process.argv[1]);process.stdout.write(String(d.shortSha||"unknown"))}catch{}' "$GENIUS_ROOT/BUILD_INFO.json")"
  fi
  short="$(printf '%s' "$short" | tr -cd 'A-Za-z0-9._-')"
  [ -n "$short" ] || short=unknown
  id="legacy-$short"
  release="$RELEASES_DIR/$id"
  mkdir -p "$release"
  backup_systemd
  for entry in .next .next.prev .next.old node_modules package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts BUILD_INFO.json public scripts src; do
    source="$GENIUS_ROOT/$entry"
    dest="$release/$entry"
    [ -e "$source" ] || [ -L "$source" ] || continue
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      echo "   !! 迁移目标已存在，拒绝覆盖: $dest" >&2
      return 1
    fi
    mv "$source" "$dest"
    echo "   迁移: $entry"
  done
  if [ -d "$GENIUS_ROOT/data-seed" ] && [ ! -e "$release/data-seed" ]; then
    cp -a "$GENIUS_ROOT/data-seed" "$release/data-seed"
    echo "   复制: data-seed（顶层保留）"
  fi
  ln -sfn "$GENIUS_ROOT/data" "$release/data"
  switch_release "$id" 0
  ensure_root_links
  write_release_dropin
  if id genius &>/dev/null; then
    chown -R genius:genius "$release"
    chown -h genius:genius "$GENIUS_ROOT/current" "$GENIUS_ROOT/scripts" "$GENIUS_ROOT/BUILD_INFO.json"
  fi
  service_start
  [ "$SKIP_SYSTEMD" = 1 ] || sleep 8
  if code="$(wait_healthy)"; then
    echo "   legacy 服务: $(service_active) health=HTTP=$code"
  else
    echo "   !! 首次迁移后 health 失败（HTTP=$code），停止发布" >&2
    return 1
  fi
}

release_id_from_archive() {
  local info id
  info="$(mktemp)"
  tar -xOf "$DEPLOY_ARCHIVE" BUILD_INFO.json > "$info"
  id="$(node -e '
const fs=require("fs"),d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const m=String(d.builtAt||"").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
if(!m||!d.shortSha)process.exit(2);
process.stdout.write(`${d.shortSha}-${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}${d.dirty?"-dirty":""}`);
' "$info")"
  rm -f "$info"
  valid_release_id "$id" || return 2
  printf '%s\n' "$id"
}

install_release() {
  local release="$1"
  if [ "$SKIP_INSTALL" = 1 ]; then
    mkdir -p "$release/node_modules/next/dist/bin"
    : > "$release/node_modules/next/dist/bin/next"
    return 0
  fi
  (
    set -e
    cd "$release"
    pnpm install --prod --frozen-lockfile
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
  )
}

mark_failed() {
  local id="$1" release="$RELEASES_DIR/$id" failed="$RELEASES_DIR/$id.failed"
  [ -e "$release" ] || return 0
  rm -rf "$failed"
  mv "$release" "$failed"
  echo "   失败版保留: $(basename "$failed")"
}

prepare_release() {
  local id="$1" release="$RELEASES_DIR/$id"
  if [ -e "$release" ] || [ -e "$release.failed" ]; then
    echo "   !! release 已存在: $id" >&2
    return 2
  fi
  mkdir -p "$release"
  if ! tar xzf "$DEPLOY_ARCHIVE" -C "$release"; then
    rm -f "$DEPLOY_ARCHIVE"
    mark_failed "$id"
    return 1
  fi
  rm -f "$DEPLOY_ARCHIVE"
  rm -rf "$release/.next/node_modules"
  ln -s "$GENIUS_ROOT/data" "$release/data"
  chmod +x "$release"/scripts/*.sh 2>/dev/null || true
  sed -i 's/\r$//' "$release"/scripts/*.sh 2>/dev/null || true
  if ! install_release "$release"; then
    mark_failed "$id"
    return 1
  fi
  id genius &>/dev/null && chown -R genius:genius "$release" || true
}

seed_templates() {
  if [ ! -d "$GENIUS_ROOT/data/templates" ] && [ -d "$GENIUS_ROOT/current/data-seed/templates" ]; then
    mkdir -p "$GENIUS_ROOT/data"
    cp -r "$GENIUS_ROOT/current/data-seed/templates" "$GENIUS_ROOT/data/templates"
    id genius &>/dev/null && chown -R genius:genius "$GENIUS_ROOT/data/templates" || true
    echo "   模板: 已从 current/data-seed 落种 $(find "$GENIUS_ROOT/data/templates" -mindepth 1 -maxdepth 1 | wc -l) 条"
  fi
}

prune_releases() {
  [[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] || KEEP_RELEASES=3
  [ "$KEEP_RELEASES" -gt 0 ] || KEEP_RELEASES=3
  local current previous count=0 id
  current="$(current_id)"
  previous="$(previous_id)"
  declare -A keep=()
  if [ -n "$current" ] && [ -d "$RELEASES_DIR/$current" ]; then keep["$current"]=1; count=$((count+1)); fi
  if [ -n "$previous" ] && [ -d "$RELEASES_DIR/$previous" ] && [ -z "${keep[$previous]:-}" ]; then
    keep["$previous"]=1
    count=$((count+1))
  fi
  while read -r id; do
    [ -n "$id" ] || continue
    [ -n "${keep[$id]:-}" ] && continue
    if [ "$count" -lt "$KEEP_RELEASES" ]; then
      keep["$id"]=1
      count=$((count+1))
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '*.failed' -printf '%T@ %f\n' | sort -nr | awk '{print $2}')
  while read -r id; do
    [ -n "$id" ] || continue
    if [ -z "${keep[$id]:-}" ]; then
      rm -rf "$RELEASES_DIR/$id"
      echo "   修剪 release: $id"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '*.failed' -printf '%f\n')

  local kept_failed=0
  while read -r id; do
    [ -n "$id" ] || continue
    if [ "$kept_failed" -eq 0 ]; then
      kept_failed=1
    else
      rm -rf "$RELEASES_DIR/$id"
      echo "   修剪 failed: $id"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '*.failed' -printf '%T@ %f\n' | sort -nr | awk '{print $2}')
}

deploy_release() {
  migrate_legacy
  local id previous older code back
  id="$(release_id_from_archive)"
  previous="$(current_id)"
  older="$(previous_id)"
  echo "== 准备 release: $id"
  prepare_release "$id" || return $?
  switch_release "$id"
  ensure_root_links
  seed_templates
  service_restart
  [ "$SKIP_SYSTEMD" = 1 ] || sleep 8
  echo "   服务: $(service_active)"
  if code="$(wait_healthy)"; then
    echo "   health: HTTP=$code ok=true"
    prune_releases
    return 0
  fi

  echo "   health 失败（HTTP=$code body=$(head -c 300 "$HEALTH_FILE" 2>/dev/null)），切回 $previous"
  switch_release "$previous" 0
  restore_previous "$older"
  service_restart
  [ "$SKIP_SYSTEMD" = 1 ] || sleep 8
  back="$(wait_healthy)" || true
  echo "   回滚后: 服务=$(service_active) health=HTTP=$back"
  mark_failed "$id"
  return 1
}

rollback_release() {
  local target="${1:-}" old code back
  [ -L "$GENIUS_ROOT/current" ] || { echo "!! 尚未迁移为 release 布局" >&2; list_releases; return 2; }
  [ -n "$target" ] || target="$(previous_id)"
  if [ -z "$target" ] || ! valid_release_id "$target" || [ ! -d "$RELEASES_DIR/$target" ]; then
    echo "!! 回滚目标不存在: ${target:-<empty>}" >&2
    list_releases
    return 2
  fi
  old="$(current_id)"
  [ "$target" != "$old" ] || { echo "   current 已是 $target"; return 0; }
  switch_release "$target"
  service_restart
  [ "$SKIP_SYSTEMD" = 1 ] || sleep 8
  if code="$(wait_healthy)"; then
    echo "   回滚成功: current=$target health=HTTP=$code"
    prune_releases
    return 0
  fi
  echo "   !! 回滚目标 health 失败（HTTP=$code），切回 $old" >&2
  switch_release "$old" 0
  write_previous "$target"
  service_restart
  [ "$SKIP_SYSTEMD" = 1 ] || sleep 8
  back="$(wait_healthy)" || true
  echo "   恢复后: current=$old health=HTTP=$back" >&2
  return 1
}

list_releases() {
  mkdir -p "$RELEASES_DIR"
  echo "current=$(current_id)"
  echo "PREVIOUS=$(previous_id)"
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%TY-%Tm-%Td %TH:%TM:%TS %f\n' | sort -r
}

main() {
  mkdir -p "$GENIUS_ROOT"
  case "${1:-deploy}" in
    deploy) deploy_release ;;
    rollback) rollback_release "${2:-}" ;;
    list) list_releases ;;
    *) echo "未知远端动作: $1" >&2; return 2 ;;
  esac
}

if [ "${DEPLOY_REMOTE_SOURCE_ONLY:-0}" != 1 ]; then
  main "$@"
fi
