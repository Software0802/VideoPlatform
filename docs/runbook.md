# 运维手册（Genius / 流光）

面向已经读过 `docs/handoff.md`（当前状态）与 `docs/design.md`（as-built）的人，是「出了事怎么办」的操作清单，不重复讲设计。生产实例：阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service`。

## 管理 CLI 的运行身份

`genius.service` 以 root 运行，`/opt/genius/data` 整棵树归 root。所有 `scripts/*.mjs`（铸邀请码 / 礼品码、充值、重置密码、停用账号、用量统计）都直接写 `data/`，**必须以 root 或 `sudo` 执行**，普通用户（如 `admin`）会报 `EACCES: permission denied`：

```bash
cd /opt/genius && sudo node scripts/mint-invites.mjs 1
```

## 部署

完整打包与踩坑步骤见 `docs/handoff.md` §0a.4 与 `docs/design.md` §10.1（Turbopack 别名软链、`output: "standalone"` 为何在 Windows→Linux 不可用）。日常发布：

```bash
bash scripts/deploy.sh
```

`deploy.sh` 上传前本地跑 `pnpm exec tsc --noEmit`（`--skip-check` 可跳过），服务器侧启动后轮询 `/api/health`（10 次 × 6s），非 200/`ok:true` 会自动回滚（见下）。

## 回滚

`deploy.sh` 健康检查失败时**自动**执行：把 `.next.prev` 换回 `.next` → `systemctl restart genius` → 再验一次 `/api/health` → 仍不行则脚本非零退出并明确提示「回滚也没救」，此时需要人工介入（看 `journalctl -u genius -n 200`）。

手动回滚（`deploy.sh` 之外，比如发现是数据问题而非代码问题）：

```bash
systemctl stop genius
mv /opt/genius/.next /opt/genius/.next.bad
mv /opt/genius/.next.prev /opt/genius/.next   # 前提是上一次部署留下了 .next.prev
systemctl start genius
curl -sS http://127.0.0.1:3000/api/health
```

首次部署没有 `.next.prev`，`deploy.sh` 会打印警告并保留当前构建重启，不会回滚到「什么都没有」。

## key 轮换

| 密钥 | 轮换影响 | 操作 |
| --- | --- | --- |
| `LUMEN_SESSION_SECRET` | **全体用户立刻登出**（所有会话 Cookie 签名失效）；**不影响**已签发的分享链接（分享令牌用独立派生密钥，见 `docs/design.md` §2g） | 改 `.env` → `systemctl restart genius`；提前在群里通知会掉线 |
| `SHARE_TTL_HOURS` | 只影响**新签发**的分享链接有效期，已签发的链接按签发时的 TTL 走完 | 改 `.env` → 重启即可，无需通知用户 |
| 各 provider 的 `*_API_KEY`（`XAI_API_KEY`/`KLING_API_KEY`/`YMAN_API_KEY`/`OPENAI_API_KEY`） | 换成新 key 后立即生效，不影响在途任务的历史记录，但正在轮询的任务如果原 key 已失效会在下一次请求上游时报错 | 改 `.env` → 重启；建议先在低峰期换 |

密钥只在服务器 `/opt/genius/.env`（权限 600），不进代码仓库、不进聊天。

## 备份恢复

完整操作步骤见 `scripts/backup-restore.md`（包内容、crontab 配置、恢复到空 `DATA_DIR` 的完整命令序列、排错表、充值 CLI 无跨进程锁的已知限制与核对方法）。本节只列心智地图：

- 本机每日备份（`scripts/backup.sh`，防误删/坏写）+ 阿里云 ECS 自动快照（防磁盘/实例丢失），两层缺一不可。
- 备份包只含 `users/ invites/ gift-codes/ ledger/ agent/ templates/ canvases/ canvas-runs/ jobs/*/job.json`，**不含产物**（`outputs/inputs/shots`）——产物要整盘找回靠 ECS 快照，不靠这份备份。
- **crontab 与 ECS 自动快照策略均未在生产验证/配置**（阶段一遗留待办，见 `docs/handoff.md`），排期上线前必须补上。

## 磁盘告警处理

`/api/health` 磁盘剩余低于 5% 判不健康，并（配置了 `ALERT_WEBHOOK_URL` 时）触发 `disk_low` 告警。收到告警后：

1. `df -h /opt/genius` 确认剩余空间与挂载点。
2. 先看 `data/jobs/*/outputs` 与 `data/tmp` 是不是异常堆积（`DATA_RETENTION_DAYS` 到期清理是否在正常跑，`runner` 每小时的 `maintenance()` 是否有报错）。
3. 空间紧急时优先清 `data/tmp`（24h TTL 内的临时上传，`sweepTmp` 会自动清但可以手动提前跑一次逻辑对应的清理）；不要手动删 `data/jobs/*/outputs`（会造成「记录在、产物不在」但 `artifactsPurgedAt` 未写的不一致状态，见 `scripts/backup-restore.md` 的恢复后果说明）。
4. 长期方案是扩容磁盘或调低 `DATA_RETENTION_DAYS`，不是本手册范围内的一次性操作。

## provider 耗尽处理

某个上游（可灵 / YMan / OpenAI 图片）返回 `quota_exhausted` 后，路由层会自动把它标记耗尽 `PROVIDER_EXHAUSTED_TTL_MS`（默认 6 小时）并改走 `VIDEO_PROVIDER_ORDER`/`IMAGE_PROVIDER_ORDER` 里的下一家，期间用户报价只降不升；如果所有配了 key 的 provider 都耗尽，提交会返回 503 `no_provider_available`（不会静默落回 mock）。运维侧：

1. `GET /api/health` 的 `exhausted` 列表能看到当前被绕开的是谁、到什么时候、上游原话。
2. 去对应上游控制台充值（可灵、YMan、OpenAI/ccgoai 各自后台）。
3. 充值到账后不需要手动清除标记——到 `PROVIDER_EXHAUSTED_TTL_MS` 会自动放回去重试；如果急需立即恢复，重启服务会清空内存态的耗尽标记（`data/provider-state.json` 落盘状态会在下次读取时按 TTL 重新判定）。
4. 配置了 `ALERT_WEBHOOK_URL` 时会收到 `provider_exhausted` 告警，同一件事 10 分钟内只发一次。

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

# 直连探针（不计费）：有生图通道发一张 1K 1:1，否则 chat 一句
curl.exe -b "lumen_session=<...>" -X POST https://genius.homeaistack.online/api/admin/relays/ccgoai/probe

# 下线（新任务立刻路由不到；历史任务记录与在跑任务仍可解析——影子表）
curl.exe -b "lumen_session=<...>" -X DELETE https://genius.homeaistack.online/api/admin/relays/ccgoai
```

要点：

- `keyEnv` 指向的变量必须已在 `/opt/genius/.env` 里配上并 `systemctl restart genius`（env 是进程读的）；`hasKey=false` 的 relay 在列表里可见但不参与路由。
- 隐式次序：没显式配 `*_PROVIDER_ORDER` 时 relay 按 `priority` 降序排在内置默认之后；生产显式写了 ORDER，要让新 relay 接流量就把它加进 `VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER`。
- `yman` / `openai` 是老 env 折算的预设，PATCH/DELETE 它们会 404；要覆盖就 POST 一条同 id 的文件配置。

## ccgoai 生图 503 `service_busy`

现象：OpenAI 兼容通道（ccgoai）对 `gpt-image-2` 的 `quality=high` 一律回 503 `{"error":{"code":"service_busy","type":"api_error",...}}`。这是结构化错误体，代码已按**确定拒单**处理（普通 failed、可重试，不会锁 `uncertain_submit`）。

处理：把 `OPENAI_IMAGE_QUALITY` 降到 `medium`（生产当前值）或 `low`；`high` 在该中转上不可用属上游限制，不是本服务故障。

## 用户禁用与重置密码

```bash
# 封禁账号：写 disabled:true 并使当前所有会话立即失效
node scripts/disable-user.mjs <邮箱> --offline
# 解封
node scripts/disable-user.mjs <邮箱> --offline --enable

# 管理员强制重置密码：生成随机口令打印到 stdout，并使该账号所有设备立即掉线
node scripts/reset-password.mjs <邮箱> --offline
```

两个脚本都读 `DATA_DIR`（与服务端一致，未设为 `./data`），改的是同一份 `user.json` + `sessionEpoch`。`--offline` 是必须显式给出的声明：服务已停止、全部管理 CLI 串行执行——它们拿不到服务端的 `withUserLock`，撞写会被 billing 链校验拦下失败关闭（见 `scripts/backup-restore.md`「已知限制」），所以要先 `systemctl stop genius` 再操作，完成后 `systemctl start genius`；`sessionEpoch` 在每次请求时校验，重启后旧的禁用/重置立即生效。`reset-password.mjs` 打印的新口令只应口头/密码管理器传递给用户，不要写进工单或聊天记录。

## 充值与资金迁移

```bash
# 充值（金额可为负表示人工纠正）；--ref 给固定幂等键，结果不明时可安全重跑
node scripts/grant-balance.mjs <邮箱> <金额> --offline [--ref "固定键"] [--note "说明"]

# 存量账号迁入新资金格式（user.json 内嵌 billing 快照）：逐账号一份人工核对过的基线
node scripts/migrate-billing.mjs --offline --baseline <已核对基线.json>
```

新版资金模型（`docs/design.md` §2d）下 `user.json` 是余额 + 流水的唯一提交点，`ledger/<id>.jsonl` 变成派生导出物。**部署含此模型的代码前必须先迁移所有存量账号**，否则它们的余额变动一律 409 `billing_migration_required`（新注册账号不受影响，首次写盘即自带快照）。基线 JSON 由管理员逐账号核对生成，字段含 `userId`、迁移前 `user.json` 与 `ledger/<id>.jsonl` 的 sha256、`opening` 期初两池余额、每条历史入账行的池归属 `grantPools`、`reviewedBy`/`evidence`；校验不过不会动任何字节，不支持 `--force`。

## 礼品码

```bash
# 铸 N 张、每张面额 M 元的礼品码，打印到标准输出（不写日志）
node scripts/mint-gift-codes.mjs <数量> <金额> [--note "..."]
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

