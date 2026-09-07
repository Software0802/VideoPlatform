# 会话交接 — Genius（原 流光 · Lumen）

新会话从这里开始，再按需读 `AGENTS.md`（规则与约定）、`docs/design.md`（后端 as-built）、`DESIGN.md`（UI 规格）、`docs/runbook.md`（运维操作）。历史决策与逐轮变更记录不在本文——查 `git log` 与 `docs/plan-*.md`（顶部「状态」行标了现状，正文是历史方案，不再维护）。

## 0. 当前状态

| 字段 | 值 |
| --- | --- |
| 基线 | `main` @ `c8ee230`，工作区干净（无未提交改动） |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33 |
| 生产部署 | 已上线 `https://genius.homeaistack.online`（阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service` 以 root 运行，反代借用同机 taiyu 的 Caddy 容器终结 TLS） |
| 生产 provider 配置 | `VIDEO_PROVIDER_ORDER=kling,yman,grok`、`IMAGE_PROVIDER_ORDER=openai,yman`、`AGENT_BASE_URL=https://ccgoai.club/v1`、`AGENT_CHAT_MODEL=gpt-5.4-mini`（智能体线上可用）；**未配 `XAI_API_KEY`**，grok 只作为路由兜底不会被选中 |
| 生产订阅价格 | 标准 ¥19.1 / 专业 ¥49.6 / 尊享 ¥106.8 / 至尊 ¥170.3（月费，`costRatio` 按当前 provider 配置算出，非固定值，见 §2） |
| 门禁 | `pnpm exec tsc --noEmit` 绿、`pnpm exec eslint src` 绿、`pnpm test` 1036 通过 1 skip、`pnpm e2e` 29/29 通过（5 个文件，见 AGENTS.md「验证门禁」） |
| 本地运行 | `pnpm dev` → `http://localhost:3000`（**用 `localhost`，`127.0.0.1` 会被 Next 16 dev 403**）；无任何生图/视频 key 时整实例回落 mock 模式（ffmpeg 水印片）；未登录访问任意路由 307 到 `/login`，注册需一次性邀请码（`node scripts/mint-invites.mjs N --note "..."`） |
| 账号与余额 | 注册即送 ¥5（`SIGNUP_BONUS_CNY` 常量，`src/lib/users/service.ts`，流水 `ref:"signup"`，非环境变量）；更多余额靠管理员 `node scripts/grant-balance.mjs <邮箱> <金额> --note "..."` 充值，或用户在订阅页兑换礼品码（`node scripts/mint-gift-codes.mjs <数量> <金额>` 铸码）；每种任务定价 × 余额是主闸门，日配额只是防滥用兜底（`FREE_DAILY_IMAGE_QUOTA` 默认 200） |
| 首次部署 / 迁移新数据目录前必做 | `cp -r data-seed/templates data/templates`（创作模板种子不随代码自动生成，见 §2「模板」） |

## 1. 系统地图

### 1.1 前端：侧栏 + 五视图（`docs/design.md` §6、`DESIGN.md` 全文）

- 路由 `src/app/(shell)/`：`layout.tsx`（服务端校验会话、下发 provider 能力）+ `page.tsx`（主页）/`create/page.tsx`/`agent/page.tsx`/`canvas/page.tsx`/`subscription/page.tsx`，共享同一个 `GeniusShell`。
- 组件 `src/components/genius/`：`GeniusShell.tsx`/`ShellContext.tsx`（唯一客户端状态所有者 `useShell()`）/`Sidebar.tsx`/`TopBar.tsx`/`LanguageSwitch.tsx`/`icons.tsx`/`composer/`（悬浮创作面板）/`home/`（瀑布流）/`create/`/`agent/`/`canvas/`/`subscription/`。
- 样式：`src/app/globals.css`（壳 + 主页 + 创作面板 + 创作页 + 登录页）+ `src/app/styles/{agent,canvas,subscription}.css`。BEM + `data-*` 状态，不用 Tailwind / 组件库。
- 浏览器只经 `src/lib/client/*`（`jobs.ts`/`auth.ts`/`useJobLive.ts`/`useEvents.ts`/`http.ts`）访问 `/api/*`；401 整页跳 `/login`。
- 主页、创作面板、创作页、智能体、订阅五处已接真数据；**画布**视图仍是像素复刻 + 本地交互的原型（不发请求，占位数据）。有意偏离列表见 `DESIGN.md`「与交接包的有意偏离」。

### 1.2 后端模块（`docs/design.md` 是权威 as-built，章节号见下）

| 模块 | 代码路径 | as-built 章节 |
| --- | --- | --- |
| Job 生命周期 / runner / 索引 | `src/lib/jobs/{store,create,runner,quota,retention,rate-limit,retry-guard}.ts` | §3、§12.3、§12.4 |
| Provider 路由（能力 + 优先级） | `src/lib/providers/router.ts`、`exhaustion.ts` | §2b/§2c/§2e |
| Provider 实现 | `src/lib/providers/{grok,openai-image,kling,yman,mock}/` | §1、§2b、§2c、§2e |
| 产品目录（对用户露出的模型名） | `src/lib/products/catalog.ts` | §2f |
| 余额与计费 | `src/lib/billing/{prices,admission,ledger}.ts` | §2d |
| 订阅 / 会员积分池 | `src/lib/billing/{plans,subscription}.ts` | §2i |
| 智能体 | `src/lib/agent/{llm,skills,store,run-turn}.ts` | §2h |
| 多语言 | `src/lib/i18n/` | §13 |
| 分享 | `src/lib/share/token.ts` | §2g |
| 用户系统 / 会话网关 | `src/lib/users/`、`src/proxy.ts` | §12.1、§12.2 |
| Harness 一致性管线（30/45/60s，`HARNESS_ENABLED` 关闭中） | `src/lib/harness/` | §7 |
| ffmpeg | `src/lib/ffmpeg.ts` | §10 |
| HTTP API 全表 | `src/app/api/**/route.ts` | §4 |

### 1.3 数据落盘（完整清单见 `docs/design.md` §5）

`data/{jobs/index.json 派生缓存, jobs/{id}/job.json 事实源, users/, invites/, gift-codes/, ledger/<userId>.jsonl, agent/<userId>/<sessionId>.json, templates/*.json, tmp/, idempotency/}`；生产另有 `/opt/genius/backups/*.tgz`（`scripts/backup.sh`）与阿里云 ECS 自动快照两层备份。

### 1.4 环境变量分组（权威源 `src/lib/env.ts`，说明见 `.env.example`）

上游选择与路由：`XAI_API_KEY`/`SUB2API_API_KEY`/`XAI_BASE_URL`、`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_IMAGE_*`、`KLING_API_KEY`/`KLING_*`、`YMAN_API_KEY`/`YMAN_*`、`VIDEO_PROVIDER_ORDER`/`IMAGE_PROVIDER_ORDER`（含旧开关 `VIDEO_PROVIDER` 兼容）、`PROVIDER_EXHAUSTED_TTL_MS`、`USD_CNY_RATE`、`LUMEN_PRODUCTS`、`LUMEN_FORCE_MOCK`。计费与配额：`LUMEN_PRICE_TABLE`、`FREE_DAILY_IMAGE_QUOTA`、`FREE_DAILY_FAILURE_LIMIT`、`DATA_RETENTION_DAYS`、`MAX_QUEUED_JOBS(_PER_USER)`。用户系统：`LUMEN_SESSION_SECRET`（必填）、`LUMEN_ADMIN_USER_ID`、`SHARE_TTL_HOURS`。智能体：`AGENT_API_KEY`/`AGENT_BASE_URL`/`AGENT_CHAT_MODEL`。运维告警：`ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_TIMEOUT_MS`。其余：`DATA_DIR`、`JOB_CONCURRENCY`、`UPSTREAM_*`、`HARNESS_*`。

## 2. 已实现能力（按产品面）

- **创作**：文生视频 / 图生视频 / 文生图三条真实路径（UI 只暴露这三条，其余模式行渲染但置灰）；`POST /api/jobs` 可选 `model`（产品 id，见 `GET /api/models`）；时长 / 画幅 / 分辨率 / 有声档由服务端按 provider 能力下发；数量 1–4（串行创建 N 条任务）；素材复用（`POST /api/uploads/from-job`）；首尾帧仅可灵支持。
- **作品管理**：`GET /api/jobs?before&limit&kind` 游标分页；标签编辑（`PATCH`）、删除（`DELETE`，终态限定）；分享令牌 `POST /api/jobs/:id/share` → `/s/<token>`（公开只读页 + 媒体）；全局事件流 `GET /api/events` 驱动 toast / 铃铛（不落盘，仅当次会话有效）。
- **模板**：`GET /api/templates` 读 `data/templates/*.json`，首次部署需手动 `cp -r data-seed/templates data/templates`（六条示例种子）。
- **账号与余额**：邮箱 + 密码 + 一次性邀请码注册；改密（`POST /api/auth/password`，旧会话失效）；管理 CLI 封禁/解封（`disable-user.mjs`）、重置密码（`reset-password.mjs`）、充值（`grant-balance.mjs`）、铸邀请码/礼品码（`mint-invites.mjs`/`mint-gift-codes.mjs`）、用量对账（`usage.mjs`）；礼品码自助兑换 `POST /api/me/redeem`；积分流水 `GET /api/me/ledger`；注册赠 ¥5；准入闸门 = 余额 − 在途预留 ≥ 本次售价（§2d），配额与止损阀降级为防滥用兜底。
- **订阅与会员积分池**：四档（标准/专业/尊享/至尊），月费按 `成本 ÷ (1−15%毛利率)` 算出，年费 = 12×月费不打折；会员积分独立池，到期清零、跨期重置、按日发放；只能用已购余额购买（硬约束，防套利）；`GET/POST /api/subscription`。
- **智能体**：真实 LLM 编排（生产走 `AGENT_BASE_URL=ccgoai.club`），一轮 ¥0.05，可按需触发真实生成任务（`text_to_image`/`text_to_video`，走同一套限流与幂等）；20 个技能定义；会话落盘 `data/agent/<userId>/<sessionId>.json`。
- **多语言**：`zh-CN`/`en` 两语，Cookie `lumen_locale` + `Accept-Language` 兜底，顶栏与登录页可切换；服务端错误文案不翻译（已知未做）。
- **稳态与安全**：任务索引（`data/jobs/index.json`）取代全表扫描；上游轮询阶梯 2s→5s→10s；崩溃恢复不重复计费（`uncertain_submit` 拦一键重试）；429/quota 指数退避；provider 积分耗尽自动换家（售价只降不升，一家都不剩时 503 而非静默落 mock）；限流（提交 10 次/分钟、上传 5 次/分钟、单账号在途任务数上限）；`/api/health` 分级下发（匿名只回 `{ok}`）；`x-request-id` 全链路追踪；CSRF 意义上的 Origin/Referer 校验（两者都缺失时放行，已记录的设计取舍）；CI（`tsc`/`eslint`/`test`，不含 e2e）。

## 3. 已知限制 / 未做

- 生产未配 `XAI_API_KEY`：grok 只是路由兜底，实际不可达；`edit_video`/`extend_video`/harness 长片依赖 grok，生产目前不可用。
- Harness（30/45/60 秒一致性管线）代码完整但 `HARNESS_ENABLED` 生产关闭；视觉 QC 阈值未经 `evals/runs` 校准，默认跳过。
- 服务端 API 错误文案不做多语言翻译（前端按错误码映射的部分除外）。
- 无支付网关，已购余额只能靠礼品码或管理员 CLI 充值，订阅收入是内部记账而非真实收款（`docs/runbook.md`「订阅对账」）。
- 画布视图是本地交互原型，不接后端。智能体依赖单独配置的 `AGENT_API_KEY`/`AGENT_BASE_URL`（生产已配 ccgoai `gpt-5.4-mini`；只出图/视频的中转 key 没有对话模型，不能复用）；会话无留存清理（每人上限 200）；502「上游挂了已退款」与 503「没配 key」共用错误码 `agent_unavailable`。
- `data/jobs/*/job.json` 是事实源、`index.json` 是可重建缓存；`hasChargeFor`/幂等扣款全量扫流水文件，未建索引，内测规模无感。
- `scripts/grant-balance.mjs`/其余管理 CLI 与线上服务无跨进程锁，操作前后建议核对 `data/ledger/<userId>.jsonl`。
- 生产 crontab 已有每日 03:17 的 `scripts/backup.sh`（2026-09-07 核实，`/opt/genius/backups/` 已有两份）；阿里云 ECS 自动快照策略只能在控制台看，SSH 核实不了，未确认。
- 手机端只做了侧栏收窄的最低适配（≤900px），未做完整体验回归。

## 4. 运维与部署

完整操作手册见 `docs/runbook.md`：部署（`bash scripts/deploy.sh`，含自动回滚）、手动回滚、key 轮换、备份恢复（`scripts/backup-restore.md`）、磁盘告警处理、provider 耗尽处理、用户禁用/重置密码、礼品码铸造、智能体不可用排查、订阅对账。部署打包与跨平台踩坑细节（Turbopack 别名软链、`output: "standalone"` 为何不可用）见 `docs/design.md` §10.1。管理 CLI 一律以 root/sudo 在服务器执行（`genius.service` 以 root 运行，`data/` 整棵树归 root）。

## 5. 下一刀建议

1. 在阿里云控制台核实 ECS 自动快照策略是否开启（crontab 备份已在跑）。
2. 视需要给生产配 `AGENT_API_KEY`（当前走 `ccgoai.club`，若要换更稳定的对话上游）或补 `XAI_API_KEY`（解锁 `edit_video`/`extend_video`/harness 长片）。
3. 校准 `HARNESS_QC_VISUAL_THRESHOLD`（需要 `evals/runs` 对照集），再评估是否开启 `HARNESS_ENABLED`。
4. 手机端定稿（当前只有侧栏收窄的最低适配）。
5. 画布视图（节点工作流）何时接真实后端，按用户排期另行立项。
