# 全仓审查报告 — 2026-09-13

基线：`main` @ `dbead84`（`origin/main` 同步）。审查在隔离 worktree `D:\dev\repos\VideoPlatFrom-review-dbead84` 上完成，主工作区未被触碰（审查期间另一会话正在主工作区提交 N3.4 治理切片，见 §1.3）。配套文档：设计计划书 `docs/plan-repo-optimization-2026-09.md`。

本文只写核对过的事实与标明的推断；「已验证」= 有命令输出 / 文件行号可复现，「推断」= 从代码读出但未在运行态复现。

## 0. 结论先行

| 维度 | 评级 | 一句话 |
| --- | --- | --- |
| 资金一致性 / 幂等 / 崩溃恢复 | **强** | 原子写 + 进程内锁序 + 自校验操作链 + 同 key 幂等，R01–R09 修复有回归用例，是全仓最扎实的部分 |
| 安全基线 | **强** | scrypt + 计时均衡、HMAC 会话 + epoch、owner 404 不可探测、安全 id 正则、`private, no-cache`、Origin 校验 |
| Provider 抽象 | **良** | 能力 + 优先级路由、注册表、relay 工厂（N3.1–N3.3 已提交）；硬编码分支仍有 `kling`/`grok` 专属 |
| 测试 | **良** | 102 文件 / 1213 单测全绿、35 条 e2e 中 34 通过（1 条不稳定）；evals 质量评分记录为零 |
| **门禁 / CI** | **差** | CI 自建立以来 37/37 全红（干净检出缺 `next typegen`），本地绿掩盖了它；生产部署脚本只跑 tsc |
| 数据层 / 运维 | **中** | JSON 文件 + 单实例可用，但备份同机无异地、CLI 无跨进程锁、准入 IO 线性增长；`relays.json` 未进备份 |
| 前端结构 | **中** | 功能齐全、e2e 覆盖好；`ShellContext` 上帝上下文（1561 行、~90 字段、无 memo、13 消费者） |
| 文档 | **良-** | as-built 文档详尽，但 handoff 基线漂移、`AGENTS.md` 31KB 在工具里被截半、历史 / 现行文档无索引 |

**三条必须先做的事（P0）**：① CI Typecheck 步补 `next typegen`；② `backup.sh` 白名单补 `data/relays.json`；③ 画布素材节点引用的 `data/tmp/` 上传会被 24h 清理，素材需要独立留存。

## 1. 审查范围与方法

### 1.1 覆盖面

| 单元 | 方法 | 结果 |
| --- | --- | --- |
| 仓库结构 / 规模 | 文件清点 | 409 个 ts/tsx/mjs/css，约 7.3 万行（含空行；统计脚本跳过了 30 个 `[id]` 动态段路由文件，实际略多）；非测试 TS 277 文件 / 约 3.76 万行；单测 102 文件；e2e 7 文件 32 条定义 / 35 次运行；104 次提交，首提交 2026-08-28 |
| 门禁（干净检出） | `pnpm install --offline` → tsc / eslint / vitest / e2e | 见 §2 |
| CI 历史 | `gh run list --limit 60` + `gh run view --log-failed` | 见 §2.2 |
| 后端核心 | 通读 `proxy.ts`、`jobs/{store,admission,upload,sweep}.ts`、`billing/admission.ts`、`users/{store,session-token,password,rate-limit,lock}.ts`、`providers/{router,health}.ts`、`providers/relay/manage.ts`、`storage/*`、`alerts.ts`、`log.ts`、`env.ts`、`instrumentation.ts`、`api/health`、`api/auth/login`、`api/uploads/[id]` | §3、§4 |
| 前端 | `ShellContext.tsx` 结构扫描（导出 / hook / value 组装）、`CanvasView.tsx` 素材路径、`globals.css` 头部 | §4.4 |
| 运维脚本 | `scripts/deploy.sh`、`scripts/backup.sh`、`.github/workflows/ci.yml` | §4.6 |
| 文档 | `AGENTS.md`、`README.md`、`docs/handoff.md`、`docs/design.md` 目录、`docs/plan*.md`、`docs/review-2026-09-13.md`、`evals/README.md` | §4.7 |
| 依赖 | `package.json`、`openai` / `tailwindcss` 实际引用点 | §4.8 |

**未覆盖**（不在本次断言范围）：`runner.ts` / `orchestrator.ts` / `dag.ts` 逐行逻辑（只看结构，依赖既有单测与 `docs/review-2026-09-08.md`、`review-2026-09-13.md` 的专项审查）；生产服务器状态（未 SSH，`MemoryMax`、Caddyfile、ECS 快照均为文档转述）；真实上游行为。

### 1.2 SureForge 记录

- 档位：Standard；独立审查：`self-review-only`（未授权子代理）。
- 契约：用户要求「审查和优化整个仓库，给出审查报告与完整设计计划书」；2026-09-13 追加决定——只写报告不改代码、落 `docs/` 新文件、路线**从零重排**、数据层给分阶段方案。
- 本文每条 finding 用两种互补方法核对：(a) 定位到文件行号或命令输出；(b) 与项目文档的自述交叉比对（一致 / 冲突分别标注）。

### 1.3 审查期间的并发会话（重要背景）

审查开始时 `git status` 干净；数分钟后主工作区出现未提交改动：`src/lib/providers/{health.ts(新增), exhaustion.ts, router.ts, types.ts, relay/client.ts}`、`src/lib/alerts.ts`，文件 mtime 与当时系统时间相差不到 1 分钟，且中途 `tsc` 报过 `health.ts(256,9) relay_unhealthy 不在 AlertEvent` 错误（随后 `alerts.ts` 已补该枚举）。判断：另一个会话正在实施 `plan-relay-provider` §4c / 切片 N3.4。因此：

- 本文所有代码事实以 **`dbead84` 提交态**为准，工作树中的进行中改动不作评价；
- 设计计划书里 N3.4 记为「进行中，非本计划排期对象」。

## 2. 门禁实测（`dbead84`，干净 worktree）

### 2.1 本地

| 命令 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm exec tsc --noEmit`（无 `.next/`） | **失败** `src/app/layout.tsx(19,56): Cannot find name 'LayoutProps'` | `LayoutProps` 是 Next 16 生成到 `.next/types/routes.d.ts:108` 的全局类型，`tsconfig.json` 靠 include `.next/types/**/*.ts` 拿到它；干净检出没有 |
| `pnpm exec next typegen && pnpm exec tsc --noEmit` | **0 错** | Next 文档 `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md:177-183` 明写 CI 用法 `next typegen && tsc --noEmit` |
| `pnpm exec eslint src` | 0 错 0 警 | |
| `pnpm exec vitest run` | **102 文件全过，1213 通过 / 1 跳过**，207s | 首跑 17 失败是我 `--ignore-scripts` 安装导致 `ffmpeg-static` 缺二进制，补上后全绿——不是代码问题 |
| `E2E_PORT=3177 E2E_ISOLATED=1 E2E_REQUIRE_MOCK=1 pnpm e2e` | **34 通过 / 1 失败**，4.2 分钟 | 失败：`e2e/canvas.spec.ts:48` 双标签页 409 冲突弹层 `.canvas-conflict` 未出现；单独重跑该用例首次通过（第二次 `--repeat-each` 因共享画布残留节点在 `toHaveCount` 上失败，属重复运行污染）。**判定：不稳定用例，非已证实的功能回归**。该用例由 `a019c39` 引入，`docs/handoff.md` 记录的最后一次全量 e2e 是更早的 `f6b8c88`，即它从未出现在记录在案的全量绿里 |

### 2.2 CI（GitHub Actions `.github/workflows/ci.yml`）

`gh run list --limit 60`：自 2026-09-06 首次运行到 `dbead84`，**37 次运行 36 失败 1 取消，没有一次成功**。最新一次（run `34741400988`）失败步骤 = Typecheck，日志 `src/app/layout.tsx(19,56): error TS2304: Cannot find name 'LayoutProps'`——与 §2.1 干净检出的现象完全相同。

含义：`AGENTS.md`「验证门禁」说 CI 跑与本地同样三条，但这条门从建立起就没有拦过任何东西，也没人发现——因为本地始终有 `next dev` 生成的 `.next/types`。`docs/review-2026-09-13.md` §3.1 与 `docs/handoff.md` §0 的「门禁绿」都是本地数字。

## 3. 问题总表

严重度：P0 = 正在造成或随时会造成损失 / 假绿；P1 = 下一批必须处理；P2 = 结构性技术债；P3 = 建议。

| # | 严重度 | 位置 | 事实（已验证除非标注） | 影响 | 修法要点 |
| --- | --- | --- | --- | --- | --- |
| F-01 | **P0** | `.github/workflows/ci.yml:39-40` | Typecheck 步直接 `tsc --noEmit`，干净检出缺 `LayoutProps`；37/37 次运行失败（§2.2） | 门禁形同虚设；任何真正的类型错误都会被淹没在同一条红里 | 改为 `pnpm exec next typegen && pnpm exec tsc --noEmit`（已在 worktree 验证 0 错）；`scripts/deploy.sh:44` 同理，本地无 `.next` 时也会假失败 |
| F-02 | **P0** | `scripts/backup.sh:122-123` 白名单 | 不含 `relays.json`（N3.2 起为中转配置事实源，`docs/runbook.md:87` 明说「事实源是 data/relays.json」）；也不含 `relay-catalog/`（可重建，可不备）| 恢复后管理接口写入的全部中转配置消失，静默回落 env 预设，路由行为改变 | 白名单加 `relays.json`；顺带评估工作树 N3.4 新增的 `provider-health.json`（冷却状态，丢了只是提前恢复路由，可不备但要写进文档） |
| F-03 | **P0** | `src/lib/jobs/sweep.ts:6-7,31-47` × `src/lib/canvas/schema.ts:39-40` × `CanvasView.tsx:709` × `canvas/run.ts:53` / `dag.ts:409` / `graph.ts:150` | `sweepTmp` 删除 `data/tmp/` 下 mtime 超 24h 的一切文件、超 2GB 按最旧删；画布 `material` 节点只存 `uploadId` 指向 `data/tmp/<id>`，`docs/plan-dag-canvas-run-2026-09-12.md:61` 把「原件留在 data/tmp/ 可反复引用」当设计前提；`docs/design.md:380` 又写明 `tmp/{uploadId} # 24h TTL`。两处设计互相矛盾，无任何代码把画布引用的上传排除在清理外 | 画布素材节点建了超过 24 小时后：缩略图 404、`validateGraph` 400「上传文件不存在或已过期」、整图报价失败；用户看不到任何预警 | 素材需要独立留存：认领时把字节复制到 `data/assets/<userId>/<assetId>`（有自己的留存策略，H §9.4 已预留此项），画布节点改引 assetId；或最小修法 sidecar 加 `pinnedBy` 由 sweep 跳过 + 画布删节点时解 pin。两者都要迁移存量画布文档 |
| F-04 | P1 | `e2e/canvas.spec.ts:48` | 全量下失败、单跑通过（§2.1）；用例内两段共用同一画布与 600ms 防抖，`waitPatch` 只等响应不断言 409 | e2e 全量不可重复绿，等于没有 UI 门禁 | 每段用新建画布；`patchB` 断言状态 409；把「弹层未出」与「PATCH 未 409」拆成两条可诊断断言 |
| F-05 | P1 | `src/components/genius/ShellContext.tsx:343-1561` | 单个 Provider：40 个 `useState`、`value: Shell` 约 90 个字段在 L1466 每次渲染新建对象（无 `useMemo`），L1560 直接 `<Ctx.Provider value={value}>`；13 个组件 `useShell()`（HomeView 瀑布流、CanvasView 1005 行、TopBar、Composer 全家） | 任一字段变化（含提示词每次击键、SSE 每条进度）触发全部消费者重渲。是否产生可感知卡顿**未量化**（推断），但结构上它是前端性能与可维护性的单点 | 先 React Profiler 量化；按域拆 Provider（session / jobs / composer / notices），`useShell()` 保留为聚合兼容层逐步下线；或 `useSyncExternalStore` 小 store + 选择器（不引新依赖） |
| F-06 | P1 | `scripts/deploy.sh:44,49-64,126` | 从**当前工作树**构建（非 `git archive <sha>`），产物不含 commit 标识；`--skip-check` 可跳过 tsc；只跑 tsc 不跑 eslint / vitest；服务器 `pnpm install --prod --no-frozen-lockfile` | 「生产 = 某 commit」靠人记（`handoff` §0 的基线行就是这么写的，且已漂移，见 F-08）；未提交改动可能被部署 | 构建输入改为 `git archive HEAD` 到临时目录；产物写 `BUILD_INFO.json {sha, builtAt}` 并由登录态 `/api/health` 回显；三条门禁齐跑；`--frozen-lockfile` |
| F-07 | P1 | `scripts/backup.sh:29-31`；`docs/handoff.md:83` | 备份只落同机 `/opt/genius/backups`；ECS 自动快照「只能在控制台看，未确认」 | 磁盘 / 实例丢失 = 账号、两池余额、流水、礼品码全丢；备份是 tar，非一致性快照（`plan-unimplemented` §10 自己也指出） | 异地加密副本（OSS / 另一台机）+ 恢复演练脚本核对用户数、两池余额、`ref` 唯一；备份前短暂 drain 准入 |
| F-08 | P1 | `docs/handoff.md:11,16` | 基线仍写 `9e0441c`，HEAD 已是 `dbead84`（N3.1–N3.3 三个功能提交已推送）；门禁数字是 `545580f` 的；「e2e 最近一次全量 f6b8c88」 | 违反本仓库文档维护规则（只保留当前真实状态）；新会话会按错误基线判断「生产 = 代码」 | 改写 §0 表；把 §2.1 的门禁实测数字填进去 |
| F-09 | P1 | `src/lib/billing/admission.ts:68-73` → `canvas/run-store.ts`；`docs/handoff.md:81,85(d)` | 每次准入 strict 读该用户全部 run 文件（只增不删）；`hasChargeFor` / 幂等扣款全量扫流水（handoff §3 自述，未逐行核）；`jobs/index.json` 整文件重写（本地 ~100 任务已 56KB，`jobs/index.ts:48` `FLUSH_DEBOUNCE_MS=200` 合并写） | IO 随历史线性增长；内测规模无感（handoff 自述），但它决定了数据层什么时候必须动 | 见计划书 R4：先埋点准入耗时，再按触发条件分阶段 |
| F-10 | P1 | `scripts/*.mjs` × `src/lib/users/lock.ts` | 管理 CLI 与线上服务无跨进程锁，`--offline` 只是调用方声明（handoff §3 已记录） | 服务未停时充值 / 重置密码可能与请求交错写同一 `user.json`（原子写保证不撕裂，但会丢一方更新） | `data/.lock`（`O_EXCL` + pid + 心跳）让服务与 CLI 互斥，`--offline` 变成真校验；或 CLI 改走本机 admin 接口 |
| F-11 | P1 | `src/lib/providers/relay/manage.ts:68-104` | `createRelay` / `updateRelay` / `deleteRelay` 都是「读文件 → 改 → 写」且不持任何锁 | 两个管理请求并发会丢一方（单管理员场景概率低） | 套一把 relay 写锁（同 `withUserLock` 模式） |
| F-12 | P2 | `AGENTS.md`（86 行 / 31,468 字节） | 规则文件超过工具 16,384 字节截断线，本会话中第 40/49/50/57 行末尾被截、第 78 行后不可见；内容大半是 as-built 细节而非规则 | 每个 AI 会话都只读到一半规则（后端约定后半、验证门禁细节、PR 流程、安全、部署都在被截区） | 瘦身：只留「规则 + 指向」，细节回 `docs/design.md`；目标 ≤ 12KB |
| F-13 | P2 | 大文件（真实行数） | `globals.css` 2715、`ShellContext.tsx` 1561、`canvas/run-graph.test.ts` 1527、`styles/canvas.css` 1299、`styles/agent.css` 1246、`e2e/genius.spec.ts` 1223、`harness/orchestrator.ts` 1140、`jobs/runner.ts` 1125、`CanvasView.tsx` 1056 | 改动定位成本高、并发会话易冲突 | 按视图拆 CSS；`runner.ts` 拆 submit / poll / persist / failover 四段（函数边界已清晰：`submit` L672、`pollUntilDone` L802、`persist` L913、`switchAwayFromExhausted` L391）；`CanvasView` 拆节点卡 / 报价层 / 冲突弹层 |
| F-14 | P2 | `src/app/globals.css:1,17-21`、`postcss.config.mjs`、`package.json` | Tailwind v4 只被用于 `@import "tailwindcss"`（preflight）+ `@theme` 三个 token；仓库规则「不用 Tailwind 工具类」，全仓 0 处工具类（唯二疑似 `tpl-grid`/`sub-grid` 是 BEM 名） | 两个 devDependency + PostCSS 阶段只换来一段 reset；构建链多一层 | 决策项：换成手写 reset（几十行）删依赖，或保留并把理由写进 `DESIGN.md` |
| F-15 | P2 | `src/app/{gallery,studio,studio/[kind],jobs/[id]}/page.tsx` | 四个只做 `redirect("/")` 的页面 | 无害，但占路由与心智 | `next.config.ts` `redirects()` 一段配置替代 |
| F-16 | P2 | `evals/runs/` 仅 `.gitkeep`；`evals/README.md` 素材表 `character-*.jpg` ❌ 缺失；`HARNESS_QC_VISUAL_THRESHOLD` 未设默认跳过 | 产品卖点①「优化视频产出」至今没有一条可复现的质量评分记录，视觉 QC 从未校准 | 「一致性管线」的价值只有口头证据（一条可灵 30s 与一条 YMan 30s 成片） | 计划书 R3 提升为产品主线 |
| F-17 | P2 | `eslint.config.mjs` + `pnpm exec eslint src` | lint 只覆盖 `src/`；`e2e/`、`scripts/`（11 个 .mjs，含改 `user.json` 的资金 CLI）无 lint 无类型检查 | 运维脚本是最容易出错又最少被审的代码 | eslint 范围加 `e2e scripts`；`scripts/*.mjs` 加 `// @ts-check` 或迁 `.mts` |
| F-18 | P2 | `PRODUCT.md`、`IDEA.md`、`docs/architecture.md`（1256 行）、`docs/plan.md` | `PRODUCT.md` 主体仍是「放映厅 / Three.js」旧方向（附注说明已切换）；`IDEA.md` 一行；`architecture.md` 是 Phase 0 历史；README 只索引了部分 | 「哪些文档现行、哪些历史」无总表，新会话要靠 handoff 转述 | `docs/README.md` 一张索引表：现行（handoff / design / DESIGN / runbook / AGENTS）vs 历史（plan-*、review-*、architecture） |
| F-19 | P3 | `src/lib/users/rate-limit.ts:84-88` | `clientIp` 取 XFF 首跳 | 正确性依赖 Caddy 对不受信来源**覆盖**而非追加 XFF（Caddy ≥2.5 默认如此——**推断**，Caddyfile 未核） | runbook 记一条核对项 |
| F-20 | P3 | `src/proxy.ts:87-91` | Origin / Referer 双缺放行（已记录的取舍） | 现代浏览器对非 GET 必带 Origin；「带会话 Cookie 且双缺」这一组合基本只可能是非浏览器或被剥头的请求 | 可评估收紧为「带 Cookie 且双缺 → 403」，curl / 脚本本来就不带 Cookie（走 Bearer 或不鉴权路径） |
| F-21 | P3 | `package.json` `openai@^7.8` | 仅 `agent/llm.ts`、`harness/director.ts`、`harness/visual-qc.ts` 三处用于 chat；provider 层全部手写 fetch | 一致但不必要地引入大 SDK | 可接受，记录即可；若统一为 relay `chat` 通道时顺手用 fetch 替掉 |

## 4. 分维度评估

### 4.1 架构与数据层

- 形态：Next.js 16 单体，App Router + Route Handlers，`instrumentation.ts` 拉起进程内 runner / 画布泵；持久化全部是 `data/` 下 JSON（原子写 tmp+rename，`storage/atomic-json.ts`），派生索引启动重建（`jobs/index.ts`、`users/store.ts`）。四把进程内串行锁挂 `globalThis`（admission / user / job / run），锁序 admission → user 写进注释与 AGENTS。
- 判断：**单实例前提下设计自洽且防御充分**。所有「先写事实源再更新派生物」「先扣款再写终态」「幂等键落事实源」的顺序都有注释论证与用例。
- 结构性上限（不是缺陷，是边界）：① 只能单进程写（F-10）；② 跨实体写不是事务——`updateJob` 里扣款、写 job.json、更索引、写通知是四步，靠幂等 + 补偿收敛（有测试）；③ 索引 / 流水 / run 文件的读写随历史线性增长（F-09）；④ 备份是文件 tar 非快照（F-07）。数据层的分阶段方案见计划书 R4。

### 4.2 资金与一致性（强项，保护它）

`billing/admission.ts` 的预留 + 结算模型、`store.ts` 的先扣后写、`applyBalanceChange` 按 `jobId` 幂等、`refundOf` 按原扣款拆池、`protocol.mjs` 自校验操作链、订阅只能用已购池——这些约束在 AGENTS.md 与代码注释里反复钉死，并有 `reservation.test / ledger.test / subscription.test / run-graph.test` 覆盖。任何「优化」都不应触碰这些不变量；计划书把它们列为 R4 数据层迁移的验收基线（迁移前后余额与 `ref` 集合必须逐字节相等）。

### 4.3 安全

| 项 | 现状 | 评价 |
| --- | --- | --- |
| 口令 | scrypt N=2^14 自描述格式、参数上限防篡改 OOM、未知邮箱等时长 `burnPasswordTiming` | 好 |
| 会话 | HMAC-SHA256 + `sessionEpoch`，proxy 只做纯计算校验、handler 再查 `disabled/epoch` | 好；密钥缺失拒绝启动 |
| 越权 | 任务 / 上传 / 会话 / 画布一律 owner 校验，非本人 404 与不存在不可区分 | 好 |
| 路径 | `SAFE_ID_RE` + `resolveRel` 前缀判定 | 好 |
| CSRF | SameSite=Lax + Origin/Referer 同源校验 | 好；双缺放行是记录在案的取舍（F-20） |
| 限流 | 登录 / 注册 IP+邮箱双桶、提交 10/min、上传 5/min、单账号在途上限 | 好；进程内，重启清零（已知） |
| 媒体缓存 | `private, no-cache` + 弱 ETag | 好，AGENTS 有专门禁令 |
| 密钥 | 只在 `.env.local`（gitignore `.env*`）；relays.json 只存 env 变量名；health 匿名只回 `{ok}` | 好 |
| 运行身份 | 服务以 root 跑（handoff §4） | 建议专用用户 + `data/` 归属，属运维项 |

### 4.4 前端

- 结构清晰：`(shell)` 路由组 + `GeniusShell`，浏览器只经 `src/lib/client/*` 访问 API（规则被遵守），BEM + `data-*`，i18n 两语字典编译期校验。
- 问题集中在**状态所有权**：`ShellContext` 一个 Provider 承担账号、作品分页、创作面板草稿、上传槽、通知、toast 六类状态（F-05）。这是 2026-09-06 换壳时「唯一客户端状态所有者」原则的直接后果——原则本身没错，但实现成单对象后失去了细粒度订阅。
- `CanvasView.tsx` 1056 行含画布交互、节点渲染、报价弹层、冲突弹层、轮询；3 处 `eslint-disable react-hooks/exhaustive-deps`（L291/319/345）是 effect 依赖被手工绕开的信号（另 2 处是 `no-img-element`，无碍）。
- CSS：`globals.css` 2715 行覆盖壳 + 主页 + 面板 + 创作页 + 登录页，与四个视图文件并列——按视图拆到 `styles/` 与现有约定一致。

### 4.5 测试与质量保障

- 单测：1213 条，覆盖状态机、REST golden、路由、资金、幂等、崩溃恢复、i18n 键完整性（`error-codes.test.ts` 扫源码保证每个错误码有文案）。质量高。
- e2e：32 条定义（与 AGENTS 描述一致），mock 模式；1 条不稳定（F-04）；不在 CI。
- 缺口：① evals 无记录（F-16）；② 真实上游验收只有 `docs/acceptance-2026-09-13.md` 的人工记录，无自动冒烟（`smoke:live` 仍是 xAI 五模式，生产无 XAI key，README:68 自述会失败）；③ 并发 / 崩溃窗口类测试靠单测模拟，无故障注入的集成层。

### 4.6 运维与部署

- 部署：Windows 构建 → tar → 服务器 `pnpm install --prod` → 补 Turbopack 别名软链 → 健康检查失败自动回滚。脚本可靠性已被多次跑通验证；问题在**输入来源与可追溯**（F-06）。
- 备份：每日 03:17 同机 tar，白名单缺 relays.json（F-02），无异地（F-07），无恢复演练记录。
- 观测：结构化 JSON 日志 + `x-request-id` AsyncLocalStorage 贯穿；告警 `notifyAlert` 有去重，但 `ALERT_WEBHOOK_URL` 生产是否配置未知（`plan-next` N6 说「目前只写日志/文件——确认后接 webhook」）。
- 资源：2 核 / 1.8G，`JOB_CONCURRENCY=1`（design.md:505）× `HARNESS_SHOT_CONCURRENCY` 默认 2；sharp 已限 1 线程无缓存（`instrumentation.ts:36-47`）。长片 + 生图 + ffmpeg 拼接的峰值内存**未实测**（plan-next §4 自述）。

### 4.7 文档

- 优点：as-built `design.md` 章节齐、`runbook.md` 有操作清单、每个方案 `plan-*.md` 顶部标状态、审查 `review-*.md` 分实测 / 推断。
- 问题：F-08 基线漂移；F-12 AGENTS 超长被截；F-18 无现行 / 历史索引；`README.md:48-64` 把 provider 细节重复了一遍（与 design.md §2 重叠，两处都要维护）。

### 4.8 依赖与工具链

| 依赖 | 用途 | 评价 |
| --- | --- | --- |
| `next@16.3.3` / `react@19.2.8` | 框架 | 版本钉死，好 |
| `zod@^4` | 全部 schema | 用得彻底 |
| `sharp` / `ffmpeg-static` / `@fastify/busboy` | 媒体 | 原生依赖处理流程成熟 |
| `openai@^7.8` | 仅 chat（F-21） | 可接受 |
| `tailwindcss@^4` + `@tailwindcss/postcss` | 仅 preflight + 3 token（F-14） | 决策项 |
| `vitest@^4` / `@playwright/test@^1.63` | 测试 | 好 |
| Node | CI 22；服务器版本未记录 | runbook 应记录（关系到 R4 是否能用 `node:sqlite`） |

## 5. 不要被「优化」掉的东西

1. 资金不变量（§4.2）与锁序 admission → user。
2. 「绝不静默落 mock」「priceCny 只降不升」「已计费请求 `maxAttempts:1`」「模糊提交锁重试」。
3. 派生索引可重建、事实源先写的顺序。
4. 媒体 `private, no-cache`；分享令牌与会话密钥分离。
5. 文档维护规则本身（只写当前真实状态）。

## 6. 未验证 / 局限

- 未登录生产服务器：`MemoryMax`、Node 版本、Caddyfile XFF 行为、ECS 快照、`ALERT_WEBHOOK_URL` 是否配置，均为文档转述或推断。
- `ShellContext` 重渲代价未用 Profiler 量化。
- e2e 不稳定用例只重跑了一轮（1 过 1 污染失败），未定位到确切竞态根因。
- 工作树中的 N3.4 进行中代码未审。
