# 会话交接 — Genius（原 流光 · Lumen）

新会话从这里开始，再按需读 `AGENTS.md`（规则与约定）、`docs/design.md`（后端 as-built）、`DESIGN.md`（UI 规格）、`docs/runbook.md`（运维操作）。历史决策与逐轮变更记录不在本文——查 `git log` 与 `docs/plan-*.md`（顶部「状态」行标了现状，正文是历史方案，不再维护）。

## 0. 当前状态

本轮核对日期：2026-09-12。本文生产部署、配置、价格与备份信息沿用既有交接记录，本轮未访问生产、未重新核实，也未部署。

| 字段 | 值 |
| --- | --- |
| 基线 | `main` @ `1f3077f`（R01–R09 + A–C 切片）+ **工作区未提交的 D 切片一**（画布 DAG 运行：`data/canvas-runs/`、确定性报价 `quoteHash`、sweep 执行器、持久化取消意图；方案 `docs/plan-dag-canvas-run-2026-09-12.md`，过 Codex 评审后实装）。本地领先 origin/main 4 个提交，未推送未部署 |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33 |
| 生产部署 | 已上线 `https://genius.homeaistack.online`（阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service` 以 root 运行，反代借用同机 taiyu 的 Caddy 容器终结 TLS） |
| 生产 provider 配置 | `VIDEO_PROVIDER_ORDER=kling,yman,grok`、`IMAGE_PROVIDER_ORDER=openai,yman`、`AGENT_BASE_URL=https://ccgoai.club/v1`、`AGENT_CHAT_MODEL=gpt-5.4-mini`（智能体线上可用）；**未配 `XAI_API_KEY`**，grok 只作为路由兜底不会被选中 |
| 生产订阅价格 | 标准 ¥19.1 / 专业 ¥49.6 / 尊享 ¥106.8 / 至尊 ¥170.3（月费，`costRatio` 按当前 provider 配置算出，非固定值，见 §2） |
| 门禁 | 本轮依次执行 `pnpm exec tsc --noEmit` → `pnpm exec eslint src` → `pnpm test` → `pnpm build` → `pnpm e2e`，均退出 0：全量 96 文件、1120 通过、1 skip（新增 `run-graph.test.ts` 13 条：环/容量/无提示词/越权素材拒绝、幂等重放与异参 409、`quote_stale`、图→视频链同 run 产物接续、余额不足 failed+下游 blocked、取消不提交新节点、崩溃窗口幂等接管、一素材喂两节点不消耗、`price_changed` 拦截）；e2e 29 通过（顺带修复 A–C 遗留的 setup 断点：`grant-balance.mjs` 自 R01/R03 起要求 `--offline`，两处 e2e 调用补上并加 `--ref`；`genius.spec.ts` 分页用例种子改为未来时间戳，修掉「前面用例的真实任务挤占首屏」的既有脆弱点） |
| 本地运行 | `pnpm dev` → `http://localhost:3000`（**用 `localhost`，`127.0.0.1` 会被 Next 16 dev 403**）；无任何生图/视频 key 时整实例回落 mock 模式（ffmpeg 水印片）；未登录访问任意路由 307 到 `/login`，注册需一次性邀请码（`node scripts/mint-invites.mjs N --note "..."`） |
| 账号与余额 | 注册即送 ¥5（`SIGNUP_BONUS_CNY` 常量，`src/lib/users/service.ts`，流水 `ref:"signup"`，非环境变量）；更多余额靠管理员 `node scripts/grant-balance.mjs <邮箱> <金额> --offline [--ref 键] [--note "..."]` 充值，或用户在订阅页兑换礼品码（`node scripts/mint-gift-codes.mjs <数量> <金额>` 铸码）；每种任务定价 × 余额是主闸门，日配额只是防滥用兜底（`FREE_DAILY_IMAGE_QUOTA` 默认 200） |
| 首次部署 / 迁移新数据目录前必做 | `cp -r data-seed/templates data/templates`（创作模板种子不随代码自动生成，见 §2「模板」） |

## 1. 系统地图

### 1.1 前端：侧栏 + 五视图（`docs/design.md` §6、`DESIGN.md` 全文）

- 路由 `src/app/(shell)/`：`layout.tsx`（服务端校验会话、下发 provider 能力）+ `page.tsx`（主页）/`create/page.tsx`/`agent/page.tsx`/`canvas/page.tsx`/`subscription/page.tsx`，共享同一个 `GeniusShell`。
- 组件 `src/components/genius/`：`GeniusShell.tsx`/`ShellContext.tsx`（唯一客户端状态所有者 `useShell()`）/`Sidebar.tsx`/`TopBar.tsx`/`LanguageSwitch.tsx`/`icons.tsx`/`composer/`（悬浮创作面板）/`home/`（瀑布流）/`create/`/`agent/`/`canvas/`/`subscription/`。
- 样式：`src/app/globals.css`（壳 + 主页 + 创作面板 + 创作页 + 登录页）+ `src/app/styles/{agent,canvas,subscription}.css`。BEM + `data-*` 状态，不用 Tailwind / 组件库。
- 浏览器只经 `src/lib/client/*`（`jobs.ts`/`auth.ts`/`useJobLive.ts`/`useEvents.ts`/`http.ts`）访问 `/api/*`；401 整页跳 `/login`。
- 主页、创作面板、创作页、智能体、订阅、画布六处均已接真数据（画布见 §2「画布」）。有意偏离列表见 `DESIGN.md`「与交接包的有意偏离」。

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
| 画布（含 DAG 运行） | `src/lib/canvas/{schema,store,run,graph,dag,run-store}.ts` | §2j |
| 多语言 | `src/lib/i18n/` | §13 |
| 分享 | `src/lib/share/token.ts` | §2g |
| 用户系统 / 会话网关 | `src/lib/users/`、`src/proxy.ts` | §12.1、§12.2 |
| Harness 一致性管线（30/45/60s，`HARNESS_ENABLED` 关闭中） | `src/lib/harness/` | §7 |
| ffmpeg | `src/lib/ffmpeg.ts` | §10 |
| HTTP API 全表 | `src/app/api/**/route.ts` | §4 |

### 1.3 数据落盘（完整清单见 `docs/design.md` §5）

`data/{jobs/index.json 派生缓存, jobs/{id}/job.json 事实源, users/, invites/, gift-codes/, ledger/<userId>.jsonl, agent/<userId>/<sessionId>.json, canvases/<userId>/<canvasId>.json, canvas-runs/<userId>/<runId>.json, templates/*.json, tmp/, idempotency/}`；生产另有 `/opt/genius/backups/*.tgz`（`scripts/backup.sh`，白名单含 canvases/，**canvas-runs 尚未进备份白名单**，部署前需补）与阿里云 ECS 自动快照两层备份。

### 1.4 环境变量分组（权威源 `src/lib/env.ts`，说明见 `.env.example`）

上游选择与路由：`XAI_API_KEY`/`SUB2API_API_KEY`/`XAI_BASE_URL`、`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_IMAGE_*`、`KLING_API_KEY`/`KLING_*`、`YMAN_API_KEY`/`YMAN_*`、`VIDEO_PROVIDER_ORDER`/`IMAGE_PROVIDER_ORDER`（含旧开关 `VIDEO_PROVIDER` 兼容）、`PROVIDER_EXHAUSTED_TTL_MS`、`USD_CNY_RATE`、`LUMEN_PRODUCTS`、`LUMEN_FORCE_MOCK`。计费与配额：`LUMEN_PRICE_TABLE`、`FREE_DAILY_IMAGE_QUOTA`、`FREE_DAILY_FAILURE_LIMIT`、`DATA_RETENTION_DAYS`、`MAX_QUEUED_JOBS(_PER_USER)`。用户系统：`LUMEN_SESSION_SECRET`（必填）、`LUMEN_ADMIN_USER_ID`、`SHARE_TTL_HOURS`。智能体：`AGENT_API_KEY`/`AGENT_BASE_URL`/`AGENT_CHAT_MODEL`。运维告警：`ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_TIMEOUT_MS`。其余：`DATA_DIR`、`JOB_CONCURRENCY`、`UPSTREAM_*`、`HARNESS_*`。

## 2. 已实现能力（按产品面）

- **创作**：文生视频 / 图生视频 / 文生图三条真实路径（UI 只暴露这三条，其余模式行渲染但置灰）；`POST /api/jobs` 可选 `model`（产品 id，见 `GET /api/models`）；时长 / 画幅 / 分辨率 / 有声档由服务端按 provider 能力下发；数量 1–4（串行创建 N 条任务）；素材复用（`POST /api/uploads/from-job`）；首尾帧仅可灵支持。
- **作品管理**：`GET /api/jobs?before&limit&kind` 游标分页；标签编辑（`PATCH`）、删除（`DELETE`，终态限定）；分享令牌 `POST /api/jobs/:id/share` → `/s/<token>`（公开只读页 + 媒体）；全局事件流 `GET /api/events` 驱动 toast / 铃铛（不落盘，仅当次会话有效）。
- **模板**：`GET /api/templates` 读 `data/templates/*.json`，首次部署需手动 `cp -r data-seed/templates data/templates`（六条示例种子）。
- **账号与余额**：邮箱 + 密码 + 一次性邀请码注册；改密（`POST /api/auth/password`，旧会话失效）；管理 CLI 封禁/解封（`disable-user.mjs`）、重置密码（`reset-password.mjs`）、充值（`grant-balance.mjs`，工作区起均须 `--offline`，充值可带 `--ref` 固定幂等键）、铸邀请码/礼品码（`mint-invites.mjs`/`mint-gift-codes.mjs`）、用量对账（`usage.mjs`）；礼品码自助兑换 `POST /api/me/redeem`；积分流水 `GET /api/me/ledger`；注册赠 ¥5；准入闸门 = 余额 − 在途预留 ≥ 本次售价（§2d），配额与止损阀降级为防滥用兜底。**工作区新资金模型**：`user.json.billing`（legacyLedger + opening + 自校验 operations 链）与两池余额同一次原子写提交，jsonl 成为派生导出物，篡改/不一致即 `billing_export_corrupt` 失败关闭；幂等重放须同键同输入（撞不同输入 409 `billing_idempotency_conflict`）；协议见 `src/lib/billing/{protocol,file-ledger}.mjs` 与 `docs/design.md` §2d。
- **订阅与会员积分池**：四档（标准/专业/尊享/至尊），月费按 `成本 ÷ (1−15%毛利率)` 算出，年费 = 12×月费不打折；会员积分独立池，到期清零、跨期重置、按日发放（`assertBalance` 准入前先惰性结算，跨期旧积分不进可用额）；只能用已购余额购买（硬约束，防套利）；`GET/POST /api/subscription`。`purchaseSubscription` 为外层 `withAdmissionLock`、内层 `withUserLock`；扣款行带订单快照，「已扣款、订阅记录缺失」按快照补建不二次扣款。
- **智能体**：真实 LLM 编排（生产走 `AGENT_BASE_URL=ccgoai.club`），一轮 ¥0.05；**默认批准制**——LLM 产出报价提案（含每条价格快照与 30 分钟有效期），`POST .../turns/:turnId/approve` 才建任务（`createJob` 同链路、幂等 key `agent:<turnId>:<i>`），`/reject` 不建不退；Turn 状态机随会话文件落盘，`turnId`+`requestHash` 重放语义（同参交回、异参 409、thinking 续跑、陈旧 thinking 惰性退款）；会话预算 `budget`（402 `budget_exhausted`）；action 可带 `imageRef.uploadId`（图生视频）；技能可声明 `kinds` 过滤越界动作；回复语言随 `lumen_locale`。
- **画布**（2026-09-11/12）：`/canvas` 接真实后端——文档落 `data/canvases/`、`expectedRevision` 409 乐观并发；四类节点（文本/素材/文生图/生成视频），`POST .../nodes/:nodeId/run` 走 `createJob`（素材或上游文生图产物喂入即 `image_to_video`）；前端右键建节点、拖拽、防抖落盘、刷新恢复。**整图运行（D 包）**：`POST /api/canvases/:id/quotes` 确定性报价（不落盘，`quoteHash` 重算比对，图变即 409 `quote_stale`）→ `POST /api/canvas-runs` 冻结图建 run → sweep 泵按依赖经 `createJob` 逐节点提交（子任务幂等键 `run:<runId>:<nodeId>:<attempt>`，提交前先 `lookupIdempotency` 查回接管，素材一律复制不消耗原件）；`cancelRequestedAt` 持久化取消意图，停提交、在途走既有 job cancel、全终态落 `canceled`；run 不回写画布文档，前端用最新 run 的执行位 overlay 产物；价变即节点 `failed`/`price_changed` 不按新价扣款。详见 `docs/design.md` §2j。
- **多语言**：`zh-CN`/`en` 两语，Cookie `lumen_locale` + `Accept-Language` 兜底，顶栏与登录页可切换；服务端错误文案不翻译（已知未做）。
- **稳态与安全**：任务索引（`data/jobs/index.json`）取代全表扫描；上游轮询阶梯 2s→5s→10s；`uncertain_submit` 拦一键重试（崩溃恢复与运行期模糊提交两条路径都会打上这个标记，见 §3）；429/quota 指数退避；provider 积分耗尽自动换家（售价只降不升，一家都不剩时 503 而非静默落 mock）；限流（提交 10 次/分钟、上传 5 次/分钟、单账号在途任务数上限）；`/api/health` 分级下发（匿名只回 `{ok}`）；`x-request-id` 全链路追踪；CSRF 意义上的 Origin/Referer 校验（两者都缺失时放行，已记录的设计取舍）；CI（`tsc`/`eslint`/`test`，不含 e2e）。

## 3. 已知限制 / 未做

- **资金与执行恢复缺陷索引**（证据与历史复现见 `docs/review-2026-09-08.md`）：R01–R09 均已在工作区修复——R01 余额+流水同一原子写（`e564ab6`）；R02 Agent 退款经 `refundOf` 按原扣款的 `memberCny` 拆回原池；R03 订阅购买外层 admission 锁；R04 扣款行带订单快照（planId/cycle/priceCny/orderedAt），「已扣款、订阅记录缺失」按快照补建且不再判余额，同 key 异参 409；R05 `assertBalance` 先惰性结算再判可用额，跨期旧积分不再进 `availableCny`；R06 submit 的 5xx/超时/断连算「结果不确定」，先 `lookupByExternalId` 查回接管，查不到则 `failed`+`uncertain_submit` 锁死重试；R07 幂等键与请求哈希落 `job.json`（事实源），`data/idempotency/*.json` 降级为可重建缓存（原子写、命中回读校验、miss 从任务索引重建），同 key 异参 409 `idempotency_conflict`；R08 请求体加 `turnId`，同 turnId 重放原样交回、换文本 409、已退款轮次同键重发 409；R09 产物字节已 checkpoint（persisting / localOutputPath / remoteUrl）时取消不再成立，终态由 persist 落盘结算。绿门禁不代替专项验收，生产行为未实测。
- **部署阻断项（新资金模型）**：本工作区版本一旦部署，**所有存量账号的余额变动会一律 409 `billing_migration_required`**，必须先停服、逐账号用 `scripts/migrate-billing.mjs --offline --baseline <人工核对的基线.json>` 迁移（基线含双 sha256 + reviewedBy/evidence，见 `docs/runbook.md`「充值与资金迁移」）。新注册账号不受影响。
- **未实装计划（A–C 已提交 `1f3077f`，D 切片一已实装未提交）**：`docs/plan-unimplemented-2026-09-08.md` 于 2026-09-09 经 Codex 评审为 `VERDICT: BLOCK`，用户随后逐项拍板实施：A 显式 Reservation（`job.reservation` earmark + 恢复中心 `recovery/reconcile/resume` + 创作页「核验上游」入口）；B 智能体 Turn 状态机 + 默认批准制提案 + 会话预算 + `imageRef` + 技能 `kinds` + locale 回复；C 画布持久化 + revision 409 + 四类节点接 `createJob`；D 切片一画布 DAG 运行已实装并过全门禁（`docs/plan-dag-canvas-run-2026-09-12.md`，工作区未提交）。其余 E–J（Harness 长片放行、F 视频模式 UI、G 支付网关、H 账号页/通知落盘、I 运维扩容）仍未实施。
- 生产未配 `XAI_API_KEY`：grok 只是路由兜底，实际不可达；`edit_video`/`extend_video`/harness 长片依赖 grok，生产目前不可用。
- Harness（30/45/60 秒一致性管线）代码完整但 `HARNESS_ENABLED` 生产关闭；视觉 QC 阈值未经 `evals/runs` 校准，默认跳过。
- 服务端 API 错误文案不做多语言翻译（前端按错误码映射的部分除外）。
- 无支付网关，已购余额只能靠礼品码或管理员 CLI 充值，订阅收入是内部记账而非真实收款（`docs/runbook.md`「订阅对账」）。
- 智能体依赖单独配置的 `AGENT_API_KEY`/`AGENT_BASE_URL`（生产已配 ccgoai `gpt-5.4-mini`；只出图/视频的中转 key 没有对话模型，不能复用）；会话与画布无留存清理（会话每人上限 200）；502「上游挂了已退款」与 503「没配 key」共用错误码 `agent_unavailable`。
- `data/jobs/*/job.json` 是事实源、`index.json` 是可重建缓存；`hasChargeFor`/幂等扣款全量扫流水文件，未建索引，内测规模无感。
- `scripts/grant-balance.mjs`/其余管理 CLI 与线上服务无跨进程锁，操作前后建议核对 `data/ledger/<userId>.jsonl`。
- 生产 crontab 已有每日 03:17 的 `scripts/backup.sh`（2026-09-07 核实，`/opt/genius/backups/` 已有两份）；阿里云 ECS 自动快照策略只能在控制台看，SSH 核实不了，未确认。
- 手机端只做了侧栏收窄的最低适配（≤900px），未做完整体验回归。

## 4. 运维与部署

完整操作手册见 `docs/runbook.md`：部署（`bash scripts/deploy.sh`，含自动回滚）、手动回滚、key 轮换、备份恢复（`scripts/backup-restore.md`）、磁盘告警处理、provider 耗尽处理、用户禁用/重置密码、礼品码铸造、智能体不可用排查、订阅对账。部署打包与跨平台踩坑细节（Turbopack 别名软链、`output: "standalone"` 为何不可用）见 `docs/design.md` §10.1。管理 CLI 一律以 root/sudo 在服务器执行（`genius.service` 以 root 运行，`data/` 整棵树归 root）。

## 5. 下一刀建议

1. A–C 切片已实装、过全量门禁、已提交（`1f3077f`）；D 切片一（画布 DAG 运行）已实装、过全门禁（含 e2e 29 条）、**在工作区未提交**，等用户指示是否提交；部署仍受 §3 部署阻断项约束（存量账号须先迁移），且部署前要把 `canvas-runs/` 加进 `scripts/backup.sh` 白名单。
2. D 切片二起（run 级总预算预留、运行中人工审批门、改图 stale/复用语义）与 E（Harness 放行）、F（视频模式 UI）、G（支付网关）、H、I 按文档建议不同时开工，未批准不实施；G 的支付/退款 unknown 态与 PaymentOrder/webhook 仍未动。
3. R07 的兼容窗口：升级前创建的任务没有 `job.json.idempotency` 字段，映射文件丢失时无法从索引找回——窗口是映射的 24h TTL，期内文件命中路径仍按旧语义放行。
4. 生产配置、备份与 ECS 快照核实、Harness 质量校准和移动端完整体验按后续授权另排；本轮未做生产操作或真实上游验收。
