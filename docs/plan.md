# 流光(Lumen)计划书 — rev 4(as-built 基线)

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-08-30 |
| 基线 | 2026-09-05 as-built：HEAD `6c01ba6`（M2.4 接入 `bb2657f`、Playwright 冒烟 `6c01ba6`）。§2 表按「已实现 / mock 已验证 / 真实已验证 / 质量已验收」四档标注 |
| 配套文档 | 设计书 `docs/design.md`;审查报告 `docs/review-2026-08-29.md`;历史 Phase 0 设计 `docs/architecture.md` |
| 状态 | 执行中。2026-09-05 完成 Blueprint 首页重建与 **M2.4 接入**(QC + orchestrator + `HARNESS_ENABLED` 放开 30/45/60,mock 端到端已验证;见 `docs/handoff.md`)。2026-09-05 晚 Codex 方案审查 5 条 P1 已并入（§4 / §5 / §6 / §7.1）。下一刀: 补齐预算覆盖与恢复账目（代码）→ 真实 key 30s 链路冒烟（G2）→ 校准样本定视觉 QC 阈值（G3） |

---

## 1. 产品定位

**一句话:** 类即梦 AI 的视频/图片生成工作室,后端接 xAI Grok Imagine;**核心资产是自研 Harness(一致性控制管线)**——把 ≤15s 的 Grok 原生 clip 导演、锁帧、链接、质检、拼接成 30/45/60s 身份一致的长视频。

分层价值:

1. **底座(已基本完成):** Grok 原生五种视频模式 + 文生图的 1:1 端到端回路(提交 → 异步进度 → 本地持久化 → 画廊回放),官方 key 与 Sub2API 拼车两种上游。
2. **核心(本计划重心):** Harness 管线 —— Director LLM 分镜、Identity Bible、关键帧锁定、tail-chain/extend 链接、QC 重试、ffmpeg 拼接。竞品可以复刻"包一层 API",难以复刻的是这条管线与其评测体系。
3. **延伸:** 文件化 skills/workflows、人审门、即梦首尾帧硬锁、账密计费多租户。

## 2. 现状盘点(2026-08-30)

产品可用形态（2026-09-05 更新）:本地单用户工作室,Grok 原生五视频模式 + 文生图端到端;**Harness 已接到 JobRunner**,`HARNESS_ENABLED=1` 时 30/45/60 可提交并在 mock 下出片。业务代码已分批提交（HEAD `6c01ba6`）。下表四档：✅ 已实现 · 🧪 mock 已验证 · 🔑 真实已验证 · 🏁 质量已验收。

| 模块 | 状态 |
| --- | --- |
| 类型 + Zod 模式矩阵(含 t2i) | ✅ 有单测 |
| Grok REST client / rest-map / router / mock provider | ✅ 有 golden 测试;源视频禁止 data URI |
| Job 状态机 / 磁盘 store / in-process runner / 幂等 / sweep | ✅ 含 harness 阶段 `directing…stitching`;boot recover;并发 2 / 队列 20 |
| HTTP API(uploads 流式 / jobs / cancel / retry / SSE / Range media / health) | ✅ Range suffix、SSE 心跳、uploadId 正则、ACCESS_TOKEN |
| 工作室 UI(2026-09-05 晚 Genius 单屏:首页 / 工作室(操作台 + 展览区)/ 作品环) | ✅ 像素级按 `design_handoff_genius_home` 还原;UI 只暴露 t2v / i2v / t2i,开启 harness 时时长循环追加 30/45/60;r2v / edit / extend 不在 UI 上 |
| 场景层(纯 three.js `mountDawn` 河面背景 / `mountRingDark` 作品环 + `SceneHost`) | ✅ 单一 `three@0.185`,R3F / drei / 图标库已卸载 |
| Harness 库层 | ✅🧪 Director / keyframe / shot 并行与崩溃恢复 / stitch;orchestrator 已接入 |
| Harness 产品化(接 runner、QC、放开长视频、预算门禁、重试继承分镜) | ✅🧪 M2.4 代码完成;🔑🏁 未达成——真实 key 未跑、评测未做 |
| git 提交 | ✅ 按模块分批提交至 `6c01ba6` |

## 3. 阶段计划

```mermaid
flowchart LR
  M1["M1 Phase 1 收口\n约1周"] --> M2["M2 Harness 核心\n4个里程碑"]
  M2 --> M3["M3 Skills/Workflows\n+人审"]
  M3 --> M4["M4 多供应商+商业化"]
```

### M1 — Phase 1 收口与加固(先于一切)

目标:底座可信、可回归、可安全暴露给小范围用户。

| # | 任务 | 状态 | 验收 |
| --- | --- | --- | --- |
| 1.1 | 按模块分批 git 提交全部现有代码 | ✅ | `79675ec … 6c01ba6` |
| 1.2 | 修复 C1:Files 失败即 fail,删除 data URI 视频兜底 | ✅ | `toSendableVideo` / rest-map 拒绝源视频 data URI,有 golden |
| 1.3 | 修复 C2:tracing glob `ffmpeg*` | ✅ | `next.config.ts` 已用 `ffmpeg*` |
| 1.4 | 修复 C3:uploadId 正则校验 | ✅ | `^up_[0-9a-f]{16}$`,单测覆盖 |
| 1.5 | 修复 C5–C10 | ✅ | Range suffix、cancel 落盘、recover、SSE 心跳、tmp 清理、cancel 删 file |
| 1.6 | 最小鉴权 `LUMEN_ACCESS_TOKEN` | ✅ | 未配置则本地单用户;配置后 `/api/*` 需 Bearer/Cookie |
| 1.7 | 统一 three 版本,移除 `three128` | ✅ | 仅 `three@0.185` |
| 1.8 | 收口测试门禁 | ✅ | `pnpm test` 167 绿;`tsc --noEmit` 绿;`pnpm e2e` 7 例(mock) |
| 1.9 | 真实 key 冒烟 | 🟡 | `data/jobs/` 已有成片,但无正式 ticks 对账记录、无 `evals/runs/` |

### M2 — Harness 核心(产品主线)

前置一次性工作(M2.0,~2 天):

- **评测集:** `evals/` 下 20 条固定 prompt(5 模式 × 中英文 × 边界时长)+ 人工评分 rubric(面部/发型/服装/光线/色调,各 0–1)；✅ 已建立并通过结构校验。
- **即梦 spike(1 天,H5):** 验证火山/Ark 首尾帧 API 真实可用性与效果,决定 packing 里"硬锁尾帧"档位是否成立。⏸ 当前没有即梦凭据，未发起外部请求。**依赖关系（2026-09-05 修正 R10）：当前基线是 Grok-only，M2.3/M2.4 已按 freeze settle 落地，spike 只阻塞 M4 的「尾帧硬锁」卖点与 `JimengProvider`，不阻塞 M2 收口。**
- **成本模型进 `cost.ts`:** 30s hybrid ≈ $2.10、60s ≈ $4.20,QC 重试预算系数 1.5;✅ 已提供纯函数与单测；UI 提交前展示留待 Harness API 启用。

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| M2.1 Director | `grok-4.6` chat.completions 产出 Zod 严格校验的 IdentityBible + shot list + packing;失败重试 2 次 | ✅🧪 已接入 orchestrator（mock 用 `mock-director.ts`）;token 用量记入 `llmUsage`。🔑 真实 Director 输出经 `lockPlan` 是否可执行未验 |
| M2.2 Keyframe | `grok-imagine-image-2.0` 角色表/关键帧;用户首帧注入 shot[0];tail-chain 抽帧用清晰度选帧(H1) | ✅🧪 角色表 assetId 由 `orchestrator.keyframe` 经 `updateHarnessBible` 写回 Bible;尾帧抽取在 `beforeShot`。角色表只为 R2V 镜生成（R07 已记录） |
| M2.3 链接与生成 | per-shot 路由(i2v/r2v/extend);shot 级状态与断点续跑(H3);无依赖 shot 并行 | ✅🧪 已接入;shot 账目跨重试累计（R05）;每次**分镜**提交前预算门禁（R06）；Director / 角色表 / 视觉评分三处付费调用尚未纳入预留与结算（见 G1）。🔑 extend 的 Files 上传未在真实上游验证 |
| M2.4 QC + Stitch + 放开 30/45/60 | 时长校验、黑帧/冻帧检测、grok-4.6 视觉一致性打分;把 Director→Keyframe→Shots→Stitch 接入 orchestrator;读取 `HARNESS_ENABLED`;UI 启用 30/45/60 | 🟡 2026-09-05 代码接入完成:`qc.ts` / `visual-qc.ts` / `orchestrator.ts`,runner 派发,UI 放开 30/45/60,mock 端到端 30s / 45s 成片已验证。**未完成验收**:真实 key 未跑;视觉 QC 阈值待 `evals/runs` 校准(默认关闭);评测集人审 ≥70% 与成本 ≤ ×1.5 未测；**真实链路下 QC 自动重试不可用**：Director 一记账 `llmUsage` 即令 `costIncomplete = true`，`reserveBudget` 对任何重试抛终态 `budget_unknown`，真实任务实际是失败即停，mock 下的重试成功不能代表该能力可用 |

状态机已并入 `directing|keyframing|generating_shots|qc|stitching`；`HARNESS_ENABLED` 已被 `createJob` / runner / orchestrator / health / 首页读取。

### M3 — Workflows & Skills + 人审

- `skills/<id>/SKILL.md`(YAML frontmatter 对齐 `SkillManifest`)+ workflow 图执行器;
- `awaiting_approval` 状态 + `POST /api/jobs/:id/approve`;单镜重做 UI;
- 验收:一条含人审门的 45s workflow 端到端走通。

### M4 — 多供应商 + 商业化

- `JimengProvider`(按 M2.0 spike 结论实现首尾帧硬锁,替换 freeze settle);
- 账户/credits/支付;`S3MediaStore`;BullMQ 队列;多实例部署;
- 验收:双供应商混合 packing 出片;计费与 ticks 对账误差 <1%。

## 4. 质量与评测(贯穿)

- **回归（两套，不互相替代）:** 改 Grok 原生请求 / rest-map / prompt 模板 → 跑 `evals/prompts.json → cases` 20 条（底座不回退）；改 Director / keyframe / shot 路由 / QC / stitch → 跑 `harnessCases` 8 条并遵守 `harnessProtocol`（每条重复 2 次、`naive_concat` 对照、`qc_retry` 与 `interrupt_resume` 操作场景、失败样本不出分母）。只跑原生 20 条不满足 harness 改动的合并条件。评分留档 `evals/runs/{date}.json`;
- **单测门禁:** `pnpm test` 绿是合并前提;REST golden、状态机、Range、Zod 矩阵不允许回退;
- **成本守护:** `JOB_CONCURRENCY=2`、`MAX_QUEUED_JOBS=20`、提交前预估、`cost_in_usd_ticks` 对账;M2 起 harness job 增加单 job 成本上限。**两个基准要分清（as-built）**：执行期硬停 `budgetCap = (costUsdPlanned ?? costUsdEstimate) × 2`，Director 跑过后用的是计划后预估；评测达标口径（rubric §五）是 `costUsdActual ÷ 提交时 costUsdEstimate ≤ 1.5`。**2026-09-05 晚已统一**：硬停 `budgetCap` 改为只用提交时 `costUsdEstimate`（×2），与评测口径同一基准；Director 出计划后先做计划级门禁；Director / 角色表 / 视觉评分 / 分镜每次付费调用都经 `withReservation` 预留并结算；实际花费越过提交预估 ×1.5 时置 `costOverTarget` 软告警（不停任务，只标记 + 日志）。LLM 费用按列表价占位入账，`unpricedCalls > 0` 才标 `costIncomplete`。

## 5. 风险登记(更新)

| 风险 | 严重度 | 缓解 |
| --- | --- | --- |
| 即梦首尾帧 API 不可用/效果差 → 尾帧硬锁卖点落空 | 高 | M2.0 spike 前置验证;fallback = freeze settle + keyframe-cut |
| QC 视觉打分不可靠 → 一致性无法保障 | 高 | 对照集校准阈值;人审兜底(M3);指标进评测集 |
| harness 单片成本超预期($3+/30s) | 高 | 成本模型 + 重试预算封顶;480p 试跑,通过后再高清重打 |
| Sub2API 上游行为与官方漂移(字段/状态) | 中 | golden test 双上游 fixture;health 显示 upstream kind |
| 提交后、`remoteId` 落盘前崩溃（`shot-executor` 先 submit 再持久化）→ 上游可能已接单，恢复按 `requeue` 重新提交，重复付费且突破本地并发上限；同时 `requeue` 丢掉 `priorCostUsd` / `costUnknown`，重试中断后账目被覆盖 | 高 | ✅ 已落地（2026-09-05 晚）：`submitting` 无 remoteId 恢复为 `needs_review` + `uncertain_submit`，不再自动重提；requeue 保留并合成 `priorCostUsd` / `costUnknown`；含 `uncertain_submit` 镜的任务禁用一键 Retry（服务端 409 + UI 提示，用户决定）。**未做**：自动对账（待验证上游幂等 / 查询能力）；`interrupt_resume` 评测场景补「submitting 无 remoteId」窗口 |
| in-process runner 在 HMR/崩溃下丢任务 | 中 | 已有磁盘状态 + boot recover;M4 换 BullMQ |
| vidgen URL 过期 | 中 | 已实现 done 后立刻下载 + storage_options 备份 |
| 端口暴露烧额度 | 中 | M1.6 最小鉴权;README 警告 |

## 6. 下一步(按优先级)

0. **首页收尾(小):** 「video · fast」模型变体需要 API 契约支持才可接入;Playwright 冒烟已建(`pnpm e2e`,7 例 mock);移动端只做了基本折行。详见 `docs/handoff.md`。
1. **M2.4 收口(产品主线)，拆三步:**
   - 1a **预算与恢复补齐（代码，先于真实试跑）:** ✅ 已完成（2026-09-05 晚第三轮）。Director / 角色表 / 视觉评分纳入 `withReservation` 预留与结算；LLM 费用按 `cost.ts` 的 `LLM_RATE_USD_PER_MTOKEN` 列表价定价（占位，未经 ticks 核实）；`recoverHarnessShot` 的 requeue 保留 `priorCostUsd` / `costUnknown`，且新增 `submitting` 无 `remoteId` → `needs_review`（`uncertain_submit`）分支，不再盲目重提；`budgetCap` 统一为纯函数、恒以提交时估算为基准；新增软告警 `costOverTarget`（实际 > 提交预估 ×1.5）。验收: `budget-coverage.test.ts`、`shot-recover.uncertain.test.ts` 等新增/更新单测通过（`pnpm test` 41 文件 / 183 用例绿，1 skip）；`tsc` / `eslint` 绿。**未验收**：真实链路下的 LLM 定价与预留额度是否准确（依赖 1b 的 ticks 对账）。
   - 1b **真实 key 30s 链路冒烟（G2 证据，不定阈值）:** 核对 Director 真实输出经 `lockPlan` 归一化后是否可执行、extend 镜的 Files 上传与 QC 期望时长、账目完整；结果记入 `evals/runs/`。
   - 1c **视觉 QC 阈值校准（G3）:** 按 rubric §五用 `purpose: calibration` 样本（含通过与失败样本）确定 `HARNESS_QC_VISUAL_THRESHOLD`，报告误放 / 误拒，再用 `purpose: report` 样本验证。单条冒烟不能定阈值。
2. **M2.2 收口(随 M2.4):** 角色表 assetId 写入 JobRecord / Identity Bible;`sheetAssetIds` 进入 R2V 参考图。
3. ~~**M1.1:** 按模块分批 git 提交~~ ✅ 已完成。
4. **M1.9 补记录:** 用真实 key 跑 3s 480p T2V → I2V → extend → edit,把 ticks 与 `evals/runs/{date}.json` 留下。
5. **M2.0 即梦 spike:** 仍缺凭据,阻塞 M4 尾帧硬锁,不阻塞 M2.4。
6. **M3 / M4:** skills/workflows 执行器、人审门、Jimeng、账密、S3/BullMQ — 排在长视频回路跑通之后。

## 7. 审查 2026-09-05 回应：门禁式依赖与待决事项

`docs/review-2026-09-05.md` 的 R01–R12 处理结果见该文 §6。这里只记计划层面的结论：

### 7.1 依赖用门禁表达（替代 §3 的串行阶段图）

| 门禁 | 通过条件 | 阻塞什么 | 现状 |
| --- | --- | --- | --- |
| G0 目标与基线对齐 | §1 写明当前只对"创作者本人 30s 多镜头视频"负责、明确不做项 | 一切新增范围 | ⏸ **待用户决策（R01）**：本文未替用户收窄产品目标 |
| G1 验收与成本基础 | `evals:check` 绿（含素材）；rubric v2 反例判定一致；账目跨重试累计且恢复不丢字段；**每次付费调用**（分镜 + Director + 角色表 + 视觉评分）受预算约束；预算基准统一 | 扩大付费试跑 | 代码侧 ✅（2026-09-05 晚）：全部付费调用受预算约束、requeue 保留账目、基准统一为提交时预估、`costOverTarget` 软告警；**未验收**: LLM 价格为列表价占位，需真实 ticks 对账；`character-*.jpg` 素材缺失，`evals:check` 为红 |
| G2 真实链路 | 原生模式 + 一条 30s Harness 各有脱敏输入 / 计划 / 成片 / 账目记录；覆盖 extend 与 R2V；覆盖「提交后 remoteId 落盘前中断」的恢复对账 | G3 | ❌ 未开始（需要真实 key 与人物素材） |
| G3 质量对照与最小复核 | 重复样本、naive_concat 对照、失败分母、可交付片成本；失败镜可经 Retry 继承已成功镜重做；QC 自动重试在真实链路可用（依赖 G1 的 LLM 定价 / 预留）；阈值由 calibration 样本定、report 样本验 | 45/60 放行、M3 | Retry 继承已实现（R09）；评测 ❌ |
| G4 扩展 45/60 与后续决策 | 同口径逐档通过；确认是否需要更长 / 工作流 / 多供应商 | M3 / M4 | ❌ |
| 即梦 spike | 火山 / Ark 首尾帧 API 真实可用 | 仅 M4 `JimengProvider` 与"硬锁尾帧"卖点 | ⏸ 缺凭据 |

### 7.2 M3 / M4 拆分（R11）——需用户确认后再排期

M3 / M4 目前是功能集合，没有工作量区间、费用上限和停止条件；单人项目也应写明。建议拆为独立决策包（skills 格式 / 图执行器 / 人审 UI；多供应商 / 账户 / 计费 / 存储与队列），每包填「交付证据 · 依赖门禁 · 工作量区间 · 试验预算 · 停止 / 降级条件」。**本轮未替用户填这些数字**：没有真实延迟、返工率和使用频率数据，任何周数都是虚假精度。

### 7.3 运行约束的真实语义（R11 纠正）

- 不存在"整片 15 分钟"超时。`shot-executor.pollUntilDone` 对**每个 shot 的每次尝试**给 15 分钟；`runner.recover` 用 job `updatedAt` 超过 15 分钟未更新判陈旧；原生单 clip 的 `runner.pollUntilDone` 也是 15 分钟。一条 60s 长片端到端上限约为 4 镜 × ≤3 次 × 15 分钟 + 拼接。
- 并发有两层：`JOB_CONCURRENCY`（默认 2 个 job）× `HARNESS_SHOT_CONCURRENCY`（默认 2 镜/job，上限 4）。上游同时在飞请求上限**在无崩溃时**= 两者乘积；崩溃落在「已 submit、未落 remoteId」窗口时，恢复已改为转 `needs_review`（`uncertain_submit`）而不再自动重提，因此不会再突破乘积；代价是这类任务必须人工核对上游后重新提交（一键 Retry 已禁用）。本地 ffmpeg 编码没有独立预算。真实运行记录出来前不定目标。
