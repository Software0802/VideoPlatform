# 方案：通用中转 provider 与动态模型目录（N3）

状态：2026-09-13 起草（用户已拍板 D3「做」，见 `docs/plan-next-2026-09-13.md`）。等用户过目后按 §5 切片实施；每片落地后更新 `docs/design.md` §2 与 `docs/handoff.md`。

## 0. 为什么

产品三个核心卖点里的第二条「多模型平台，用户自由选择模型组合」和第三条「接中转站、比官方便宜」，落到代码上就是：**接一家新中转不写代码、上架一个新模型不改代码、模型下架自动从可选列表消失**。今天每家中转一个 `providers/<id>/` 目录（yman 4 个文件），`ProviderId` 是字面量联合，产品目录手写，模型名写死在 env——本轮验收里三处上游漂移（gpt-5.4-mini、minimax-H3 文字、quality=high）全是这个结构的代价。

## 1. 现状（2026-09-13 核对）

- `ProviderId = "grok" | "mock" | "jimeng" | "openai" | "kling" | "yman"`，148 处引用；12 个文件有 `=== "kling"` 之类的硬编码分支（router、create、provider-settings、cost、catalog、layout 等）。
- YMan provider（`providers/yman/`）= OpenAI 兼容 `/videos` 三步（与 OpenAI 官方 Videos API 同形）+ 生图委托 `makeOpenaiImageProvider(YMAN_IMAGE_CONFIG)`；模型目录 `YMAN_MODELS` 手写 + `YMAN_MODEL_CATALOG` JSON 覆盖；价目按积分（¥1=100）。
- ccgoai 只作为「OpenAI 兼容生图 + 对话」接入（`OPENAI_*`、`AGENT_*` env），没有 provider 身份，也没有视频。
- 产品目录 `products/catalog.ts` 手写 7 个产品，`LUMEN_PRODUCTS` 按 id 覆盖。
- 上游模型缺失：404 时只发 `upstream_model_missing` 告警，产品仍在列表里，用户提交才失败。

## 2. 目标形态

一家中转 = 一段配置，不是一个目录：

```jsonc
// LUMEN_RELAYS（JSON 数组）；key 永远只写 env 变量名，不写值
[
  {
    "id": "yman",                       // provider id，与 ORDER / 产品 / 耗尽标记共用
    "name": "YMan",
    "baseUrl": "https://vip.yman.cc/v1",
    "keyEnv": "YMAN_API_KEY",
    "creditsPerCny": 100,               // 积分换算；没有积分制的中转省略，价目直接写 cny
    "video": {
      "protocol": "openai-videos",      // POST /videos → GET /videos/{id} → GET /videos/{id}/content
      "defaults": { "text_to_video": "minimax-h3", "image_to_video": "minimax-h3-933-图文", "reference_to_video": "minimax-h3-933-图文" },
      "taskTimeoutMs": 900000
    },
    "image": {
      "protocol": "openai-images",      // /images/generations（+ /images/edits）
      "model": "gpt-image-2", "quality": "medium", "flexibleSizes": true, "editsEnabled": false
    },
    "catalog": {
      "source": "models-endpoint",      // 启动 + 周期拉 GET /v1/models；"static" 则只用下面的 models
      "models": {                       // 逐字段合并到拉回来的目录（价目、档位、别名）
        "minimax-h3": { "durations": [5,10,15], "resolutions": ["720p"], "ratios": ["16:9","9:16"], "maxReferenceImages": 0, "credits": { "resolution": { "720p": 10 }, "duration": { "5": 40, "10": 90, "15": 140 } } }
      }
    }
  },
  { "id": "ccgoai", "name": "CCGO", "baseUrl": "https://ccgoai.club/v1", "keyEnv": "CCGOAI_API_KEY",
    "image": { "protocol": "openai-images", "model": "gpt-image-2", "quality": "medium", "flexibleSizes": true, "editsEnabled": true },
    "chat":  { "model": "gpt-5.6-luna" } }
]
```

- `VIDEO_PROVIDER_ORDER=kling,yman,ccgoai` 直接写 relay id；ORDER 里出现未注册的 id 启动时 warn 并忽略。
- 产品目录从 relay 目录**生成**：每个视频模型一个产品（id `${relayId}:${model}`，名称取目录里的展示名，档位 / 画幅 / 参考图数 / 时长档 / 售价来自目录），`LUMEN_PRODUCTS` 仍可按 id 覆盖名称与默认档；可灵 / grok 的手写产品保留。
- 模型下架：目录刷新后不在 `/v1/models` 里的模型 → 产品从 `availableProducts()` 消失 + `upstream_model_missing` 告警 + 已下单任务照常按现有 404 路径失败退款；ORDER 里默认模型缺失时该 relay 对该 mode 视为不声明（路由自动跳到下一家）。
- 老配置兼容：`YMAN_*`、`OPENAI_*`、`AGENT_*` env 在没有 `LUMEN_RELAYS` 时自动折算成两条 relay 预设（id `yman` / `openai`），生产 `.env` 不必改一行；写了 `LUMEN_RELAYS` 时以它为准。

## 3. 接口决定

### 3.1 Provider 注册表（`providers/registry.ts`）

```ts
export type ProviderId = string & { readonly __brand?: "ProviderId" };   // 放宽为字符串
export const BUILTIN_PROVIDER_IDS = ["grok", "mock", "jimeng", "kling"] as const;
export function registerProvider(p: VideoProvider): void;
export function providerForId(id: ProviderId): VideoProvider;            // 不认识 → throw（同今天）
export function registeredProviderIds(): ProviderId[];
export function hasProviderKey(id: ProviderId): boolean;                 // relay 读 keyEnv
```

- `router.ts` 的 `providerForId`/`hasProviderKey` 改为从注册表读；`videoProviderOrder()` / `imageProviderOrder()` 的合法值校验改为「已注册」。
- 12 处硬编码分支逐个处理：可灵专属（`resolveKlingSettings`、`lastFrameLocksOutput`、`KLING_*`）保留按 `"kling"` 判；yman 专属（`resolveYmanSettings`、`ymanResolution`、cost 的 `isYmanModel`）改为「provider 是 relay」的通用分支，读 relay 目录；`layout.tsx` 与 `plans.ts` 的 provider 判断改读 `capabilities()` 或 relay 配置。
- `exhaustion.ts` 键已是字符串，不改。`JobRecord.provider` schema 从枚举放宽为 `string`（老记录不受影响）。

### 3.2 Relay 工厂（`providers/relay/`）

从 `providers/yman/` 提炼：`client.ts`（Bearer、错误映射、`upstreamRejected`、404 告警）、`video.ts`（`openai-videos` 协议的 rest-map + poll + content 下载，含 `download-headers` 的 Bearer 分发登记）、`catalog.ts`（目录缓存、`/v1/models` 拉取、别名、积分→USD/CNY）、`native.ts`（`makeRelayProvider(cfg): VideoProvider`，`capabilities()` 由目录推导，生图委托 `makeOpenaiImageProvider`）。`providers/yman/` 变成 `makeRelayProvider(YMAN_PRESET)` 一行 + 兼容导出；现有 yman 测试改为跑在预设上（golden 不变）。

### 3.3 动态目录（`providers/relay/catalog.ts`）

- 缓存文件 `data/relay-catalog/<id>.json`（`fetchedAt`、`models[]`、原始响应）；启动 30 秒后首拉，之后每 `RELAY_CATALOG_REFRESH_MS`（默认 30 分钟）刷一次；拉失败保留上次快照并 warn，从未成功过时退回配置里的 `catalog.models`。
- `/v1/models` 的 `credits` 字段（YMan 形状）直接进价目；没有的按配置 `models[].credits`，再没有按 `RELAY_UNKNOWN_CREDITS`（沿用 `YMAN_UNKNOWN_CREDITS` 语义，默认 150）。
- 刷新后做 diff：新模型 → 生成产品（默认不进 ORDER 默认模型，只在列表里可选）；消失的模型 → 告警 + 产品不可用；默认模型消失 → 该 mode 不声明。

### 3.4 产品生成（`products/catalog.ts`）

`allProducts()` = 手写产品（kling / grok / mock）∪ 每个 relay 目录生成的产品 ∪ `LUMEN_PRODUCTS` 覆盖；`isProductAvailable` 增加「模型在最新目录里」。售价仍走 `priceCny`（与 provider 无关）——多模型自由选择不改变对用户的定价体系，上游成本差只影响 `costUsd*`。产品 DTO（`GET /api/models`）增加 `providerName`、`upstreamModel`（展示名）、`costHint`（"低/中/高" 三档，按估算成本相对售价算），供创作面板分组展示。

### 3.5 对话模型

`AGENT_*` 保持；relay 配置里的 `chat.model` 只在 `agentLlmConfig()` 没有 `AGENT_API_KEY` 时作为回落来源（按 ORDER 顺序取第一个有 `chat` 的 relay）。Director / 视觉 QC 不变。

## 4. 测试

- registry：注册 / 重复 id 拒绝 / ORDER 含未注册 id 被忽略并 warn。
- relay 工厂：用 YMan 预设跑现有 `yman/*.test.ts` 全部通过（golden 不变）；新增一个虚构 relay（`fixture-relay`）走 t2v/i2v/r2v/t2i 四条 rest-map golden。
- 目录：`/v1/models` 三种响应（正常 / 带 credits / 失败）→ 快照与产品列表；模型消失 → 产品不可用 + 告警一次。
- 路由：ORDER `kling,yman,fixture-relay`，默认模型缺失时跳到下一家。
- 兼容：只有 `YMAN_*` env 时折算出的预设与今天的 `ymanProvider` 行为一致（create.test / failover.test 不改断言即通过）。
- e2e：创作面板模型下拉按 provider 分组、显示售价与 `costHint`。

## 5. 切片

| 片 | 内容 | 验收 |
| --- | --- | --- |
| N3.1 | 注册表 + `ProviderId` 放宽 + 12 处硬编码分支处理 + schema 放宽 | 全量单测 / e2e 绿；生产不改配置部署，行为不变（冒烟一张图一条视频） |
| N3.2 | relay 工厂 + YMan 改为预设 + `LUMEN_RELAYS` 解析 + 老 env 折算 | yman golden 全过；本地用 `LUMEN_RELAYS` 声明 yman 跑 mock 端到端 |
| N3.3 | 动态目录 + 产品生成 + 下架自动隐藏 | 生产开 `catalog.source=models-endpoint` 后 `GET /api/models` 列出 YMan 全部视频模型；人为把默认模型改成不存在的名字 → 产品隐藏 + 告警 |
| N3.4 | 创作面板分组与 costHint（与 N4 合并） | e2e |

生产切换顺序：N3.1 部署（无配置变化）→ N3.2 部署后把 `.env` 的 `YMAN_*`/`OPENAI_*` 改写成一条 `LUMEN_RELAYS`（备份、可回退）→ N3.3 打开动态目录。每步公网冒烟。

## 6. 不做

- 非 OpenAI 形状的中转（自有协议）仍需手写 provider（可灵就是）。
- 不做自动选最便宜 provider：ORDER 仍是运维显式声明，用户点名产品优先——「用户自由选」比「系统替他选」更符合定位。
