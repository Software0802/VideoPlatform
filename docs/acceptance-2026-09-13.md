# 真实上游验收 · 2026-09-13

生产 `https://genius.homeaistack.online`，运行旧构建（`98759a5`，不含 E1–E3）。专用账号
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

## 暴露的代码问题（待修，未改代码）

1. **5xx + 结构化错误体被判 `uncertain_submit`**：ccgoai 的 503 带 `{"error":{"code":"service_busy"}}`，明确是拒单未计费，但 `runner.isAmbiguousSubmitError` 按 `status >= 500` 一律视为「可能已接单」→ 标 `uncertain_submit` 并锁死重试。上游繁忙时用户只能换提示词重提。建议：OpenAI 兼容通道对「5xx 且响应体是合法 OpenAI error 形状」按确定失败处理。
2. `products/catalog.ts` 里 `video-fast` 的 t2v 模型名写死 `minimax-H3 文字`，`env.ts` 的 `DEFAULT_YMAN_T2V_MODEL` 同样过期——应改默认值为 `minimax-h3`，`.env.example` 的 YMan 模型清单同步（2026-09-13 实测 21 个 id：gpt-image-2、Runway Gen-4 Turbo video (图生视频)、gpt-image-2.5-flare、gpt-image-2.5-sunburst、sd2.0-MX、minimax-h3 768p、minimax_h3、wan3.0-video、sd-2.0-fast-真人、grok-video-1.5、minimax-h3-933-图文、seedance2.0-fast满血、seedance2.0-不卡人脸、seedance2.0-900-720p、minimax-h3、gemini-3-pro-image-run、nano-banana-2、firefly-gpt-image-2 等）。
3. `minimax-h3` 不在 YMan 本地价目表，记账用 ¥1.5 兜底，`costUsdActual` 因此是高估；应登记它的积分档（或从 `GET /v1/models` 的 `credits` 字段读）。
4. 智能体默认模型 / Director 模型名依赖中转的存量：中转下架模型时整条链路 502，建议 `agent/llm.ts` 在 404 `model_not_found` 时给出可读的运维错误码并进告警。

## 未完成

- 30s 长片（E1/E2 供应商无关化）需先部署 `ecfef47` 到生产再验；`OPENAI_IMAGE_EDITS_ENABLED=true` 可以开（探针已证明 ccgoai 透传 edits）。
- 画布 DAG 未经 UI 走真实上游（#3 走的是与画布 `gen_video` 节点相同的 `createJob` + `from-job` 复用路径，DAG 预留转移未在生产验）。
