# 数据备份与恢复（Genius 生产）

配套脚本 `scripts/backup.sh`。方案背景见 `docs/plan-architecture-2026-09.md` §3.2「数据安全」：
本机每日备份防**误删与坏写**，阿里云 ECS 自动快照防**磁盘 / 实例丢失**，两层缺一不可。

## 包里有什么

| 路径 | 说明 |
| --- | --- |
| `users/` | 账号事实源（含 scrypt 密码哈希）与 `index.json` 派生缓存 |
| `invites/` | 一次性邀请码 |
| `ledger/` | 余额流水（余额模型上线后才有；不存在就跳过） |
| `jobs/<id>/job.json` | 任务记录本身 |

**不在包里**：`jobs/<id>/outputs|inputs|shots`（成片与上传素材）、`idempotency/`、`tmp/`。
成片体积是记录的几百倍，且 `DATA_RETENTION_DAYS`(30) 到期本来就会删；这份备份保的是
「账号与账目不丢」。成片要整盘找回，靠阿里云自动快照。

> 恢复后的直接后果：老任务的记录在、产物不在。前端仍会按 `job.json` 显示这些作品，
> 点开取 `/api/media` 会 404（不是「已过期清理」的占位卡，因为 `artifactsPurgedAt` 没写）。
> 介意的话，恢复后可以给这批 job.json 补 `artifactsPurgedAt`，让 UI 走占位卡分支。

包权限 600，里面有密码哈希与未使用的邀请码，不要随手 `scp` 到公共位置。

## 日常：装到服务器上

```bash
# 1. 脚本随 scripts/deploy.sh 一起上传到 /opt/genius/scripts/backup.sh（部署时会自动 chmod +x）
ls -l /opt/genius/scripts/backup.sh
chmod +x /opt/genius/scripts/backup.sh   # 若不是 -rwx 再补一次

# 2. 备份目录，只有 root 能进
mkdir -p /opt/genius/backups && chmod 700 /opt/genius/backups

# 3. 先手跑一次，确认输出是 backup ok
/opt/genius/scripts/backup.sh

# 4. 挂 cron（root 的 crontab）：每天 03:17，日志追加到 backups/backup.log
crontab -e
```

crontab 行：

```
17 3 * * * /opt/genius/scripts/backup.sh >> /opt/genius/backups/backup.log 2>&1
```

选 03:17 而不是 03:00：错开整点，别和别的定时任务、以及同机 taiyu 的活撞在一起。
脚本失败会非零退出并在日志里留 `backup fail: ...`，可以配合 `grep -c "backup fail" backup.log` 巡检。

默认路径与保留份数可用环境变量或参数覆盖：

```bash
DATA_DIR=/opt/genius/data BACKUP_DIR=/opt/genius/backups KEEP=14 /opt/genius/scripts/backup.sh
/opt/genius/scripts/backup.sh --data-dir /opt/genius/data --backup-dir /mnt/bak --keep 30
```

## 恢复到一个空的 DATA_DIR

前提：手上有一份 `genius-data-YYYYmmdd-HHMMSS.tgz`，要把它恢复成 `/opt/genius/data`。

```bash
# 0. 先看包里是什么，确认是要的那份（应当只有 users/ invites/ ledger/ jobs/*/job.json）
tar -tzf /opt/genius/backups/genius-data-20260906-031700.tgz | head -30

# 1. 停服务。恢复期间绝不能让 runner 在写 data/
systemctl stop genius
systemctl is-active genius   # 期望 inactive

# 2. 把现有 data/ 挪开而不是删掉——万一恢复的是错的那份，还能换回来
mv /opt/genius/data /opt/genius/data.broken.$(date +%Y%m%d-%H%M%S)
mkdir -p /opt/genius/data

# 3. 解包
tar -xzf /opt/genius/backups/genius-data-20260906-031700.tgz -C /opt/genius/data

# 4. 属主与权限。服务以哪个用户跑用这条查：systemctl show genius -p User
chown -R root:root /opt/genius/data
chmod 700 /opt/genius/data

# 5. 起服务
systemctl start genius
sleep 8
systemctl is-active genius

# 6. 验证：health 必须 ok:true 且 dataDirWritable:true
curl -sS http://127.0.0.1:3000/api/health

# 7. 验证账号确实回来了（users/index.json 是派生缓存，启动时会按目录重建，
#    所以只要 users/<id>/user.json 在，登录就该好使）
ls /opt/genius/data/users | head
```

登录一个已知账号、打开首页看得到历史任务列表，才算恢复成功。确认无误后再删
`data.broken.*`；空间紧张时优先删它，别删 `backups/`。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `backup fail: DATA_DIR 不存在` | cron 里没有 `.env` 的环境变量，默认路径又不对。用 `--data-dir` 写死绝对路径 |
| `backup fail: ... 没有可备份的内容` | `DATA_DIR` 指错了（指到了空目录），检查路径 |
| `backup warn: 打包过程中有文件被改写` | 服务正在写 job.json，属正常。job.json 是原子 rename 写入的，包里拿到的是完整的旧版或新版，不会是半截 |
| `backup fail: 包内出现不该有的条目` | 白名单校验拦下了异常内容，`.tmp` 已丢弃，没有产出坏包。把条目名贴出来排查 |
| 恢复后登录提示密码错 | 恢复的包与当前 `LUMEN_SESSION_SECRET` 无关（密码是 scrypt 存在 user.json 里），先确认恢复的是不是同一环境的包 |
| 恢复后老作品打不开 | 预期行为，见上文「恢复后的直接后果」——产物不在这份备份里 |

## 已知限制：充值 CLI 与线上服务没有跨进程锁

`scripts/grant-balance.mjs` 是独立进程，拿不到服务端的 `withUserLock`（那把锁只在服务
进程内串行）。两边改余额都是「读 `user.json` → 改 `balanceCny` → 临时文件 + rename
原子替换」，所以**充值的同一瞬间若恰好有同一用户的扣款（任务成功结算）或改密，后写的
那次会覆盖整份记录，丢一次写**：余额少扣 / 少充，或者刚改的密码被回退。单次写本身是
原子的，不会写出半截 JSON；丢的是另一次写。

`data/ledger/<userId>.jsonl` 是只增追加，两次写都会留下行，所以流水不会丢——对账时它
是可信的那一份。

操作纪律：

- 充值挑没人用的时候跑（内测规模下看一眼在线情况就够）；
- **充值前后各核对一次**：`user.json` 的 `balanceCny` 是否等于 ledger 最后一行的
  `balanceAfterCny`；
- 对不上说明撞了写：按 ledger 从头累加算出应有余额，再用本脚本补一笔差额（`--note`
  写明是纠正）。

```bash
# 核对：余额 vs 流水最后一行
cat /opt/genius/data/users/<userId>/user.json | grep balanceCny
tail -3 /opt/genius/data/ledger/<userId>.jsonl
```
