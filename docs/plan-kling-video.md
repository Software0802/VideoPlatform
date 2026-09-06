# 方案：接入可灵（Kling）直连低价视频 provider

| 字段 | 值 |
| --- | --- |
| 状态 | 已实施并上线（`bcad123`，2026-09-06）；Codex 方案审查未做（额度）；`pnpm e2e` 未跑。真实冒烟已跑通两条，详见 `docs/handoff.md` §0c |
| 日期 | 2026-09-06 |
| 前置 | `main` @ `c5e92ed`（用户系统 / 配额 / 留存清理已上线） |
| 影响面 | `src/lib/providers/`（新目录 `kling/`）、`src/lib/providers/router.ts`、`src/lib/jobs/create.ts`、`src/lib/jobs/schema.ts`、`src/lib/cost.ts`、`src/lib/env.ts`、`/api/health`、`LumenHome.tsx` 时长芯片；**不改** `src/lib/jobs/runner.ts` 状态机与 `src/lib/harness/` |
| 取代 | 同日的 fal.ai 方案草案：可灵直连 720p 无声 $0.03/秒 低于 fal 最便宜的 Wan 2.2 480p $0.04/秒，且画质更好 |

## 1. 目标与不做项

**目标**：文生视频 / 图生视频改走可灵开放平台新系统 API（`api-beijing.klingai.com`），默认 **Kling 2.6 · 720p · 无声**，每秒 0.3 积分；按用户充值比例 $10 = 100 积分，即 **$0.03/秒**，为现在 xAI Grok（$0.08/秒）的 37%。xAI 仍保留给 `reference_to_video / edit_video / extend_video`、文生图回落与 Harness 长片。

**明确不做**（本轮）：回调（沿用轮询是真相）、有声 / 1080p / 首尾帧 / 音色的 UI 入口（只留环境变量）、可灵图片模型、旧版 AK/SK JWT 鉴权。

## 2. 核对过的上游事实（2026-09-06，klingai.com 官方文档，浏览器实读）

| 项 | 值 |
| --- | --- |
| 鉴权 | 新系统：控制台生成单串 API Key，`Authorization: Bearer <key>`。域名 `https://api-beijing.klingai.com` |
| 创建 | `POST /text-to-video/kling-2.6`：`{ prompt, settings:{ audio:"native"\|"off", resolution:"720p"\|"1080p", aspect_ratio:"16:9"\|"9:16"\|"1:1", duration:5\|10 }, options:{ external_task_id, watermark_info:{enabled:false} } }`；`POST /image-to-video/kling-2.6`：`{ contents:[{type:"prompt",text},{type:"first_frame",url:<url 或 base64>}, 可选 last_frame / voice], settings:{ audio, resolution, duration } }`（图生无 aspect_ratio，随首帧） |
| 响应 | `{ code, message, request_id, data:{ id, status, create_time, update_time } }`；`code !== 0` 即业务失败（HTTP 也非 200） |
| 查询 | `GET /tasks?task_ids=<id>` → `data:[{ id, status: submitted\|processing\|succeeded\|failed, message, outputs:[{type:"video", url, duration}], billing:[{ charge_type:"unit"\|"cash", amount, currency?, package_type }] }]`。**billing 给出真实扣费**：资源包场景 `charge_type=unit`、`amount` 为积分数 |
| 约束 | `duration` 只有 **5 / 10**（能力地图写 3–10s 是营销口径，接口枚举只有两档）；有声只支持 1080p；首尾帧只支持 1080p；首帧 jpg/png ≤50MB、边 ≥300px、宽高比 1:2.5–2.5:1；成片 URL 30 天后清理 |
| 计价（积分/秒） | 2.6 无声 720p 0.3 / 1080p 0.5；2.6 有声 1080p 1.0；2.5 Turbo 无声 0.3 / 0.5（时长同样只 5/10）；3.0 Turbo 有声 720p 0.8 |
| 错误码 | 401 `1000–1004` 鉴权；429 `1101/1102` 欠费 / 资源包用完；400 `1200/1201` 参数；400 `1301` 内容安全；429 `1302/1303` 限速 / 并发超包；5xx `5000–5002` |
| 并发 | 按账号 × 模型 × 资源包类型计并发，每个视频任务占 1，超限返回 `1303`，无 QPS 限制；查询接口不占并发 |

## 3. 路由：显式开关，不靠 key 存在性

xAI key 会继续存在（r2v / edit / extend / harness 靠它），所以可灵不能凭 key 存在抢路由：

```
KLING_API_KEY=...                         # 缺失 → kling 完全不参与
KLING_BASE_URL=https://api-beijing.klingai.com
VIDEO_PROVIDER=kling|grok                 # 默认 grok；=kling 且有 key 时 t2v / i2v 走 kling
KLING_VIDEO_MODEL=kling-2.6               # 路径段；kling-2.5-turbo 同形状可直接切
KLING_VIDEO_RESOLUTION=720p               # 720p|1080p，覆盖 UI 固定发的 720p
KLING_VIDEO_AUDIO=off                     # off|native；native 时强制 1080p（上游硬约束）
KLING_USD_PER_UNIT=0.10                   # 积分→USD 换算，只影响账目显示
KLING_TASK_TIMEOUT_MS=900000              # 与 runner pollUntilDone 15 分钟上限一致
```

| mode | 条件 | provider |
| --- | --- | --- |
| `text_to_image` | 不变 | openai → grok → mock |
| `text_to_video` / `image_to_video` | `VIDEO_PROVIDER=kling` 且有 key 且**非 harness** | `kling` |
| 同上 | 否则 | grok → mock |
| `reference_to_video / edit_video / extend_video` | 不变 | grok → mock |
| harness（30/45/60） | 不变 | grok（extend shot 依赖 xAI Files API） |

`currentProviderId(mode, { harness })` 加参数，`create.ts` 与 `retryJob` 同步；`modelForProvider` 加 kling 分支返回 `KLING_VIDEO_MODEL`（重试时 provider 与 model 一起重解析，避免错配）。`isMockMode()` 改为「三把 key 都没有才 mock」；`/api/health` 增加 `videoProvider` 与 `klingKeyPresent`。

## 4. 时长：5 / 10 两档，服务端归一 + UI 芯片跟随

UI 时长芯片是 4 / 6 / 8 / 10，可灵只收 5 / 10。两层处理：

- **服务端**（真相）：`create.ts` 在 provider 为 kling 时把 `durationSec` 归一为 `≤5 → 5`、`>5 → 10`，**写回 `job.durationSec`**，估价与详情卡都按归一后的值。理由：4 秒请求被计 5 秒费，账目必须如实；`assertModeConstraints` 的 1–15 校验保留。
- **UI**：`/api/health` 已被首页读取（mock / harness 标记同源）；当 `videoProvider === "kling"` 时 `DURS` 换成 `[5, 10]`，用户不会再看到 4 / 6 / 8。旧任务的「再生成」回填 6 秒会被服务端归一成 10，可接受。

画幅：t2v 直传 16:9 / 9:16 / 1:1（UI 恰好只有这三种）；i2v 不发画幅。分辨率由 `KLING_VIDEO_RESOLUTION` 覆盖并写回 `job.resolution`。`generateAudio` 由 `KLING_VIDEO_AUDIO` 决定，UI 值忽略（有声只在 1080p，rest-map 自动抬到 1080p 并写回）。

## 5. 新 provider `src/lib/providers/kling/`

| 文件 | 作用 |
| --- | --- |
| `client.ts` | `klingPost / klingGet`：`Authorization: Bearer`，走现有 `fetchUpstream`。**创建任务固定 `maxAttempts: 1`**——任务一旦 `submitted` 就占并发并计费，重发 POST 是第二条任务；查询 GET 保留 transient 重试。响应 `code !== 0` 转 `ProviderHttpError(status, "kling_<code>", message)`，`1301` 映射为 `moderation`（runner 现有「未通过安全审核」路径），`1302/1303/5000–5002` 归入 retryable 集合 |
| `rest-map.ts` | `mapToKlingRequest(req)` → `{ path, body }`：t2v / i2v 两种体；`durationSec` 归一 5/10；分辨率 / 音频覆盖；`startImage` data URI 直接填 `first_frame.url`（上游接受 base64）；`external_task_id = jobId`（幂等辅助，见 §7）；`watermark_info.enabled=false`。`mapTask(json)`：`submitted → pending 5`、`processing → pending 40`、`succeeded → done + outputs[0].url + duration`、`failed → failed + message`；`billing` 里 `charge_type=unit` 的 `amount × KLING_USD_PER_UNIT`（或 `cash` 的 `amount` 按 currency）→ `usage.costUsdActual` |
| `native.ts` | `klingProvider: VideoProvider`，`id:"kling"`，`capabilities: modes [t2v, i2v], maxDurationSec 10, supportsLastFrameLock false, maxResolution 1080p`；`submit` 返回 `{ providerId:"kling", remoteId: data.id }`；`poll` 调 `GET /tasks?task_ids=` 取 `data[0]`，`remoteUrl` 交给 runner 现有 `persistRemote` 落盘（URL 公网可下，`downloadHeadersFor` 对非 xAI 域不带 key，正确） |
| `*.test.ts` | 见 §8 |

**硬约束继承**：尾帧仍只落盘、`last_frame` 永不填（golden test）；首帧 data URI 与 grok 一致；源视频不涉及。runner 的取消判定（submit 前后各读一次 job.json）原样生效；v1 不调可灵取消（文档未见取消接口，且计费按任务）。

## 6. 计价与账目

- 提交估价：`cost.ts` 的 `RATE_USD_PER_SEC` 增加 `kling-2.6:720p:off`、`:1080p:off`、`:1080p:native`（0.3 / 0.5 / 1.0 积分 × `KLING_USD_PER_UNIT`），`estimateCostUsd` 增加 `video?: { resolution, audio }` 提示。**未经真实账单核实的列表价占位**，与既有条目同款注释。
- 实付：poll 到 `succeeded` 时用 `billing` 覆盖 `costUsdActual`，这是三家 provider 里唯一给真实扣费的，账目最准。
- 单位：积分换算成 USD 存，与 grok 同单位；`provider` 字段可分账。

## 7. 幂等与并发

- 本地幂等 key 机制不变（`createJob` 回放）。额外把 `external_task_id=jobId` 发给上游：若 POST 超时但上游已建任务，重试前可 `GET /tasks?external_task_ids=jobId` 找回，避免二次计费——v1 只在 rest-map 里带上字段，找回逻辑记为 v1.1。
- `1303` 并发超包：当作 retryable，runner 现有的指数退避（最多 2 次）处理；`JOB_CONCURRENCY` 建议设为资源包并发数。

## 8. 验证

| 层 | 内容 |
| --- | --- |
| 单测 | `rest-map`：t2v / i2v 请求体 golden（无 `last_frame`、`watermark` 关、4→5 / 6→10 归一、有声抬 1080p、非法画幅 400）；`mapTask` 四态 + billing 换算；`client`：`code !== 0` 转错误、`1301 → moderation`、创建不重试。`router.test.ts`：开关 × key × harness 组合。`cost.test`：三档单价 |
| 门禁 | `tsc --noEmit`、`eslint src`、`pnpm test`，再 `pnpm e2e`（mock 不受影响，确认 schema 枚举与芯片改动没打挂） |
| 真实冒烟 | `.env.local` 按 §3 配置，预览里提交一条 5 秒文生视频（1.5 积分 ≈ $0.15）与一条 5 秒图生视频；核对 job.json 的 `provider / model / durationSec / resolution / costUsdActual` 与可灵控制台「抵扣明细」一致 |

## 9. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 4 / 6 / 8 秒被计成 5 / 10 秒 | 服务端归一写回 + UI 芯片跟随，用户看到的就是会被计费的时长 |
| 成片无声 | 用户选择低成本；`KLING_VIDEO_AUDIO=native` 一键切有声（自动 1080p，1.0 积分/秒） |
| 资源包并发通常很小（试用包常为 1–3） | `1303` 走退避重试；`JOB_CONCURRENCY` 对齐资源包 |
| 30 天 URL 清理 | 成片 `succeeded` 即 persisting 落盘，与现有链路一致 |
| 混合 provider 账目 | 全部 USD；kling 有真实 billing，grok 有 ticks，openai 可能是人民币额度（已有注释） |
| 高风险区域 | 触及 `create.ts`、`schema.ts`、`cost.ts` 与 provider 层：主代理自审，rest-map golden 与 router 组合测试是主要防线；Codex 额度恢复后补审方案 |

## 10. 实施顺序（子代理模式，coder ∥ tester）

1. `env.ts` + `cost.ts` + `types.ts` / `schema.ts` 枚举（无行为变化，门禁绿）。✅ 已完成。
2. `providers/kling/` 三文件 + 单测。✅ 已完成（`client.test.ts` / `native.test.ts` / `rest-map.test.ts`）。
3. `router.ts` / `create.ts`（含 retry 与时长归一）/ `health` / `LumenHome` 芯片接线 + 测试。✅ 已完成，`tsc`/`eslint`/`pnpm test`（57 文件/456 通过）绿；`pnpm e2e` **未跑**（3000 端口被占用，见 `docs/handoff.md` §0c）。
4. `.env.example`、`docs/design.md` §2c、`AGENTS.md` 后端约定一行、`docs/handoff.md`。✅ 已完成（本轮）。
5. 真实冒烟两条，对账，写回 handoff。✅ 已完成：文生视频 4s→5s/720p/无声/`$0.15`，图生视频 5s/`$0.15`，与可灵控制台账单一致；首跑因国际版 key 走错域名（`api-beijing`→`1002`）排查后改用 `api-singapore` 修复。

未完成：向用户确认方案（状态仍是「待用户确认」的动作项）；Codex 方案审查（额度限制）；提交与部署；`pnpm e2e` 回归。
