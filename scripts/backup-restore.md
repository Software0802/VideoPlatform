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

## 已知限制：管理 CLI 与线上服务没有跨进程锁

`scripts/*.mjs` 是独立进程，拿不到服务端的 `withUserLock`（那把锁只在服务进程内
串行）。所以改 `user.json` 的 CLI（`grant-balance.mjs` / `reset-password.mjs` /
`disable-user.mjs`）一律要求 `--offline`：这是「服务已停止、CLI 串行执行」的显式
声明，是纪律而不是锁——脚本自己不会检测服务有没有在跑。

万一还是撞了写（CLI 与服务在同一瞬间改同一用户的 `user.json`）：单次写仍是原子的，
不会写出半截 JSON；新资金模型下丢写的后果从「静默少一笔」变成「下一次资金提交时
`billing_export_corrupt` 失败关闭」——服务写进快照的 op 被 CLI 的旧版整份覆盖后，
导出文件里留着的那行流水就与快照对不上，后续扣款/入账全部拒绝直到人工核对。宁可
拒付，不可错账。

操作纪律：

- **先 `systemctl stop genius`，再跑 `--offline` 的 CLI，完成后 `systemctl start`**；
- 充值尽量带 `--ref` 固定幂等键：结果不明（超时、断线）时可直接重跑同一条命令，
  不会重复入账；不带 `--ref` 的重跑会再充一笔；
- 撞写后的核对口径变了：`ledger/<id>.jsonl` 是导出物不是事实源，以 `user.json`
  里的 `billing.operations` 为准；确认丢写后按漏掉的 op 用 `grant-balance.mjs
  --ref` 补一笔差额（`--note` 写明是纠正）。

```bash
# 核对：余额 vs 快照链末端 / 导出文件最后一行
cat /opt/genius/data/users/<userId>/user.json | grep -E 'balanceCny|memberCreditsCny'
tail -3 /opt/genius/data/ledger/<userId>.jsonl
```
