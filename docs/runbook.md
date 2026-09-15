# 运维手册（Genius / 流光）

面向已经读过 `docs/handoff.md`（当前状态）与 `docs/design.md`（as-built）的人，是「出了事怎么办」的操作清单，不重复讲设计。生产实例：阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service`。

## 环境事实（2026-09-14 只读核查）

| 项 | 已验证事实 |
| --- | --- |
| Node / pnpm | v22.22.2 / 10.33.0（运行时；`BUILD_INFO.json` 的 `node` 字段记的是构建机版本 v24.16.0，两者不是一回事） |
| Caddy | v2.11.4，容器 taiyu-caddy-1 |
| genius.service | active；`User=genius`（uid 989，R1.5 已执行，drop-in 见下文）；MemoryHigh=550M、MemoryMax=700M（734003200 字节）；ExecStart=`next start -p 3000 -H 0.0.0.0`；SELinux Disabled |
| 反代链路 | 站点块 `genius.homeaistack.online { reverse_proxy 10.255.1.1:3000 }`：Caddy 容器经 docker 网关 `10.255.1.1` 连入宿主机，**服务必须绑 `0.0.0.0`，不能改成 loopback** |
| 目录归属 | `/opt/genius` 与 `data/` 均为 genius:genius；`.env` 为 `genius:genius` 640 |
| 磁盘 | /dev/vda3：40G，总已用 25G，可用 14G（65%）；`releases/` 两版共约 800M（node_modules 与 pnpm store 硬链接，KEEP_RELEASES=3） |
| 发布标识 | `/opt/genius/BUILD_INFO.json -> current/BUILD_INFO.json`，`shortSha 0359830`、`dirty:false`；`current -> releases/0359830-20260914-234013`，`PREVIOUS=legacy-13fb9ee`。2026-09-15 `deploy.sh --no-build` 全流程通过（120 文件 / 1348 测试、1 既有跳过、`--frozen-lockfile`、切链、health 200、公网 `/login` 200），双向回滚演练通过。登录态 `build.sha` 仍因无生产管理员会话未核对 |
| 对话与 relay 配置 | `.env` 已设 7 条 `AGENT_CHAT_MODELS`（默认 `gpt-5.6-luna`）和 `YMAN_T2V_MODEL=minimax_h3`，更新前状态备份 `.env.bak.20260914-220732`。`data/relays.json` 已首次创建且仅含 yman 文件条目（models-endpoint，24 模型：15 视频含 2 hidden、9 图片）；`data/relay-catalog/yman.json` 已首拉 24 模型快照。配置文件均归 genius:genius |
| 备份 | root crontab 每日 03:17（`17 3 * * *`）跑 backup.sh（新版白名单含 relays.json）；部署前手动包 `backups/genius-data-20260913-211416.tgz`（新脚本产物）已跑过 `restore-check --compare data`：**一致**（users 4、ledger 幂等键 54 重复 0、jobs 54、canvases 2、canvas-runs 1、assets 0、relays.json 有）——首次真实恢复核对，未做实际切换恢复。更早的 `genius-data-20260913-174421.tgz` 为旧版脚本产物、**不含 relays.json** |

站点块与全局配置都没有 `trusted_proxies`/`client_ip_headers`。按 Caddy v2.11.4 源码 `reverseproxy.go` 的 `addForwardedHeaders`：客户端不受信时 `X-Forwarded-For` **被覆盖为对端 IP**（不是追加），`X-Forwarded-Host` 覆盖为请求 Host——所以 `rate-limit.ts` 的 `clientIp()` 取首跳、`proxy.ts` 的 `expectedHost()` 认 x-forwarded-host 在当前拓扑下都成立（F-19 confirmed-safe，无需改配置）。以后接 CDN / 改 trusted_proxies 必须重新核对。

Node 22.x 的 node:sqlite 官方标注仍为 Stability 1.1（Active development），不是已稳定资金数据库选型；SQLite 迁移等待 R4 的实际触发条件，不因内置模块可用就迁账。

## 管理 CLI 的运行身份与令牌（R4.1）

`genius.service` 以 `genius` 运行，`/opt/genius` 整树归 `genius:genius`。管理脚本（铸邀请码 / 礼品码、充值、重置密码、停用账号）**默认走 HTTP 管理接口**，不再直写 `data/`：

```bash
cd /opt/genius && sudo -u genius node scripts/mint-invites.mjs 1
```

- 令牌：`LUMEN_ADMIN_TOKEN`（`openssl rand -hex 32` 生成）已写进 `/opt/genius/.env`（2026-09-13，写前备份 `.env.bak.20260913-211416`，部署重启后生效）；也可以每次调用临时给 `sudo -u genius LUMEN_ADMIN_TOKEN=… node scripts/xxx.mjs`。脚本按 env → `--env-file` → `/opt/genius/.env` → `./.env.local` 的顺序找令牌，所以服务器上不带 env 也能读到 `.env`。
- 令牌只在**本机 loopback 链路**生效（`x-forwarded-for` 缺失或每一跳都是 loopback，且 host 是 `127.0.0.1:*`/`localhost:*`；判据见 `src/lib/admin-token.ts`）——Caddy 对不受信客户端必把 XFF 覆盖为真实对端 IP，公网请求拿不到这个通道；`next dev` 内部代理注入的 `::ffff:127.x` 属合法 loopback 跳。`LUMEN_ADMIN_BASE_URL` 默认 `http://127.0.0.1:3000`。
- 令牌生效范围：五条 R4.1 管理路由（invites/gift-codes/users balance、disabled、password）+ `POST /api/admin/alerts/test`；`/api/admin/relays*` 四条**只认管理员会话**，令牌无效（按设计）。2026-09-13 实测：loopback+token `POST /api/admin/alerts/test` → 200 `{sent:false,format:"generic"}`（`ALERT_WEBHOOK_URL` 未配故 sent=false）；公网+token → 401；无 token → 401。
- `--offline` 仍在但语义收紧：先探测 `GET /api/health` 连不上（ECONNREFUSED）才允许直写文件；服务在跑就拒绝——这就是 D-4 的互斥，服务进程与 CLI 不再可能同时写 `data/`。
- 直写 `data/` 的脚本（`--offline` 路径与 `usage.mjs`、migrate 脚本）必须以服务身份跑：`sudo -u genius`；root 跑出来的新文件服务写不动。

## 部署

完整打包与踩坑步骤见 `docs/handoff.md` §0a.4 与 `docs/design.md` §10.1（Turbopack 别名软链、`output: "standalone"` 为何在 Windows→Linux 不可用）。日常发布：

```bash
bash scripts/deploy.sh
```

`deploy.sh` 的行为（本地段 R1.3 起，远端段 R1.4 于 `8b5282f`/`0359830` 改为 release 目录；**生产已于 2026-09-15 完成布局迁移与一次双向回滚演练**，现状：`current -> releases/83065c7-20260915-134029`，`PREVIOUS=0359830-20260914-234013`，`releases/` 另存 `legacy-13fb9ee`）：

- **门禁不可跳过**：上传前依次跑 `pnpm exec next typegen && pnpm exec tsc --noEmit`、`pnpm exec eslint src e2e scripts`、`pnpm test`，任一非零即中止。`--no-build` 只跳过 `pnpm build`，不跳过门禁；不再有 `--skip-check`。
- **脏工作树默认拒绝**：`git status --porcelain` 非空则打印 diffstat 并以退出码 2 中止；确需发布未提交改动用 `--allow-dirty`（release id 以 `-dirty` 结尾）。
- **发布指纹**：打包前在仓库根生成 `BUILD_INFO.json`（`sha`/`shortSha`/`builtAt`/`node`/`dirty`——`node` 是**构建机**的 Node 版本）。部署后用**登录态** `GET /api/health` 的 `build.sha` 对照本地 `git rev-parse HEAD`；匿名请求仍只回 `{ ok }`。
- **release 目录**（远端逻辑在 `scripts/deploy-remote.sh`，经 `bash -s` 推到服务器执行）：包解到 `/opt/genius/releases/<shortSha>-<builtAt YYYYMMDD-HHMMSS>[-dirty]/`，在该目录内 `pnpm install --prod --frozen-lockfile` + Turbopack 别名补链；任一步失败 → 目录改名 `<id>.failed`，**不切链、服务不停**。成功后 `chown -R genius:genius`，`/opt/genius/current` 用「临时软链 + `mv -T`」原子切到新 release，`releases/PREVIOUS` 记下上一个 id，`systemctl restart genius`，轮询 `/api/health`（10 次 × 6s）。
- **共享物不进 release**：`.env`（unit 的 `EnvironmentFile`）、`data/`（每个 release 内 `data -> /opt/genius/data` 软链，应用 `dataDir()` 仍是 cwd/data）、`backups/`、顶层 `data-seed`。顶层 `scripts -> current/scripts`、`BUILD_INFO.json -> current/BUILD_INFO.json` 是软链，所以 cron 的 `/opt/genius/scripts/backup.sh` 与 runbook 里 `cd /opt/genius && sudo -u genius node scripts/xxx.mjs` 都不用改。
- **修剪**：`KEEP_RELEASES`（默认 3）——current、PREVIOUS 必留，其余按 mtime 补足；多出的只在 `releases/` 下 `rm -rf`；`*.failed` 只留最新一份。
- **首次迁移**（`current` 还不是软链时自动执行，幂等）：停服 → 把顶层 `.next .next.prev .next.old node_modules package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.ts BUILD_INFO.json public scripts src` 逐项 `mv` 进 `releases/legacy-<shortSha>/`，`cp -a` 一份 `data-seed` → `current` 指向它 → 建顶层软链 → 备份 unit 与 drop-in 到 `backups/systemd-<ts>/` → 写 drop-in `/etc/systemd/system/genius.service.d/release.conf`（`WorkingDirectory=/opt/genius/current`、`ExecStart=` 重置为 `/opt/genius/current/node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0`；`user.conf` 不动）→ `daemon-reload` → 起服并验 health，**绿了才继续装新 release**。老布局因此成为第一个可回滚目标。不动 `.env*`、`data*`、`backups`、`app`、`migrate-baselines`、`gen-baselines.mjs`。
- 本地可用 `scripts/deploy-layout-selftest.sh`（Git Bash，临时目录 + 假 systemd/curl）演练迁移 → 两次发布 → 回滚 → 修剪，不碰生产。

## 回滚

`deploy.sh` 健康检查失败时**自动**执行：`current` 原子切回 `PREVIOUS` → `systemctl restart genius` → 再验 `/api/health` → 失败版改名 `.failed`；仍不行则非零退出提示「回滚也没救」，看 `journalctl -u genius -n 200`。

手动回滚（不跑门禁与构建，只连远端）：

```bash
bash scripts/deploy.sh --list             # 看 current / PREVIOUS / 全部 release
bash scripts/deploy.sh --rollback         # 切到 PREVIOUS
bash scripts/deploy.sh --rollback <id>    # 切到指定 release
```

回滚目标 health 不绿会自动切回原 current。服务器上没有 `deploy.sh` 时的等价手工操作：`ln -sfn releases/<id> /opt/genius/current.tmp && mv -T /opt/genius/current.tmp /opt/genius/current && systemctl restart genius && curl -sS http://127.0.0.1:3000/api/health`。

**R1.4 已执行（2026-09-15）**：首次迁移把旧布局搬成 `releases/legacy-13fb9ee`，unit 备份在 `backups/systemd-20260915-073427/`；随后部署 `0359830`，`--rollback` 回 legacy、`--rollback 0359830-20260914-234013` 回来，两次都 health 200 且公网 `/api/health` 200，taiyu 未受影响。**事故记录**：首次迁移后 legacy 起服 500 约 2 分钟——旧 `node_modules` 里 Turbopack 别名软链是绝对路径（`/opt/genius/node_modules/.pnpm/…`），目录 `mv` 后悬空，`ffmpeg-static-<hash>` 找不到；人工在 legacy 目录重建为相对链接后恢复，`0359830` 起脚本统一写相对链接并在迁移时先重建再起服。unit 回退方式 = 删 `release.conf` + `daemon-reload`，并把 `releases/legacy-*` 里的条目搬回顶层（别名链接需再改回可解析路径）。顶层 `current`/`scripts`/`BUILD_INFO.json` 软链归 root，服务只读它们，不影响运行。

## 服务账号（R1.5 已执行，2026-09-13）

`genius.service` 以专用账号 `genius`（uid 989，`useradd --system` 所建）运行，`/opt/genius` 整树归 `genius:genius`，`.env` 为 640。生效方式是 drop-in `/etc/systemd/system/genius.service.d/user.conf`：

```ini
[Service]
User=genius
Group=genius
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/opt/genius
PrivateTmp=yes
```

已验证：`systemctl show genius -p User` = genius；health 200；`sudo -u genius touch data/.writetest` 成功；`sudo -u genius node scripts/usage.mjs` 正常（ffmpeg 与写盘在 strict 下未被拦）。

约束与回退：

- 所有管理 CLI 与直写 `data/` 的脚本必须以服务身份跑：`sudo -u genius node scripts/xxx.mjs`。root 跑出来的新文件服务写不动。
- `backup.sh` 的 root cron 可保留：它只读源数据、写 `backups/`。
- `deploy.sh` 远端段在 install 之后有幂等 `chown -R genius:genius /opt/genius`（`genius` 不存在则跳过），迁移前后部署都安全。
- 回退：删除 `/etc/systemd/system/genius.service.d/user.conf` → `systemctl daemon-reload` → `systemctl restart genius`。文件归属可保留 `genius`，不影响 root 运行。

## key 轮换

| 密钥 | 轮换影响 | 操作 |
| --- | --- | --- |
| `LUMEN_SESSION_SECRET` | **全体用户立刻登出**（所有会话 Cookie 签名失效）；**不影响**已签发的分享链接（分享令牌用独立派生密钥，见 `docs/design.md` §2g） | 改 `.env` → `systemctl restart genius`；提前在群里通知会掉线 |
| `LUMEN_ADMIN_TOKEN` | 本机管理 CLI 的 Bearer 凭据；换掉即旧令牌作废，不影响任何用户会话 | `openssl rand -hex 32` → 写 `.env` → `systemctl restart genius` |
| `SHARE_TTL_HOURS` | 只影响**新签发**的分享链接有效期，已签发的链接按签发时的 TTL 走完 | 改 `.env` → 重启即可，无需通知用户 |
| 各 provider 的 `*_API_KEY`（`XAI_API_KEY`/`KLING_API_KEY`/`YMAN_API_KEY`/`OPENAI_API_KEY`） | 换成新 key 后立即生效，不影响在途任务的历史记录，但正在轮询的任务如果原 key 已失效会在下一次请求上游时报错 | 改 `.env` → 重启；建议先在低峰期换 |

密钥只在服务器 `/opt/genius/.env`（`genius:genius` 640），不进代码仓库、不进聊天。

## 告警渠道（R7）

`ALERT_WEBHOOK_URL` 指向的目标由 `ALERT_WEBHOOK_FORMAT` 决定，四个取值：`generic`（平铺 JSON `{event, at, ...}`，默认）、`feishu`、`dingtalk`、`wecom`。三种机器人都收到同一条文本消息，首行固定 `[Lumen] <事件名>`，下面每行一个 `key: value` 字段。`.env` 三个变量：

| 变量 | 说明 |
| --- | --- |
| `ALERT_WEBHOOK_URL` | 机器人 webhook 完整地址（http/https）；不设 = 不外发，只留日志 |
| `ALERT_WEBHOOK_FORMAT` | `generic`（默认）/ `feishu` / `dingtalk` / `wecom`；非法值回落 `generic` 并 warn 一次 |
| `ALERT_WEBHOOK_SECRET` | 飞书「签名校验」或钉钉「加签」的密钥（`SEC...` 串）；企微无签名机制，留空 |

机器人创建与安全设置要点（各自控制台，群设置 → 机器人 → 自定义机器人）：

- **飞书**：添加自定义机器人拿 `https://open.feishu.cn/open-apis/bot/v2/hook/...`。安全设置三选一：自定义关键词 / IP 白名单 / **签名校验**。开签名校验时把密钥填进 `ALERT_WEBHOOK_SECRET`；签名算法是 `base64(HmacSHA256(key = "${timestamp秒}\n${secret}", message = ""))`（官方文档 open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN），timestamp 距请求时间不能超过 1 小时。
- **钉钉**：添加自定义机器人拿 `https://oapi.dingtalk.com/robot/send?access_token=...`。安全设置若选**自定义关键词**，必须填 `Lumen`——文案首行就是 `[Lumen]`，关键词不匹配会被拒。若选**加签**，把 `SEC...` 密钥填进 `ALERT_WEBHOOK_SECRET`；签名算法是 `urlencode(base64(HmacSHA256(key=secret, message="${timestamp毫秒}\n${secret}")))`，追加在 URL query 上（官方文档 open.dingtalk.com/document/orgapp/customize-robot-security-settings）。
- **企微（WeCom）**：群机器人拿 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`，无签名机制，`ALERT_WEBHOOK_SECRET` 留空即可。

验证（服务在跑时，令牌走 .env 或环境变量）：

```bash
sudo -u genius node scripts/alert-test.mjs --note "上线验证"
# stderr 打 format=<格式> sent=<true|false>；sent=false 时查服务日志里的 warn
```

**去重窗口 10 分钟**：同一 dedupeKey（事件名或调用方拼的「事件+主体」）10 分钟内只发一次——`alert-test` 每次都带时间戳所以不撞，但真实的 `disk_low`/`relay_unhealthy` 重复触发时只看到一条属预期，不是丢了。

## 备份恢复

两层缺一不可：本机每日备份防**误删与坏写**，异地加密副本防**磁盘 / 实例丢失**。`scripts/backup.sh` 只打「丢了就重建不出来」的事实源：

| 路径 | 说明 |
| --- | --- |
| `users/` | 账号事实源（含 scrypt 密码哈希）与 `index.json` 派生缓存 |
| `invites/` | 一次性邀请码 |
| `gift-codes/` | 已铸未兑换的礼品码 |
| `ledger/` | 余额流水（派生导出物，与 `user.json.billing` 不一致时以 user.json 为准重建） |
| `agent/` | 智能体会话 |
| `templates/` | 创作模板 |
| `canvases/` | 画布文档 |
| `canvas-runs/` | 画布整图运行记录（含冻结的图快照、节点执行位、预算预留台账） |
| `notifications/` | 通知落盘（含已读游标） |
| `assets/` | 画布素材（输入事实源） |
| `relays.json` | 中转配置事实源 |
| `jobs/<id>/job.json` | 任务记录本身 |

**不在包里**：`jobs/<id>/outputs|inputs|shots`（成片与上传素材）、`idempotency/`、`tmp/`、`relay-catalog/`（可重拉缓存）、`provider-health.json`（暂态冷却）。成片体积是记录的几百倍，且 `DATA_RETENTION_DAYS`(30) 到期本来就会删；这份备份保的是「账号与账目不丢」。

> 恢复后的直接后果：老任务的记录在、产物不在。前端仍按 `job.json` 显示这些作品，点开取 `/api/media` 会 404（`artifactsPurgedAt` 没写，所以不是「已过期清理」占位卡）；介意的话恢复后可给这批 job.json 补 `artifactsPurgedAt`。画布历史 run 的成功节点因产物缺失不能再复用，新 run 会判 `blocked`/`output_purged`，报价时勾「重跑」显式重生成（设计行为，不是损坏）。`relay-catalog/` 恢复后可能提前探路，但不得因此重买已有/模糊提交任务。

包权限 600，里面有密码哈希与未使用的邀请码，不要随手 `scp` 到公共位置。

### 日常：cron 热备份（现状）

```bash
# 脚本随 deploy.sh 上传到 /opt/genius/scripts/backup.sh；备份目录只有 root 能进
mkdir -p /opt/genius/backups && chmod 700 /opt/genius/backups
/opt/genius/scripts/backup.sh          # 先手跑一次，确认输出是 backup ok
crontab -e                             # root 的 crontab：
```

```
17 3 * * * /opt/genius/scripts/backup.sh >> /opt/genius/backups/backup.log 2>&1
```

选 03:17 错开整点（别和同机其它定时任务撞）。失败非零退出并在日志留 `backup fail: ...`，可 `grep -c "backup fail" backup.log` 巡检。默认路径与保留份数可覆盖：`--data-dir` / `--backup-dir` / `--keep`（或 `DATA_DIR`/`BACKUP_DIR`/`KEEP`）。

### 一致性快照（--stop-service）

热备份在服务活着时打包，跨文件之间可能撞到「run 预留 vs user 余额」这类两个原子写之间的窗口（`restore-check --compare` 能对账发现）。数据集 <1MB、打包 <1s，停服窗口 ≈10s——需要严格一致时（资金迁移前后、月度存档）跑：

```bash
sudo bash /opt/genius/scripts/backup.sh --stop-service
# systemctl stop genius → 打包 → systemctl start → 等 /api/health 200（上限 60s）
# 输出带「一致性快照」；打包无论成败 trap 都会把服务拉回来
```

仅 root 且有 `systemctl` 时可用（否则退出码 2）。默认 cron 仍是热备份，不停服。

### 异地加密副本（阿里云 OSS）

`backup.sh` 末尾：本地 `.tgz` 成功后，若 `BACKUP_OSS_BUCKET` 非空则 `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` 加密成 `.tgz.enc` 再 `ossutil cp` 上传；上传成功才删本地 `.enc`（本地 `.tgz` 永不删）。异地是附加步骤：ossutil 缺失 / 加密失败 / 上传失败只打 `backup offsite warn|fail` 日志行，不影响本地备份退出码。`.env` 需要：

```bash
BACKUP_OSS_BUCKET=<bucket>
BACKUP_OSS_PREFIX=genius/               # 对象前缀，默认 genius/
BACKUP_ENC_PASSPHRASE=<openssl rand -hex 32 生成>
OSS_ACCESS_KEY_ID=<RAM 子账号 AK>        # ossutil 2.x 读这些环境变量
OSS_ACCESS_KEY_SECRET=<SK>
OSS_REGION=cn-<region>                  # 2.x 签名 V4 必填；或 OSS_ENDPOINT=<endpoint>
```

服务器装 ossutil（官方一键脚本，装到 /usr/bin；文档 help.aliyun.com/zh/oss/developer-reference/ossutil-overview）：

```bash
curl https://gosspublic.alicdn.com/ossutil/install.sh | sudo bash
```

bucket 建议开 30 天生命周期规则自动清旧副本（远端只作最近窗口的异地副本，长期留存靠本地 KEEP 份数）；AK 用只授权该 bucket `PutObject` 的 RAM 子账号。脚本只从 `/opt/genius/.env` 挑 `BACKUP_*`/`OSS_*` 变量，不整文件 source。

### 恢复演练与恢复流程

首次真实核对记录（2026-09-13）：对部署前手动包 `backups/genius-data-20260913-211416.tgz` 跑 `restore-check --archive … --compare /opt/genius/data` → 一致（users 4、ledger 幂等键 54 重复 0、jobs 54、canvases 2、canvas-runs 1、assets 0、relays.json 有）。注意幂等键口径为「按用户 + `protocol.mjs` keys()（job/gift/ref+kind）」（`1de057b` 修正）；尚未做解包切换的实际恢复。

```bash
# 0. 看包里是什么 / 先拿摘要（不解包到 DATA_DIR，只读）
node scripts/restore-check.mjs --archive /opt/genius/backups/genius-data-XXX.tgz
#    .enc 副本先解密核对：BACKUP_ENC_PASSPHRASE=... node scripts/restore-check.mjs --archive x.tgz.enc
#    摘要含：用户数、每人两池余额、ledger ref 集合大小与重复数、job.json /
#    canvases / canvas-runs / assets 计数、relays.json 有无

# 1. 停服务。恢复期间绝不能让 runner 写 data/
systemctl stop genius

# 2. 现有 data/ 挪开而不是删掉——恢复错包还能换回来
mv /opt/genius/data /opt/genius/data.broken.$(date +%Y%m%d-%H%M%S)

# 3. 解包到 data.restore 而不是直接覆盖
mkdir -p /opt/genius/data.restore
tar -xzf /opt/genius/backups/genius-data-XXX.tgz -C /opt/genius/data.restore
#   .enc：先 openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
#         -pass env:BACKUP_ENC_PASSPHRASE -in x.tgz.enc -out x.tgz

# 4. 与挪开的旧目录对账（逐文件字节比对 + 余额 / ref 集合核对）
node scripts/restore-check.mjs --archive /opt/genius/backups/genius-data-XXX.tgz \
  --compare /opt/genius/data.broken.XXX   # 全一致退出 0，有差异退出 1 并列 diff

# 5. 切换目录、修属主（服务以 genius 跑）
mv /opt/genius/data.restore /opt/genius/data
chown -R genius:genius /opt/genius/data && chmod 700 /opt/genius/data

# 6. 起服务、验证
systemctl start genius
curl -sS http://127.0.0.1:3000/api/health   # 必须 ok:true
ls /opt/genius/data/users | head          # users/index.json 是派生缓存，启动重建
```

登录一个已知账号、首页看得到历史任务列表才算恢复成功；确认后删 `data.broken.*`（空间紧张时优先删它，别删 `backups/`）。

### 排错

| 现象 | 原因与处理 |
| --- | --- |
| `backup fail: DATA_DIR 不存在` | cron 里没有 `.env` 的环境变量，默认路径又不对。用 `--data-dir` 写死绝对路径 |
| `backup fail: ... 没有可备份的内容` | `DATA_DIR` 指错了（指到了空目录），检查路径 |
| `backup warn: 打包过程中有文件被改写` | 热备份时服务正在写 job.json，属正常；原子 rename 保证读到的是完整旧版或新版 |
| `backup fail: 包内出现不该有的条目` | 白名单校验拦下异常内容，`.tmp` 已丢弃。把条目名贴出来排查 |
| `backup offsite warn/fail: ...` | 异地步骤失败不影响本地包；按提示补 ossutil / BACKUP_ENC_PASSPHRASE / OSS_* 后手工 `ossutil cp` 补传留在原地的 `.enc` |
| 恢复后登录提示密码错 | 密码哈希存 `user.json`，与 `LUMEN_SESSION_SECRET` 无关；先确认恢复的是同一环境的包 |
| 恢复后老作品打不开 | 预期行为，见上文「恢复后的直接后果」 |

画布素材迁移：`node scripts/migrate-canvas-assets.mjs --data-dir <目录>` 默认只读预检；写入须维护窗口、备份与 `--write --offline`。应用启动也会在 tmp 清理前保护存量素材；缺原件标 missing，无法恢复已清字节。首次迁移起保留 30 天，重复迁移不延长到期日。

## 磁盘告警处理

`/api/health` 磁盘剩余低于 5% 判不健康，并（配置了 `ALERT_WEBHOOK_URL` 时）触发 `disk_low` 告警。收到告警后：

1. `df -h /opt/genius` 确认剩余空间与挂载点。
2. 先看 `data/jobs/*/outputs` 与 `data/tmp` 是不是异常堆积（`DATA_RETENTION_DAYS` 到期清理是否在正常跑，`runner` 每小时的 `maintenance()` 是否有报错）。
3. 空间紧急时优先清 `data/tmp`（24h TTL 内的临时上传，`sweepTmp` 会自动清但可以手动提前跑一次逻辑对应的清理）；不要手动删 `data/jobs/*/outputs`（会造成「记录在、产物不在」但 `artifactsPurgedAt` 未写的不一致状态，见上文「备份恢复」节的恢复后果说明）。
4. 长期方案是扩容磁盘或调低 `DATA_RETENTION_DAYS`，不是本手册范围内的一次性操作。

## provider 耗尽处理

某个上游返回 `quota_exhausted` 后，健康子系统（`src/lib/providers/health.ts`）把它冷却 `PROVIDER_EXHAUSTED_TTL_MS`（默认 6 小时，落盘 `data/provider-health.json`，重启延续）；被**确定拒绝**的任务自动改走 `VIDEO_PROVIDER_ORDER`/`IMAGE_PROVIDER_ORDER` 里的下一家（换家留痕在 `job.providerSwitches`），用户报价只降不升；所有配了 key 的 provider 都不可用时提交返回 503 `no_provider_available`（不会静默落回 mock）。运维侧：

1. `GET /api/health` 的 `providerHealth`（保留 `exhausted` 读数）能看到谁在冷却、到什么时间、原因；`GET /api/admin/relays` 每条也有 `health`。
2. 去对应上游控制台充值（可灵、YMan、OpenAI/ccgoai 各自后台）。
3. 充值到账后不需要手动清除标记——冷却到期自动进半开，第一个探路任务成功即恢复；`data/provider-health.json` 的冷却按 `cooldownUntil` 判定，重启不会提前放行。
4. 配置了 `ALERT_WEBHOOK_URL` 时会收到 `provider_exhausted` 告警，同一件事 10 分钟内只发一次。

## 某家中转不稳（`relay_unhealthy` / 限流 / 点名的产品不可用）

现象：`ALERT_WEBHOOK_URL` 收到 `relay_unhealthy`（某家 × 通道连续 3 次 5xx / 连接失败 / 读超时，自动冷却 5 分钟，冷却内路由与 `/api/models` 都绕开它）；或任务失败码是 `product_unavailable`（用户点名的产品所在上游确定拒单）；或大面积 `uncertain_submit`（读超时 / 断连——可能已受理的单子绝不重发，进人工复核）。

处理：

1. `GET /api/health` 看 `providerHealth`：`cooldown` + `reason`（`rate_limited` 吃上游 `Retry-After` 封顶 15 分钟，无提示时 60s 起连击翻倍；`quota_exhausted` 6h；transient 连击 5 分钟）与 `half-open`（探路中）。
2. 上游侧在抖：什么都不用做——冷却到期进半开，第一个探路任务成功就恢复，失败翻倍再冷却（上限 15 分钟）。任务是**确定拒绝才换家**（4xx / 结构化拒单 / 连接没建立），上限 `RELAY_MAX_SWITCHES`（默认 2）按任务计、分镜按镜计；模糊失败一律 `uncertain_submit` 人工复核，不会自动重发。
3. 持续性故障就 `PATCH /api/admin/relays/<id> {"enabled":false}` 把它先摘出路由（见上节），或在 `*_PROVIDER_ORDER` 里调次序；修好再启用。
4. `uncertain_submit` 复核：先查上游后台这条任务到底建没建（外部单号 = jobId 或 `job.remoteId`），建了就把产物找回归档，没建才让用户重试——一键重试在该状态下被锁死是刻意的。

## 上游下架 / 改名模型（`upstream_model_missing`）

现象：任务或智能体报 404 `model_not_found`（YMan 报 `not_found`），`ALERT_WEBHOOK_URL` 收到 `upstream_model_missing` 告警（payload 带 `provider` / `model` / `base`，按 `provider:model` 去重 10 分钟）。中转站随时上下架模型，本地默认名不会自己跟着改。

处理：

1. 拿通道的 base + key 调 `GET {base}/models` 核对现在返回的展示名（YMan 是 `https://vip.yman.cc/v1/models`）。
2. 改 `/opt/genius/.env` 对应变量：`YMAN_T2V_MODEL` / `YMAN_I2V_MODEL` / `AGENT_CHAT_MODEL` / `OPENAI_IMAGE_MODEL` / `KLING_VIDEO_MODEL`；产品目录里钉死的模型名要用 `LUMEN_PRODUCTS`（JSON 数组）整体覆盖该产品。
3. `systemctl restart genius` 后公网提一条对应模式的小任务验证；新模型名若不在 `src/lib/providers/yman/catalog.ts` 登记，能跑通但按 `YMAN_UNKNOWN_CREDITS` 估价，随后把新名的档位与积分价目补进目录（或临时用 `YMAN_MODEL_CATALOG` 覆盖）。

## 新增 / 下线 / 停用一条中转（relay）

中转配置的事实源是 `data/relays.json`（结构见 `docs/design.md` §2l）；日常操作用管理接口，管理员账号由 `LUMEN_ADMIN_USER_ID` 指定。所有写操作落盘后立刻生效，不用重启。

```powershell
# 列表（含 hasKey / 注册状态 / 目录快照时间；永不含 key 值）
curl.exe -b "lumen_session=<管理员会话cookie>" https://genius.homeaistack.online/api/admin/relays

# 新增一条中转（keyEnv 只写环境变量名；key 值先进 .env，永远不进 relays.json）
curl.exe -b "lumen_session=<...>" -H "content-type: application/json" `
  -d '{"id":"ccgoai","name":"CCGO","baseUrl":"https://ccgoai.club/v1","keyEnv":"CCGOAI_API_KEY","priority":10,"image":{"protocol":"openai-images","model":"gpt-image-2","quality":"medium","flexibleSizes":true}}' `
  https://genius.homeaistack.online/api/admin/relays

# 停用（保留配置、立刻退出路由）/ 重新启用
curl.exe -b "lumen_session=<...>" -X PATCH -H "content-type: application/json" -d '{"enabled":false}' https://genius.homeaistack.online/api/admin/relays/ccgoai

# 拉一遍上游 /models 写目录快照（返回新增/消失 diff）
curl.exe -b "lumen_session=<...>" -X POST https://genius.homeaistack.online/api/admin/relays/ccgoai/discover

# 直连探针（平台不记账，上游可能收费；先确认预算）：一张 1K 1:1 或 chat 一句
curl.exe -b "lumen_session=<...>" -X POST https://genius.homeaistack.online/api/admin/relays/ccgoai/probe

# 下线（新任务立刻路由不到；历史任务记录与在跑任务仍可解析——影子表）
curl.exe -b "lumen_session=<...>" -X DELETE https://genius.homeaistack.online/api/admin/relays/ccgoai
```

要点：

- `keyEnv` 指向的变量必须已在 `/opt/genius/.env` 里配上并 `systemctl restart genius`（env 是进程读的）；`hasKey=false` 的 relay 在列表里可见但不参与路由。
- 隐式次序：没显式配 `*_PROVIDER_ORDER` 时 relay 按 `priority` 降序排在内置默认之后；生产显式写了 ORDER，要让新 relay 接流量就把它加进 `VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER`。
- `yman` / `openai` 是老 env 折算的预设，PATCH/DELETE 它们会 404；要覆盖就 POST 一条同 id 的文件配置。

## 中转上游下架模型时系统会怎样

`catalog.source:"models-endpoint"` 的 relay 每 `RELAY_CATALOG_REFRESH_MS`（默认 30 分钟）自动重拉 `/models` 并写快照（也可随时 `POST /:id/discover` 手动刷）：

- **普通模型消失**：记 warn + `upstream_model_missing` 告警（`reason:"catalog"`，按 `relay:model` 去重）；由该模型生成的产品（`<relayId>:<slug>`）立刻从 `/api/models` 消失，用户选不到它。
- **`video.defaults` 指的默认模型消失**：该 mode 立刻从 relay 的 `capabilities().modes` 收缩，路由自动跳到下一家能接的 provider，不等用户撞 404；模型回到目录后 mode 与产品自动恢复，不用重启。
- 拉取失败保留上次快照照常运行，只在日志 warn；从未成功过时目录退回 `catalog.models` 配置表。

## ccgoai 生图 503 `service_busy`

现象：OpenAI 兼容通道（ccgoai）对 `gpt-image-2` 的 `quality=high` 一律回 503 `{"error":{"code":"service_busy","type":"api_error",...}}`。这是结构化错误体，代码已按**确定拒单**处理（普通 failed、可重试，不会锁 `uncertain_submit`）。

处理：把 `OPENAI_IMAGE_QUALITY` 降到 `medium`（生产当前值）或 `low`；`high` 在该中转上不可用属上游限制，不是本服务故障。

## 用户禁用与重置密码

```bash
# 封禁账号：写 disabled:true 并使当前所有会话立即失效（走 /api/admin/users/[id]/disabled）
sudo -u genius node scripts/disable-user.mjs <邮箱|usr_id>
# 解封
sudo -u genius node scripts/disable-user.mjs <邮箱|usr_id> --enable

# 管理员强制重置密码：生成随机口令打印到 stdout，并使该账号所有设备立即掉线
sudo -u genius node scripts/reset-password.mjs <邮箱|usr_id>
```

两个脚本默认走 HTTP 管理接口（令牌见上文「管理 CLI 的运行身份与令牌」），服务端在 `withUserLock` 里改 `user.json` + `sessionEpoch`。`--offline` 退回直写文件，但会先探测服务确实没在跑（`GET /api/health` ECONNREFUSED）才放行；服务在跑时直写会被 billing 链校验拦下或与服务端写盘交错（CLI 拿不到服务端的 `withUserLock`），正确姿势永远是让 HTTP 路径生效。`sessionEpoch` 在每次请求时校验，禁用/重置立即生效，无需重启。`reset-password.mjs` 打印的新口令只应口头/密码管理器传递给用户，不要写进工单或聊天记录。

## 充值与资金迁移

```bash
# 充值（金额可为负表示人工纠正）；--ref 给固定幂等键，结果不明时可安全重跑
sudo -u genius node scripts/grant-balance.mjs <邮箱|usr_id> <金额> [--ref "固定键"] [--note "说明"]

# 存量账号迁入新资金格式（user.json 内嵌 billing 快照）：逐账号一份人工核对过的基线
sudo -u genius node scripts/migrate-billing.mjs --offline --baseline <已核对基线.json>
```

充值走 `POST /api/admin/users/[id]/balance` → `applyBalanceChange`，幂等语义与服务端完全一致（同 ref 重放返回原记录、同键异输入 409）。migrate-billing 仍是纯文件工具：要求 `--offline` 声明 + 服务停止（先 `systemctl stop genius`，完成后 `systemctl start genius`），且以 `sudo -u genius` 跑。

新版资金模型（`docs/design.md` §2d）下 `user.json` 是余额 + 流水的唯一提交点，`ledger/<id>.jsonl` 变成派生导出物。**部署含此模型的代码前必须先迁移所有存量账号**，否则它们的余额变动一律 409 `billing_migration_required`（新注册账号不受影响，首次写盘即自带快照）。基线 JSON 由管理员逐账号核对生成，字段含 `userId`、迁移前 `user.json` 与 `ledger/<id>.jsonl` 的 sha256、`opening` 期初两池余额、每条历史入账行的池归属 `grantPools`、`reviewedBy`/`evidence`；校验不过不会动任何字节，不支持 `--force`。

## 礼品码

```bash
# 铸 N 张、每张面额 M 元的礼品码，打印到标准输出（不写日志）
sudo -u genius node scripts/mint-gift-codes.mjs <数量> <金额> [--note "..."]
```

用户在订阅页「兑换礼品码」输入即可到账（`POST /api/me/redeem`）；同一张码只能兑一次（409 已用）、格式不对或不存在统一 404（不区分原因，防止探测码空间）。码本身就是钱，分发渠道要当作现金对待，别落进工单系统或聊天记录里。

## 智能体不可用 / 配对话 key

智能体消息接口返回 503 `agent_unavailable`，说明 `src/lib/agent/llm.ts` 的三级回落全部落空：

1. 不是 mock 模式（`isMockMode()` 为假，即已配了生图/视频 provider 的真 key）。
2. `AGENT_API_KEY`+`AGENT_BASE_URL` 未配置——这是生产要用智能体的**唯一**推荐路径（默认 `AGENT_BASE_URL=https://api.openai.com/v1`，模型 `AGENT_CHAT_MODEL` 默认 `gpt-4o-mini`，可覆盖）。
3. `XAI_API_KEY` 也未配置（否则会回落到 `grok-4.6`）。

处理步骤：

1. 确认生产 `.env` 是否已加 `AGENT_API_KEY`（+可选 `AGENT_BASE_URL`/`AGENT_CHAT_MODEL`）。**已知情况**：生产已配的 ccgoai / YMan 两家图片/视频中转实测都不提供对话模型，不能直接复用它们的 key。
2. 没有专门的对话模型 key 时，最简单是另开一个 OpenAI 官方 key（或任意 OpenAI 兼容对话中转）填入 `AGENT_API_KEY`/`AGENT_BASE_URL`。
3. 改 `.env` 后 `systemctl restart genius` 生效，无需数据迁移。
4. 智能体一轮固定收费 ¥0.05（`priceTable().agent.turn`），配置好 key 后可用任意测试账号发一条消息验证是否真的调通了上游。

## 订阅对账

`scripts/usage.mjs` 已把订阅相关流水单独分列，核对生产订阅收支时：

1. 会员积分发放（订阅购买 `ref:"sub:<id>:p0"`、跨期重置、按日发放）与已购余额扣款（购买时 `ref:"sub:<key>"`）是两条不同性质的流水行，`usage.mjs` 按 `sub:*` 前缀汇总展示，不要把「发的会员积分」误当成「收到的钱」——真正收到的钱只有购买/续订那一笔已购池扣款。
2. 会员积分池（`user.json.memberCreditsCny`）到期或跨期会清零/重置，是设计内行为，不是账目丢失；核对时只看已购池扣款是否与订阅档位价格一致。
3. 智能体扣款/退款（`ref:"agent:<turnId>"`/`ref:"agent:<turnId>:refund"`）同样在 `usage.mjs` 里按 `agent:*` 前缀单独列出，与订阅、任务扣款分开统计，避免混算收入。
4. 无支付网关，已购余额只能靠礼品码或 `scripts/grant-balance.mjs` 充值——订阅收入目前是「内部记账」而非真实收款，对账时以此为前提，不要误判为线上支付流水。

