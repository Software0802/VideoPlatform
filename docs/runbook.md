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
- 备份包只含 `users/ invites/ gift-codes/ ledger/ jobs/*/job.json`，**不含产物**（`outputs/inputs/shots`）——产物要整盘找回靠 ECS 快照，不靠这份备份。
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

## 用户禁用与重置密码

```bash
# 封禁账号：写 disabled:true 并使当前所有会话立即失效
node scripts/disable-user.mjs <邮箱>
# 解封
node scripts/disable-user.mjs <邮箱> --enable

# 管理员强制重置密码：生成随机口令打印到 stdout，并使该账号所有设备立即掉线
node scripts/reset-password.mjs <邮箱>
```

两个脚本都读 `DATA_DIR`（与服务端一致，未设为 `./data`），改的是同一份 `user.json` + `sessionEpoch`，不需要重启服务即可生效（`sessionEpoch` 在每次请求时都会校验）。`reset-password.mjs` 打印的新口令只应口头/密码管理器传递给用户，不要写进工单或聊天记录。

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

