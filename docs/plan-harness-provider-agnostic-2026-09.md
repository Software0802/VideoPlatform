# 方案：Harness 长片供应商无关化（E 重做）

状态：2026-09-13 用户批准方案 A（改造自有 Harness，不引入 ViMax 代码；参照 ViMax 的一致性做法）。
实施切片见 §6；每片完成后更新 `docs/handoff.md` 与 `docs/design.md` §7 为当前事实。

## 0. 目标与非目标

目标：30 / 45 / 60 秒长片走与普通创作完全同一套供应商路由（`VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER` + `capabilities()`），后台接任何中转都能出片；跨镜头一致性不依赖任何一家的私有 API。

非目标：不做 Python 边车；不接 ViMax；不改余额 / 预留 / 恢复中心的资金语义（沿用 orchestrator 现有 `withReservation` / `runPersistedPlan`）；不在本方案里开放 `edit_video` / `extend_video`。

## 1. 现状（2026-09-13 核对代码）

`src/lib/harness/` 43 文件约 5.7k 行（含 20 个测试文件）。阶段 directing → keyframing → generating_shots → qc → stitching 已接预留 / 结算 / 崩溃恢复。xAI 绑定只在这几处：

| 位置 | 绑定 |
| --- | --- |
| `types.ts` `ProviderRouteHint` | `grok_t2v / grok_i2v / grok_r2v / grok_extend / jimeng_first_last` |
| `shot-router.ts` | 每个分支写死 `model: MODEL_1_5 / MODEL_1_0`（grok 型号）；参考图 ≤7 是 grok 上限 |
| `orchestrator.ts` L25、L354–399 | 续接 = `uploadXaiFile` → `extend_video`；`provider.id !== "grok"` 直接失败 |
| `orchestrator.ts` L277、L791；`cost.ts` `estimateHarnessCostUsd` | 费率固定 `grok-imagine-video-1.5` / `grok-imagine-image-2.0` |
| `identity-sheet.ts` | 默认 `grokNativeProvider`、`MODEL_IMAGE` |
| `director.ts` / `visual-qc.ts` | LLM 固定 xAI `grok-4.6`，`response_format: json_schema` |
| `pack-duration.ts` | 15 + 10(extend) 的打包只对 grok 成立；可灵只收 5 / 10，YMan 按模型 5 / 10 / 15 |
| `router.ts` `selectProvider` / `currentProviderId`；`product-choice.ts` `assertProductFits` | 长片恒定 `fallbackProvider("video")`（= grok）；点名非 grok 产品的长片 400 |
| `create.ts` L147–155 | 长片只允许 t2v / i2v（保留） |

## 2. 从 ViMax 借的做法（HKUDS/ViMax，MIT）

1. **一致性在图像域解决，视频模型只负责"动起来"**：每个角色先出参考图，每个 shot 先出首帧图，再 i2v。这样对视频 provider 的最低要求只是 `image_to_video`。
2. **角色三视图**：正面（t2i，纯白背景、全身、居中、16:9 画布）→ 侧面 / 背面（以正面图为参考的图生图）。侧/背失败时复用正面图，不中断管线。
3. **首帧承接而非 extend**：相邻 shot 的连续性用「上一镜尾帧 → 下一镜 i2v」，我们已有 `tail_chain` + `extractSharpestTailFrame`。

## 3. 能力分层（按当前 ORDER 里选中的 provider 自动落档）

| 档 | 条件 | 角色表 | 每镜首帧 | 视频 |
| --- | --- | --- | --- | --- |
| A | 图片 provider 声明 `supportsImageReference` | 三视图 | 以角色表（+ 上一镜尾帧）为参考图生图 | i2v |
| B | 视频 provider 声明 `reference_to_video` | 三视图（无 i2i 时只有正面） | 无 | r2v，参考图 = 角色表 + 场景参考 |
| C | 只有 `image_to_video` | 只有正面（仅供视觉 QC 比对） | 无 | 首镜 t2v / 用户首帧 i2v，其后 tail_chain i2v |

档位由 Director 之后的 `lockPlan` 按 provider 能力决定，不由 LLM 决定。当前生产（openai/ccgoai 生图 + kling 视频）落 C；YMan 视频落 B；ccgoai 若确认支持 `/images/edits` 则升 A。

## 4. 接口决定

### 4.1 类型（`harness/types.ts`）

```ts
export type ShotRoute = "t2v" | "i2v" | "r2v";          // 删 grok_* 与 jimeng_first_last
export type Continuity = "hard_cut" | "tail_chain";     // 删 extend
export type Shot = { …同前, route: ShotRoute, durationSec: 5 | 10 };
export type HarnessPlan = { …同前, packing: { clips: Array<{ kind: "generate"; durationSec: 5 | 10 }> } };
IdentityBible.characters[i].sheetAssetIds  // 语义改为 [front, side?, back?]，最多 3
```

`FrameRef.source` 保留 `"user" | "generated" | "extracted"`；`"generated"` 从此真正有产出（档 A 每镜首帧）。

### 4.2 打包（`pack-duration.ts`）

`packHarnessDuration(target)`：30 → 10,10,10；45 → 10,10,10,10,5；60 → 10×6。Director 可在 sum 不变的前提下把某个 10 拆成 5+5（schema 校验 `durationSec ∈ {5,10}`，sum = target）。不再有 extend 片段。

### 4.3 路由（`providers/router.ts`、`jobs/product-choice.ts`）

- 删 `selectProvider` / `currentProviderId` 里的 `isHarnessDuration → fallbackProvider` 特判。长片按 **`image_to_video`** 模式走 `pickVideoProvider`（长片除首镜外全是 i2v；provider 必须同时声明 `text_to_video`，否则首镜出不了——在 `pickVideoProvider` 的调用处加这一条约束，不改它的签名）。
- `assertProductFits`：长片点名产品时要求产品 provider 声明 t2v + i2v，而不是 `=== "grok"`。
- 每个 shot 都用 `job.provider`（创建时选定），不做 shot 级换家；provider 中途耗尽 → shot 失败 → `needs_review`（现有语义）。

### 4.4 shot 请求（`shot-router.ts`）

`buildShotRequest(input)` 新增 `input.model: string`（= `job.model`）与 `input.caps: ReturnType<VideoProvider["capabilities"]>`；不再 import grok 的 mode-matrix。

- `t2v`：`mode: "text_to_video"`。
- `i2v`：需要 `startFrame`；`mode: "image_to_video"`。
- `r2v`：`mode: "reference_to_video"`；参考图数上限读 `caps.maxReferenceImages`（省略 = 不限），超出时**截断**（角色表优先于场景参考），不再 400。
- 时长校验：`durationSec ∈ {5,10}` 且 `caps.durations`（若声明）包含它。

### 4.5 定价（`cost.ts`、`orchestrator.ts`、`create.ts`）

- `estimateHarnessCostUsd(clips, pricing: { model: string; video?: VideoPricingHint })`：每片 `estimateCostUsd(model, clip.durationSec, undefined, video)` 求和。删 grok 费率特判；`RATE_USD_PER_SEC` 表保留给 grok provider 自己用。
- `shotListPrice(shot, pricing)` 同上。调用处从 `job.model` / `job.resolution` / `job.generateAudio` / `job.provider` 组 `VideoPricingHint`。
- 角色表预留额：`estimateCostUsd(imageModel, 0, { size: "1536x1024", quality: <provider 默认>, provider: imageProvider.id })`，不再用 `grok-imagine-image-2.0`。

### 4.6 角色表（`identity-sheet.ts`，新 `character-sheet.ts` 可拆）

- 图片 provider 取 `selectProvider({ mode: "text_to_image" })`（= IMAGE ORDER），模型 = 该 provider 的 `modelForProvider(provider.id, "text_to_image")`。
- 正面：t2i，prompt 参照 ViMax（全身、正面、纯白背景、居中、16:9、双手自然下垂、自然表情）+ 我们 bible 的 `lockedTraits / palette / doNotChange`。
- 侧面 / 背面：仅当 `caps.supportsImageReference` 为真时生成，`mode: "text_to_image"` + `referenceImages: [front]`；失败或不支持 → 只保留正面（bible 记 1 张），打一条 `log("warn")`，不阻断。
- 三张分别预留 / 结算（沿用 `withReservation`，key `sheet:${characterId}:${view}`）。

### 4.7 生图 provider 新能力（`providers/types.ts`、`openai-image/native.ts`）

- `capabilities().supportsImageReference?: boolean`（省略 = false）。
- openai-image：`OPENAI_IMAGE_EDITS_ENABLED=true` 时声明为真，`referenceImages` 非空的 t2i 请求改发 `POST {base}/images/edits`（multipart：`model`、`prompt`、`image[]`、`size`、`quality`），其余（轮询、计费、`maxAttempts:1`、`shouldAbort`）与 `/images/generations` 同一套。默认关——ccgoai 是否透传 `/images/edits` **未验证**，验证列入真实上游验收（¥5 预算内一张图）。
- YMan 生图复用同一工厂，读 `YMAN_IMAGE_EDITS_ENABLED`。

### 4.8 每镜首帧（档 A，`orchestrator.ts` keyframing 阶段扩展）

- 对 `startFrame.source === "generated"` 的 shot：t2i + `referenceImages = 该镜角色的 sheetAssetIds ∪ 上一镜尾帧（tail_chain 时）`，prompt = shot.prompt + bible 锁定项 + 「静态首帧，构图为镜头起始瞬间」。产物落 `shots/{index}/first.jpg`，预留 / 结算同角色表。
- 档 B / C 不生成首帧，`lockPlan` 把 `source: "generated"` 的 startFrame 删掉（同今天对不能物化的帧的处理）。

### 4.9 Director 与视觉 QC 的 LLM（`director.ts`、`visual-qc.ts`）

- 复用 `agent/llm.ts` 的 `agentLlmConfig()`（AGENT_API_KEY → ccgoai；其次 XAI；mock 实例走 mock）。`DIRECTOR_MODEL` / `VISUAL_QC_MODEL` 改为 `config.model`；缺配置抛 `HarnessFailure("llm_unavailable")`。
- `response_format` 改 `{ type: "json_object" }`（中转对 `json_schema` 支持参差，同 agent 的取舍），形状仍由 zod 说了算；把 JSON Schema 文本放进 system prompt 让模型照着出。
- 视觉 QC 需要视觉模型：`agentLlmConfig().model` 不一定支持图片输入 → 新增 `HARNESS_QC_VISUAL_MODEL` 覆盖口；未设且阈值未设时视觉 QC 关闭（现有行为）。
- Director system prompt 改写：不再提 grok_*；说明 route 只能是 `t2v / i2v / r2v`，首镜 t2v（或用户首帧 i2v），其后默认 `tail_chain` + `i2v`，场景切换用 `hard_cut` + `t2v`（档 B 由 `lockPlan` 改写为 r2v，LLM 不感知档位）。

### 4.10 `lockPlan`（`orchestrator.ts`）落档规则

输入 `caps`（视频 provider）与 `imageCaps`（图片 provider）：

1. 所有 `route === "r2v"` 的 shot：视频 provider 未声明 `reference_to_video` → 改 `i2v`（有 startFrame）或 `t2v`。
2. `tail_chain` 且 `index > 0` → `startFrame = { source: "extracted", assetId: shots/{i-1}/tail.jpg }`，`route = "i2v"`（同今天）。
3. 档 A：`hard_cut` 且无 startFrame 且 `characterIds.length > 0` → `startFrame = { source: "generated", assetId: shots/{i}/first.jpg }`，`route = "i2v"`。
4. 其余 `source: "generated"` 删除；有 startFrame 的 `t2v` 改 `i2v`（同今天）。
5. 用户首帧 / 尾帧处理同今天（`applyKeyframeLocks`）。

### 4.11 拼接（`stitch.ts`）

不变。`stitchOrder` 删 extend 分支（每镜一段，顺序 concat）。

## 5. 测试

- `shot-router.test.ts` 重写：三种 route × 有/无 startFrame × `caps.durations` / `maxReferenceImages` 截断。
- `pack-duration.test.ts`：三个目标时长的新打包；Director schema 拒绝 15 秒片与 extend。
- `orchestrator.test.ts` 增：`lockPlan` 三档落档各一例（用假 caps）；`shotListPrice` 对 kling / yman / grok 三种 model 走 `estimateCostUsd`。
- `identity-sheet.test.ts` 增：不支持 i2i 只出正面；支持时三张；侧面失败回落正面且不抛。
- `openai-image` rest-map golden：`referenceImages` 非空 → `/images/edits` multipart 形状；开关关时 `supportsImageReference` 为假且带参考图的请求 400。
- `router.test.ts`：长片按 `image_to_video` 走 ORDER；ORDER 里没有同时声明 t2v+i2v 的 provider → 400 `no_provider_available`。
- 端到端 mock：`HARNESS_ENABLED=true` + `LUMEN_FORCE_MOCK` 跑 30s 任务到 `succeeded`（现有 e2e 若有则更新）。
- 门禁：`pnpm tsc --noEmit`、`pnpm lint`、`pnpm test`（vitest）；e2e 只跑 harness 相关 spec。

## 6. 切片

| 片 | 内容 | 验收 |
| --- | --- | --- |
| E1 | §4.1–4.5、4.9、4.10 的 B/C 档、4.11：去 xAI 路由层，长片走 ORDER，Director/QC LLM 走 agent 配置 | mock 端到端 30s 成片；单测 / tsc / lint 绿 |
| E2 | §4.6–4.8：`supportsImageReference`、三视图、档 A 每镜首帧 | 单测 + rest-map golden；真实 `/images/edits` 探针留给上游验收 |
| E3 | 文档：`docs/design.md` §7、`docs/handoff.md`、`AGENTS.md` 后端约定、`.env.example` 新变量；`evals/` 增长片用例 | 文档事实与代码一一对上 |

生产开放（`HARNESS_ENABLED=true`）另行决定，前提是真实上游验收里至少一条 30s 长片在可灵或 YMan 上成片。
