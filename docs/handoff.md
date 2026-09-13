# 会话交接 — Genius（原 流光 · Lumen）

新会话从这里开始，再按需读 `AGENTS.md`（规则与约定）、`docs/design.md`（后端 as-built）、`DESIGN.md`（UI 规格）、`docs/runbook.md`（运维操作）。历史决策与逐轮变更记录不在本文——查 `git log` 与 `docs/plan-*.md`（顶部「状态」行标了现状，正文是历史方案，不再维护）。

## 0. 当前状态

本轮核对日期：2026-09-13。下列信息为部署后实测。

| 字段 | 值 |
| --- | --- |
| 基线 | `main` @ `545580f`（**已部署生产 2026-09-13，已推送 origin，公网冒烟通过**）。内容：E1+E2 Harness 供应商无关化（`02163a0` 去 xAI 路由层/长片走 ORDER/Director·QC 走 agent LLM，`bb22d75` 三视图角色表 + `supportsImageReference` + 档A 每镜首帧 + `/images/edits` 开关）+ 验收暴露的六处代码修复（`upstreamRejected` 结构化 5xx 判确定失败、`minimax-h3` 默认名与价目、`upstream_model_missing` 告警、`HARNESS_LLM_TIMEOUT_MS`、`llm_upstream_failed`、`harnessSubmitEstimateUsd` 含图+LLM 预留）。此前部署基线 `16f145e` 之前还有 `98759a5`（`4690767` 智能体错误码拆分、`f6b8c88` 画布 DAG 审查修复）、`da0348c` H 包、`04efdce` R01–R09 + A–D 包 + 资金迁移 |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33 |
| 生产部署 | 已上线 `https://genius.homeaistack.online`（阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service` 以 root 运行，反代借用同机 taiyu 的 Caddy 容器终结 TLS）；当前 45 个任务、6 个账号（含验收专用 `acceptance-20260913@lumen.test`） |
| 生产 provider 配置 | `VIDEO_PROVIDER_ORDER=kling,yman,grok`、`IMAGE_PROVIDER_ORDER=openai,yman`、`AGENT_BASE_URL=https://ccgoai.club/v1`、`AGENT_CHAT_MODEL=gpt-5.6-luna`（2026-09-13 起；ccgoai 已下架 `gpt-5.4-mini`）；`OPENAI_BASE_URL=https://ccgoai.club/v1`、`OPENAI_IMAGE_MODEL=gpt-image-2`、`OPENAI_IMAGE_QUALITY=medium`（ccgoai 对 `high` 一律 503 `service_busy`）、`OPENAI_IMAGE_FLEXIBLE_SIZES=1`、`YMAN_T2V_MODEL=minimax-h3`、`YMAN_I2V_MODEL=minimax-h3-933-图文`（YMan 已下架 `minimax-H3 文字`，旧名降级为目录别名）、`KLING_BASE_URL=https://api-singapore.klingai.com`、`KLING_VIDEO_MODEL=kling-2.6`、`KLING_USD_PER_UNIT=0.10`、`USD_CNY_RATE=7.2`、`YMAN_BASE_URL=https://vip.yman.cc/v1`、`HARNESS_ENABLED=true`、`OPENAI_IMAGE_EDITS_ENABLED=true`（档 A）；Director / 视觉 QC 超时走 `HARNESS_LLM_TIMEOUT_MS`（默认 120s，生产未显式设）；无 `LUMEN_PRODUCTS`（已撤，代码默认即 `minimax-h3`）、无 `UPSTREAM_TIMEOUT_MS`（走默认 30s）；**未配 `XAI_API_KEY`**——grok 排在 ORDER 尾部但无 key，不会被选中 |
| 生产订阅价格 | 标准 ¥19.1 / 专业 ¥49.6 / 尊享 ¥106.8 / 至尊 ¥170.3（月费，`costRatio` 按当前 provider 配置算出，非固定值，见 §2） |
| 门禁 | `545580f` 上实跑：`pnpm exec tsc --noEmit` 0 错 / `pnpm exec eslint src` 0 错 / `pnpm exec vitest run` 99 文件、1185 通过、1 skip、0 失败；e2e 最近一次全量是 `f6b8c88`（`E2E_PORT=3100 E2E_ISOLATED=1`，33 通过 0 失败），本轮未跑 e2e |
| 本地运行 | `pnpm dev` → `http://localhost:3000`（**用 `localhost`，`127.0.0.1` 会被 Next 16 dev 403**）；无任何生图/视频 key 时整实例回落 mock 模式（ffmpeg 水印片）；未登录访问任意路由 307 到 `/login`，注册需一次性邀请码（`node scripts/mint-invites.mjs N --note "..."`） |
| 账号与余额 | 注册即送 ¥5（`SIGNUP_BONUS_CNY` 常量，`src/lib/users/service.ts`，流水 `ref:"signup"`，非环境变量）；更多余额靠管理员 `node scripts/grant-balance.mjs <邮箱> <金额> --offline [--ref 键] [--note "..."]` 充值，或用户在订阅页兑换礼品码（`node scripts/mint-gift-codes.mjs <数量> <金额>` 铸码）；每种任务定价 × 余额是主闸门，日配额只是防滥用兜底（`FREE_DAILY_IMAGE_QUOTA` 默认 200） |
| 首次部署 / 迁移新数据目录前必做 | `cp -r data-seed/templates data/templates`（创作模板种子不随代码自动生成，见 §2「模板」） |

## 1. 系统地图

### 1.1 前端：侧栏 + 五视图（`docs/design.md` §6、`DESIGN.md` 全文）

- 路由 `src/app/(shell)/`：`layout.tsx`（服务端校验会话、下发 provider 能力）+ `page.tsx`（主页）/`create/page.tsx`/`agent/page.tsx`/`canvas/page.tsx`/`subscription/page.tsx`/`account/page.tsx`（账户页，不进侧栏，入口在头像菜单），共享同一个 `GeniusShell`。
- 组件 `src/components/genius/`：`GeniusShell.tsx`/`ShellContext.tsx`（唯一客户端状态所有者 `useShell()`）/`Sidebar.tsx`/`TopBar.tsx`/`LanguageSwitch.tsx`/`icons.tsx`/`composer/`（悬浮创作面板）/`home/`（瀑布流）/`create/`/`agent/`/`canvas/`/`subscription/`/`account/`。
- 样式：`src/app/globals.css`（壳 + 主页 + 创作面板 + 创作页 + 登录页）+ `src/app/styles/{agent,canvas,subscription,account}.css`。BEM + `data-*` 状态，不用 Tailwind / 组件库。
- 浏览器只经 `src/lib/client/*`（`jobs.ts`/`auth.ts`/`useJobLive.ts`/`useEvents.ts`/`notifications.ts`/`http.ts`）访问 `/api/*`；401 整页跳 `/login`。
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
| Harness 一致性管线（30/45/60s，生产已开，可灵 30s 已实证） | `src/lib/harness/` | §7 |
| ffmpeg | `src/lib/ffmpeg.ts` | §10 |
| HTTP API 全表 | `src/app/api/**/route.ts` | §4 |

### 1.3 数据落盘（完整清单见 `docs/design.md` §5）

`data/{jobs/index.json 派生缓存, jobs/{id}/job.json 事实源, users/, invites/, gift-codes/, ledger/<userId>.jsonl, agent/<userId>/<sessionId>.json, canvases/<userId>/<canvasId>.json, canvas-runs/<userId>/<runId>.json, notifications/<userId>.json, templates/*.json, tmp/, idempotency/}`；生产另有 `/opt/genius/backups/*.tgz`（`scripts/backup.sh`，白名单含 canvases/、canvas-runs/ 与 notifications/）与阿里云 ECS 自动快照两层备份。

### 1.4 环境变量分组（权威源 `src/lib/env.ts`，说明见 `.env.example`）

上游选择与路由：`XAI_API_KEY`/`SUB2API_API_KEY`/`XAI_BASE_URL`、`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_IMAGE_*`、`KLING_API_KEY`/`KLING_*`、`YMAN_API_KEY`/`YMAN_*`、`VIDEO_PROVIDER_ORDER`/`IMAGE_PROVIDER_ORDER`（含旧开关 `VIDEO_PROVIDER` 兼容）、`PROVIDER_EXHAUSTED_TTL_MS`、`USD_CNY_RATE`、`LUMEN_PRODUCTS`、`LUMEN_FORCE_MOCK`。计费与配额：`LUMEN_PRICE_TABLE`、`FREE_DAILY_IMAGE_QUOTA`、`FREE_DAILY_FAILURE_LIMIT`、`DATA_RETENTION_DAYS`、`MAX_QUEUED_JOBS(_PER_USER)`。用户系统：`LUMEN_SESSION_SECRET`（必填）、`LUMEN_ADMIN_USER_ID`、`SHARE_TTL_HOURS`。智能体：`AGENT_API_KEY`/`AGENT_BASE_URL`/`AGENT_CHAT_MODEL`。运维告警：`ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_TIMEOUT_MS`。其余：`DATA_DIR`、`JOB_CONCURRENCY`、`UPSTREAM_*`、`HARNESS_*`。

## 2. 已实现能力（按产品面）

- **创作**：文生视频 / 图生视频 / 文生图三条真实路径，创作面板另有「参考」（`reference_to_video`，产品声明该能力时可用——yman 声明支持）与首尾帧（仅可灵声明 `supportsLastFrameLock`）；「编辑 / 延长」等其余模式行渲染但置灰（`edit_video`/`extend_video` 只有 grok 声明支持，生产未配 XAI key 时提交会 503 `no_provider_available`）；`POST /api/jobs` 可选 `model`（产品 id，见 `GET /api/models`）；时长 / 画幅 / 分辨率 / 有声档由服务端按 provider 能力下发；数量 1–4（串行创建 N 条任务）；素材复用（`POST /api/uploads/from-job`）；首尾帧仅可灵支持；**长视频 30/45/60 秒一致性管线已开放**（`HARNESS_ENABLED=true` 生产已开，按 i2v+t2v 能力走 `VIDEO_PROVIDER_ORDER`，可灵 / YMan 都能接，可灵 30s 成片已实证）。
- **作品管理**：`GET /api/jobs?before&limit&kind` 游标分页；标签编辑（`PATCH`）、删除（`DELETE`，终态限定）；分享令牌 `POST /api/jobs/:id/share` → `/s/<token>`（公开只读页 + 媒体）。**通知（H 包）**：任务「非终态→终态」边沿在 `updateJob` 里落 `data/notifications/<userId>.json`（best-effort，`${jobId}:${status}` 幂等，≤200 条，`epoch` 代际）；`GET /api/notifications` 全量 + `POST /api/notifications/read`（带 epoch，不符 409 `notifications_stale`）；`GET /api/events` SSE 仍只做即时提醒，`ShellContext.syncNotifications` 在挂载/SSE open（含重连）/回前台/终态边沿后四处全量对齐，刷新与断线期间不漏；铃铛面板仍只渲染 10 条，打开=全部已读。画布 run 与智能体轮次暂不入通知索引（`kind` 已预留）。
- **模板**：`GET /api/templates` 读 `data/templates/*.json`，首次部署需手动 `cp -r data-seed/templates data/templates`（六条示例种子）。
- **账号与余额**：邮箱 + 密码 + 一次性邀请码注册；改密（`POST /api/auth/password`，旧会话失效）；**账户页 `/account`（H 包）**：邮箱/注册时间（`/api/me` 增 `createdAt`）/语言切换、两池余额与订阅摘要（「查看流水」跳 `/subscription#ledger` 自动开抽屉）、改密入口与「退出全部设备」（`POST /api/auth/logout-all`，`sessionEpoch+1` 全端下线）；管理 CLI 封禁/解封（`disable-user.mjs`）、重置密码（`reset-password.mjs`）、充值（`grant-balance.mjs`，工作区起均须 `--offline`，充值可带 `--ref` 固定幂等键）、铸邀请码/礼品码（`mint-invites.mjs`/`mint-gift-codes.mjs`）、用量对账（`usage.mjs`）；礼品码自助兑换 `POST /api/me/redeem`；积分流水 `GET /api/me/ledger`；注册赠 ¥5；准入闸门 = 余额 − 在途预留 ≥ 本次售价（§2d），配额与止损阀降级为防滥用兜底。**工作区新资金模型**：`user.json.billing`（legacyLedger + opening + 自校验 operations 链）与两池余额同一次原子写提交，jsonl 成为派生导出物，篡改/不一致即 `billing_export_corrupt` 失败关闭；幂等重放须同键同输入（撞不同输入 409 `billing_idempotency_conflict`）；协议见 `src/lib/billing/{protocol,file-ledger}.mjs` 与 `docs/design.md` §2d。
- **订阅与会员积分池**：四档（标准/专业/尊享/至尊），月费按 `成本 ÷ (1−15%毛利率)` 算出，年费 = 12×月费不打折；会员积分独立池，到期清零、跨期重置、按日发放（`assertBalance` 准入前先惰性结算，跨期旧积分不进可用额）；只能用已购余额购买（硬约束，防套利）；`GET/POST /api/subscription`。`purchaseSubscription` 为外层 `withAdmissionLock`、内层 `withUserLock`；扣款行带订单快照，「已扣款、订阅记录缺失」按快照补建不二次扣款。
- **智能体**：真实 LLM 编排（生产走 `AGENT_BASE_URL=ccgoai.club`），一轮 ¥0.05；**默认批准制**——LLM 产出报价提案（含每条价格快照与 30 分钟有效期），`POST .../turns/:turnId/approve` 才建任务（`createJob` 同链路、幂等 key `agent:<turnId>:<i>`），`/reject` 不建不退；Turn 状态机随会话文件落盘，`turnId`+`requestHash` 重放语义（同参交回、异参 409、thinking 续跑、陈旧 thinking 惰性退款）；会话预算 `budget`（402 `budget_exhausted`）；action 可带 `imageRef.uploadId`（图生视频）；技能可声明 `kinds` 过滤越界动作；回复语言随 `lumen_locale`。
- **画布**（2026-09-11/12）：`/canvas` 接真实后端——文档落 `data/canvases/`、`expectedRevision` 409 乐观并发；四类节点（文本/素材/文生图/生成视频），`POST .../nodes/:nodeId/run` 走 `createJob`（素材或上游文生图产物喂入即 `image_to_video`）；前端右键建节点、拖拽、防抖落盘、刷新恢复。**整图运行（D 包）**：`POST /api/canvases/:id/quotes` 确定性报价（不落盘，`quoteHash` 重算比对，图变即 409 `quote_stale`）→ `POST /api/canvas-runs` 冻结图建 run → sweep 泵按依赖经 `createJob` 逐节点提交（子任务幂等键 `run:<runId>:<nodeId>:<attempt>`，提交前先 `lookupIdempotency` 查回接管，素材一律复制不消耗原件）；`cancelRequestedAt` 持久化取消意图，停提交、在途走既有 job cancel、全终态落 `canceled`；run 不回写画布文档，前端用最新 run 的执行位 overlay 产物；价变即节点 `failed`/`price_changed` 不按新价扣款。**切片二**：确认报价即把总价冻结成 `run.reservation`（分池口径同 `reserveJobFunds`，「建 run 成功 = 全程钱够」），子任务经 `createJob` 的 `reserveFunds` 回调从 run 台账转移份额（恰好计一次：remaining → transfer(job 缺失兜底) → `job.reservation`），run 终态余量自动停计；审批门 `approvalNodeIds` → 节点 `awaiting_approval` 停住，`POST .../approvals` 批准才提交、驳回 `blocked` 传播下游；`nodeInputHash` 内容寻址复用——同输入历史产物在盘上即 ¥0 采纳，已清则 `blocked`/`output_purged` 不悄悄重生成，`regenerate` 点名沿下游闭包展开强制重跑。**超时收敛（2026-09-13）**：`awaiting_approval` 记 `awaitingSince`，24h 未决收敛 `blocked`/`approval_timeout`（超时后 approvals 端点也拒收决策）；`queue_full` 退避记 `queueWaitSince`，1h 收敛 `blocked`/`queue_timeout` 并清 `nextAttemptAt`——两者都不建 job、份额留在 remaining，run 终态自动停计。**保存冲突二选一（同日）**：PATCH 409 不再静默刷成服务端版，前端弹层展示「本地（未保存）/ 服务端」两份摘要，用户选「保留本地并覆盖」或「采用服务端」，严格模态：只能点两个按钮关，Esc/点外层无动作。详见 `docs/design.md` §2j。
- **多语言**：`zh-CN`/`en` 两语，Cookie `lumen_locale` + `Accept-Language` 兜底，顶栏与登录页可切换。**错误文案按码本地化（H 包）**：`errorText(t, e)` 把 `ApiError.code` 映射到 `common.err.<code>`；`error-codes.test.ts` 扫源码保证每个服务端错误码都有键；未知码/非 ApiError 落 `common.err.unknown` 带 `x-request-id`；服务端 `message` 仍是中文（日志/CLI 依赖，不上屏）。
- **稳态与安全**：任务索引（`data/jobs/index.json`）取代全表扫描；上游轮询阶梯 2s→5s→10s；`uncertain_submit` 拦一键重试（崩溃恢复与运行期模糊提交两条路径都会打上这个标记，见 §3）；429/quota 指数退避；provider 积分耗尽自动换家（售价只降不升，一家都不剩时 503 而非静默落 mock）；限流（提交 10 次/分钟、上传 5 次/分钟、单账号在途任务数上限）；`/api/health` 分级下发（匿名只回 `{ok}`）；`x-request-id` 全链路追踪；CSRF 意义上的 Origin/Referer 校验（两者都缺失时放行，已记录的设计取舍）；CI（`tsc`/`eslint`/`test`，不含 e2e）。

## 3. 已知限制 / 未做

- **资金与执行恢复缺陷索引**（证据与历史复现见 `docs/review-2026-09-08.md`）：R01–R09 均已在工作区修复——R01 余额+流水同一原子写（`e564ab6`）；R02 Agent 退款经 `refundOf` 按原扣款的 `memberCny` 拆回原池；R03 订阅购买外层 admission 锁；R04 扣款行带订单快照（planId/cycle/priceCny/orderedAt），「已扣款、订阅记录缺失」按快照补建且不再判余额，同 key 异参 409；R05 `assertBalance` 先惰性结算再判可用额，跨期旧积分不再进 `availableCny`；R06 submit 的 5xx/超时/断连算「结果不确定」，先 `lookupByExternalId` 查回接管，查不到则 `failed`+`uncertain_submit` 锁死重试；R07 幂等键与请求哈希落 `job.json`（事实源），`data/idempotency/*.json` 降级为可重建缓存（原子写、命中回读校验、miss 从任务索引重建），同 key 异参 409 `idempotency_conflict`；R08 请求体加 `turnId`，同 turnId 重放原样交回、换文本 409、已退款轮次同键重发 409；R09 产物字节已 checkpoint（persisting / localOutputPath / remoteUrl）时取消不再成立，终态由 persist 落盘结算。2026-09-13 真实上游验收已过一轮（`docs/acceptance-2026-09-13.md`）。
- **新资金模型已完成迁移**（2026-09-12 随本次部署）：4 个存量账号逐账号基线迁移完成（全部入账行归 purchased 池——迁移前无会员积分池与订阅；迁移前后双 sha256 校验 + 流水重放余额一致才落盘；快照备份在服务器 `/opt/genius/data.bak.20260912-150535`、基线文件在 `/opt/genius/migrate-baselines/`）。新注册账号首次写盘即自带快照。注意：`data.bak.*` 与 `migrate-baselines/` 是迁移留痕，备份白名单不含它们，可择机清理。
- **未实装计划（A–C `1f3077f`、D 两切片 `b91df6c`+`d38dc05`、H 包均已提交）**：`docs/plan-unimplemented-2026-09-08.md` 于 2026-09-09 经 Codex 评审为 `VERDICT: BLOCK`，用户随后逐项拍板实施：A 显式 Reservation（`job.reservation` earmark + 恢复中心 `recovery/reconcile/resume` + 创作页「核验上游」入口）；B 智能体 Turn 状态机 + 默认批准制提案 + 会话预算 + `imageRef` + 技能 `kinds` + locale 回复；C 画布持久化 + revision 409 + 四类节点接 `createJob`；D 画布 DAG 运行两切片（`docs/plan-dag-canvas-run-2026-09-12.md` + `docs/plan-dag-run-slice2-2026-09-12.md`）；H 账号与通知（`docs/plan-h-account-notifications-2026-09-12.md`，Codex 评审 6 条 finding 修订后实施：通知落盘、错误码本地化、账户页、移动端回归）。E（Harness 长片放行）已完成并在生产实证；其余 F/G/I/J（视频模式 UI、支付网关、运维扩容等）仍未实施。
- 生产未配 `XAI_API_KEY`：`edit_video`/`extend_video` 目前只有 grok 声明支持，ORDER 内没有可用 provider 承接这两条，提交返 503 `no_provider_available`。
- Harness（30/45/60 秒一致性管线）已供应商无关且生产开放（`HARNESS_ENABLED=true`，`OPENAI_IMAGE_EDITS_ENABLED=true`，档 A 三视图 + 每镜首帧已实证，可灵 `job_fb97db94e2a4` 30.97s 成片）；视觉 QC 阈值未经 `evals/runs` 校准，默认跳过。**未验**：YMan 上的长片（档 B：r2v 参考图）。**待决定价**：长片售价 ¥12，上游实付 $1.45 ≈ ¥10.4，毛利约 ¥1.6——是否调价待定。
- 服务端 API 错误 `message` 仍是中文（日志/CLI 依赖）；用户可见文案已按码本地化（H 包），仅上游透传原文与「参数细节在 message 里」的三个码（`invalid_argument`/`invalid_state`/`conflict`）会在英文界面露出中文后半段，属明示的服务端细节。
- 无支付网关，已购余额只能靠礼品码或管理员 CLI 充值，订阅收入是内部记账而非真实收款（`docs/runbook.md`「订阅对账」）。
- 智能体依赖单独配置的 `AGENT_API_KEY`/`AGENT_BASE_URL`（生产已配 ccgoai `gpt-5.6-luna`；只出图/视频的中转 key 没有对话模型，不能复用）；会话与画布无留存清理（会话每人上限 200）。
- `data/jobs/*/job.json` 是事实源、`index.json` 是可重建缓存；`hasChargeFor`/幂等扣款全量扫流水文件，未建索引，内测规模无感。
- `scripts/grant-balance.mjs`/其余管理 CLI 与线上服务无跨进程锁，操作前后建议核对 `data/ledger/<userId>.jsonl`。
- 生产 crontab 已有每日 03:17 的 `scripts/backup.sh`（2026-09-07 核实，`/opt/genius/backups/` 已有两份）；阿里云 ECS 自动快照策略只能在控制台看，SSH 核实不了，未确认。
- 移动端已过一轮 e2e 回归（`e2e/mobile.spec.ts`，375/390/768 三档跑通六视图主要路径，修掉规格弹层/智能体两列/画布报价层越界与 Esc 收层缺失）；**软键盘遮挡未验证**（Playwright 模拟不了，需真机 iOS Safari / Android Chrome 验收）。
- **画布 DAG 运行审查（2026-09-12，只读审查 11 条 finding）**：9 条已修——其中 (a) 保存 409 与 (c) 审批/排队无超时两条已按产品拍板落地（2026-09-13：409 弹层二选一保留本地副本；审批 24h `approval_timeout`、排队 1h `queue_timeout` 收敛 blocked，预留随 run 终态释放）。剩 2 条未采纳、留待产品决策：(b) `validateGraph` 校验所有 material 节点均含未连线者，一个游离空素材节点会让整图报价 400；(d) 每次准入（createJob/retryJob/createCanvasRun/settleSubscription）都 strict 读该用户全部 run 文件，run 文件只增不删，IO 随时间线性增长，内测规模无感。

## 4. 运维与部署

完整操作手册见 `docs/runbook.md`：部署（`bash scripts/deploy.sh`，含自动回滚）、手动回滚、key 轮换、备份恢复（`scripts/backup-restore.md`）、磁盘告警处理、provider 耗尽处理、用户禁用/重置密码、礼品码铸造、智能体不可用排查、订阅对账。部署打包与跨平台踩坑细节（Turbopack 别名软链、`output: "standalone"` 为何不可用）见 `docs/design.md` §10.1。管理 CLI 一律以 root/sudo 在服务器执行（`genius.service` 以 root 运行，`data/` 整棵树归 root）。

## 5. 下一刀建议

1. 下一阶段计划见 `docs/plan-next-2026-09-13.md`（以它为准）。
2. `bash scripts/deploy.sh` 在本机 Git Bash（`/usr/bin/bash`，GNU bash 5.3）已连续跑通到 `545580f`：本地 tsc → `pnpm build` → ~18M 包 → 上传 → 服务器切换，两个 Turbopack 别名（sharp / ffmpeg-static）自动补软链，`systemctl is-active genius` = active，本机 health 200 ok=true，未触发回滚。脚本末尾的公网检查请求 `/login`（匿名可访问、预期 200；`/` 未登录会 307 跳登录页，不作判定对象）。此前踩过的打包坑（`src/lib/billing/*.mjs` 不在包内、Windows junction 被解引用、`*.sh` CRLF）均已在脚本与 `.gitattributes` 里修掉，未复现。
3. R07 的兼容窗口：升级前创建的任务没有 `job.json.idempotency` 字段，映射文件丢失时无法从索引找回——窗口是映射的 24h TTL，期内文件命中路径仍按旧语义放行。
4. 画布审查未采纳的 2 条（游离空素材节点致整图 400、run 文件线性增长）见 §3，需产品决策后再排。独立审查清单在 `docs/review-2026-09-13.md`（其中「真实上游验收未做」已由 `docs/acceptance-2026-09-13.md` 取代）。
5. **验收遗留**：YMan 上的长片（档 B：r2v 参考图）未验；画布 DAG 未经 UI 走真实上游；`minimax-h3` 积分价目沿用旧档、未经账单核实（catalog.ts 注释已标）。
6. `edit_video`/`extend_video` 待有中转站承接（当前只有 grok 声明，生产无 XAI key，提交 503）。
