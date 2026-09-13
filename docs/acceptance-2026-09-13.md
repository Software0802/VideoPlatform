# 真实上游验收 · 2026-09-13

生产 `https://genius.homeaistack.online`。#1–#5 与探针在旧构建（`98759a5`）上跑；30s 长片在部署 `16f145e` 之后跑。专用账号
`acceptance-20260913@lumen.test`（`usr_b3129585642b4c89`，注册赠 ¥5 + 礼品码 ¥5）。全部经公网
API 提交，与前端走同一条 `POST /api/jobs` / 智能体路由。

## 结果

| # | 路径 | jobId | provider / model | 结果 | 售价 | 上游记账 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 文生图 16:9 1k | `job_25b199c25ef0` | openai(ccgoai) / gpt-image-2 | 成功，1280×720 | ¥0.5 | $0.13（medium 档表价） |
| 2 | 文生视频 5s 720p | `job_01c8f993472a` | kling / kling-2.6 | 成功，5.04s，8.3 MB 可下载 | ¥2 | $0.15（列表价） |
| 3 | 图生视频 5s（首帧 = #1 产物，`/api/uploads/from-job`） | `job_1409dba7a021` | kling / kling-2.6 | 成功，5.04s | ¥2 | $0.15 |
| 4 | 文生视频 5s（点名「快速」产品） | `job_30d80cf544eb` | yman / minimax-h3 | 成功，5.17s | ¥2 | $0.208（`YMAN_UNKNOWN_CREDITS` 兜底估价，非上游实付） |
| 5 | 智能体一轮 → 批准 → 文生图 | `ses_29b663719fb6fef3` → `job_281f4b063b09` | ccgoai gpt-5.6-luna + gpt-image-2 | 提案 1 张 → 批准 → 成功 | ¥0.05 + ¥0.5 | $0.13 |
| 探针 | `POST /images/edits`（带参考图，medium，1024x576） | 直连 ccgoai | gpt-image-2 | 200，34s | — | 约一张图 |

对账：¥10 − 2 − 0.5 − 2 − 2 − 0.05 − 0.5 = **¥2.95**，与 `GET /api/me` 一致；6 个失败任务预留全部释放、一分未扣；智能体失败那轮 ¥0.05 已退（`adjust`）。
上游实付估算（含排查用的 5 次直连探针）约 ¥6，略超 ¥5 上限——超出部分全是为定位下面三处上游漂移花的。

## 发现并已处理的生产问题（都是上游侧变化，`.env` 已改、服务已重启、公网已验）

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| ccgoai 拒绝 `gpt-image-2` 的 `quality=high` | 503 `service_busy`，2 秒内确定性返回；**生产文生图此前全部失败** | `OPENAI_IMAGE_QUALITY=high → medium`（medium / low 实测正常） |
| YMan 下架 `minimax-H3 文字` | 404 `not_found` | `YMAN_T2V_MODEL=minimax-h3`；产品目录 `video-fast` 的 t2v 模型在代码里写死，用 `LUMEN_PRODUCTS=[{"id":"video-fast","models":{...}}]` 覆盖（注意是数组） |
| ccgoai 下架 `gpt-5.4-mini` | 404 `model_not_found`，智能体 502 `agent_upstream_failed`（已退费） | `AGENT_CHAT_MODEL=gpt-5.6-luna`（2s 出合规 JSON；`gpt-5.5` 21s） |

`.env` 改前备份：`/opt/genius/backups/.env.bak.20260913-acceptance`。

## 暴露的代码问题（均已在 `545580f` 修复并部署）

1. **5xx + 结构化错误体被判 `uncertain_submit`**：ccgoai 的 503 带 `{"error":{"code":"service_busy"}}`，明确是拒单未计费，但 `runner.isAmbiguousSubmitError` 按 `status >= 500` 一律视为「可能已接单」→ 标 `uncertain_submit` 并锁死重试。修复：`ProviderHttpError.upstreamRejected` 标记，openai-image 通道对「5xx 且响应体是合法 OpenAI error 形状」打标，runner 按确定失败处理、可重试。
2. `products/catalog.ts` 里 `video-fast` 的 t2v 模型名与 `env.ts` 的 `DEFAULT_YMAN_T2V_MODEL` 过期——已改默认值为 `minimax-h3`，旧名 `minimax-H3 文字` / `minimax_h3_t2v` 降级为别名，`.env.example` 的 YMan 模型清单已同步为 2026-09-13 实测 21 个 id：gpt-image-2、Runway Gen-4 Turbo video (图生视频)、gpt-image-2.5-flare、gpt-image-2.5-sunburst、sd2.0-MX、minimax-h3 768p、minimax_h3、wan3.0-video、sd-2.0-fast-真人、grok-video-1.5、minimax-h3-933-图文、seedance2.0-fast满血、seedance2.0-不卡人脸、seedance2.0-900-720p、minimax-h3、gemini-3-pro-image-run、nano-banana-2、firefly-gpt-image-2 等。
3. `minimax-h3` 不在 YMan 本地价目表——已登记进 `yman/catalog.ts`（沿用旧档 720p:10 + 5/10/15 = 40/90/140，注释标明未经账单核实）。
4. 智能体默认模型 / Director 模型名依赖中转的存量——`agent/llm.ts`、openai-image 与 yman 的创建 POST 在上游 404（`model_not_found` / `not_found`）时发 `upstream_model_missing` 告警（`{provider,model,base}`，按 `provider:model` 去重），错误照常抛出。
5. Director / 视觉 QC 的 LLM 调用复用 `UPSTREAM_TIMEOUT_MS`（默认 30s），gpt-5.6-luna 产出完整计划要 ~50s → 第一次长片 `Request timed out.`（`error.code=internal`）。已新增 `HARNESS_LLM_TIMEOUT_MS`（默认 120s、上限 5min），Director 上游/超时错误归一成 `HarnessFailure("llm_upstream_failed")`（不产生付费分镜、不锁重试）。生产已撤掉临时的 `UPSTREAM_TIMEOUT_MS=120000`，回到默认 30s。
6. 长片提交时 `costUsdEstimate` 只算视频片段（$0.9），实付 $1.45。已改为 `harnessSubmitEstimateUsd`（`provider-settings.ts`）= 视频片段 + `LLM_RESERVE_USD.director` + 4 张 16:9/1k 生图预留（单角色三视图 + 一镜首帧的经验值），创建 / 重试 / 耗尽换家三处共用。

## 30s 长片（部署 `16f145e` 后，`HARNESS_ENABLED=true` + `OPENAI_IMAGE_EDITS_ENABLED=true`）

`job_fb97db94e2a4`：kling-2.6，售价 ¥12，成片 **30.97s / 9.0 MB**，6 分 49 秒完成（Director 50s → 三视图 + 首帧 ~2 分 → 3 镜串行 ~3 分 → 拼接）。

| 阶段 | 事实 |
| --- | --- |
| Director | gpt-5.6-luna，2802 → 1548 tokens，$0.03；计划 3 × 10s，shot0 `i2v`/`hard_cut`/`generated` 首帧，shot1–2 `i2v`/`tail_chain` |
| 角色表 | 档 A 生效：`inputs/sheets/character-0-{front,side,back}.jpg` 三张（正面 t2i，侧/背走 `/images/edits`） |
| 首帧 | `shots/0/first.jpg` 以三视图为参考生成；肉眼核对：首帧、第二镜尾帧与三视图是同一人物、同一深青风衣、同一街道 |
| 分镜 | 3 镜全部一次成功（retries 0），每镜 $0.15 |
| 账目 | `costUsdActual` $1.45（估 $0.9，见问题 6）；余额 17.95 → 5.95（¥12） |

前一次尝试 `job_5ddb3cdfaf19` 因问题 5 在 Director 阶段失败，未产生任何付费分镜，预留已释放。

## YMan 30s 长片（部署 `9e0441c` 后，点名产品「快速」）

第一次 `job_db872d508168` 在 keyframing 之后全部 shot 本地被拒：shot 共用 `job.model`（t2v 模型 `minimax-h3`）发 i2v，YMan `validate` 拒「模型不接受参考图」——**bug**，`9e0441c` 修复：shot 按各自原生 mode 经 `modelForProvider(provider, mode, product)` 取模型。角色表 4 张图（$0.55）已花，预留 ¥20 释放。

修复后 `job_e080688fb3b9`：**31.2s 成片**，17.5 分钟（YMan 每镜排队 4–5 分钟，三镜串行），售价 ¥20，实付 $0.97（估 $1.24——补足图片 / LLM 预留后估价首次高于实付）。三镜全部 `i2v`（shot0 生成首帧，其后尾帧续接），模型 `minimax-h3-933-图文`；三视图 + 首帧生效；首帧人物（圆框眼镜、米色针织衫、旧书店斜射光）与提示一致。**注意**：档 A 优先于档 B——生图 provider 支持参考图时所有镜都走首帧 i2v，`r2v` 路径（档 B）没有被走到，仍未在真实上游验证。

另在这一步之前发现并修了：点名产品提交长片被产品时长档（5/10/15）拒绝（`28246db`），以及产品目录 `supportsLongForm` 只有 grok 为真、选中产品时前端无 30/45/60 芯片（`a83903e`）。

## 未完成

- 画布 DAG 未经 UI 走真实上游（#3 走的是与画布 `gen_video` 节点相同的 `createJob` + `from-job` 复用路径，DAG 预留转移未在生产验）。
- 档 B（`r2v` 参考图路径）未在真实上游验证：需要生图 provider 不支持参考图、而视频 provider 支持 r2v 的组合，当前生产不满足。
- `minimax-h3` / `minimax-h3-933-图文` 真实积分未核对（`costUsdActual` 用目录档估算）。
