# Lumen 评测集

`prompts.json` 有两组固定输入（审查 2026-09-05 R03 起分开）：

- `cases`（20 条）：原生五模式回归集——T2V、I2V、R2V、Edit、Extend，中英各半，每模式两个边界档位。它按 grok provider（xAI）的字段约束写成，覆盖的 Edit / Extend 目前只有 grok 声明支持，跑这组需要 `XAI_API_KEY` 或 Sub2API；它证明这五条原生链路没有回退，**不能**用来验收长片一致性，也不覆盖可灵 / YMan 路由。
- `harnessCases`（8 条）：30 / 45 / 60 秒一致性管线用例——t2v / i2v、人物 / 场景、`tail_chain` / `hard_cut` / 用户尾帧定格。`harnessProtocol` 规定每条重复 2 次、与"三段原生 T2V 直接 concat"的基线盲评、两个操作场景（QC 重试、中断续跑）以及"失败样本不得移出分母"。Harness 现已供应商无关（shot 路由 `t2v/i2v/r2v`、续接尾帧→i2v、无 extend）；链路回归可用 mock 端到端代替上游——`LUMEN_FORCE_MOCK=1 HARNESS_ENABLED=true` 起 dev server 提一条 30s `text_to_video`，断言 `harnessPlan` 路由/续接/落盘文件即可，质量与成本评分仍须真实上游。生产可灵 30s 已实证一例（`job_fb97db94e2a4`，30.97s 成片，档 A 三视图 + 首帧生效，见 `docs/acceptance-2026-09-13.md`）。

当前仓库只提供输入和人工评分规范（`rubric.md` v2），不会在 `pnpm test` 中自动调用上游，也不会伪造生成质量结果。

## 校验

```bash
pnpm run evals:check
```

校验结构 **并检查每个引用的素材文件是否存在**；缺素材直接退出码 1 并列出缺的文件。结构通过只说明输入格式合法，不代表评测已完成。

## 素材（`evals/assets/`）

| 文件 | 来源 | 状态 |
| --- | --- | --- |
| `source-1s / 2s / 8.7s / 15s.mp4` | 本仓库用 ffmpeg-static `testsrc2` + 220Hz 正弦生成（`scripts/validate-evals.mjs` 同级说明），640×360 24fps | ✅ 已入库，仅验证 Edit / Extend 的时长边界与链路，不含人物 |
| `palette-amber.jpg` | ffmpeg 纯色 `#C68A3A` 1024² | ✅ 已入库，作 R2V 色板参考 |
| `character-zh.jpg` / `character-en.jpg` | **待补**：需要有肖像使用授权的真人或自绘角色正面照（≥1024px、单人、干净背景、无水印），并在此表记录来源、授权与拍摄 / 生成日期 | ❌ 缺失；缺它们时 I2V / R2V / 人物长片用例不能跑 |

不要用网络图片或他人照片充数：身份一致评测会反复展示这张脸。

缺这两张时 `pnpm evals:check` 退出 1，被挡住的是 11 条用例：原生 8 条（`i2v-zh/en-min|max`、`r2v-zh/en-min|max`）与长片 3 条（`h30-i2v-zh-person`、`h30-i2v-en-person`、`h60-i2v-zh-person-lastframe`）。剩下 5 条长片（`h30-t2v-zh/en-person`、`h45-t2v-zh/en-scene`、`h60-t2v-zh-person`）不引素材，素材到位与否都能跑。

## 预算与阻塞

当前批准额度：**¥20 总额**。报价（`docs/plan-repo-optimization-2026-09.md` R3 节，2026-09-13 冻结）：仅 scene 子集 ≈¥117–¥145，全 8 条长片 ≈¥350–¥425，1080p 再 +60%。¥20 低于最小的那一档约一个数量级，因此**本轮没有跑任何付费评测，实际花费 ¥0**，`evals/runs/` 仍然是空的。

¥20 具体买不到什么，按 `src/lib/cost.ts` 与 `src/lib/jobs/provider-settings.ts` 的口径算：

- 视频片段：可灵 `kling-2.6` 720p 无声 = 0.3 积分/秒 × `KLING_USD_PER_UNIT`（默认 $0.1）→ 10 秒 $0.30；30 秒长片装箱成 10+10+10，片段费 $0.90。
- `costUsdEstimate` = 片段费 + Director 预留 $0.30 + `harnessImageAllowanceUsd()`（4 张 16:9/1k 图，按当前 `IMAGE_PROVIDER_ORDER` 首选 provider 的价目）。最后这一项取决于 `OPENAI_IMAGE_PRICE_TABLE` 与 provider shape，**从仓库里算不出来**，只能提交后从 job 记录读回。
- 硬闸 `budgetCap` = `costUsdEstimate × 2`（软告警 `costOverTarget` 在 1.5×）。按 `USD_CNY_RATE` 默认 7.2，一条 30 秒任务光片段 + Director 就 ≈¥8.6，硬闸落在 ¥17 以上——**单条任务的上限本身就可能顶穿 ¥20**。
- 就算勒到只跑一条，也定不出阈值：`rubric.md` 要求通过样本与失败样本一起定阈值、`harnessProtocol` 要求每条重复 2 次并与 `naive_concat` 盲评对照，单条冒烟不能定阈值。

所以卡住的是（按 plan 的片号）：

| 阻塞项 | 卡在哪 | 解除条件 |
| --- | --- | --- |
| R3.1 素材 | `character-zh/en.jpg` 缺失，`evals:check` 退出 1 | 拿到有肖像授权的正面照并在上表登记来源/授权/日期；不得用网图或占位图凑绿 |
| R3.2 校准轮 | ¥20 < scene 子集 ≈¥117–¥145 | 批到 scene 子集那一档的预算 |
| R3.3 报告轮 | 量级约等于再来一轮校准 | 同上，且校准轮先出阈值 |
| 全 8 条 | ≈¥350–¥425，且依赖 R3.1 | 素材 + 预算同时到位 |
| 生产 `HARNESS_QC_VISUAL_THRESHOLD` | 没有 `evals/runs` 对照集，无从校准 | R3.2 出阈值后才写进生产 `.env` 并记依据 |

拿到预算真要开跑时，计量只能按任务手工累加——**没有跨任务的人民币总额闸门**：

1. 提交后先从 job 记录读 `costUsdEstimate`，确认 `costUsdEstimate × 2 × USD_CNY_RATE` 还在剩余额度内再让它跑下去；顶不住就当场取消，别指望 `budgetCap` 替你守总额，它只守单条任务。
2. 跑完从 job 记录（或 `GET /api/jobs/:id` 的 DTO）读 `costUsdActual` 与 `costIncomplete`：没有任何界面显示这两个字段，只能自己读。`costIncomplete` 为真时 `costUsdActual` 只是下界，照它记账等于低估。
3. `costOverTarget` 一置位就停下来分析，别连着跑下一条。
4. 失败的尝试同样计费、同样进 `evals/runs`（`harnessProtocol.denominatorRule`：失败样本不得移出分母）。

## 运行记录

真实评测完成后，把脱敏结果写入 `evals/runs/YYYY-MM-DD.json`。记录至少包含：

- case id、`purpose`（calibration / report）、`repeat`、`arm`（harness / naive_concat）、job id、provider、model
- 请求参数、脱敏后的 `harnessPlan`、每镜与整片实际时长
- `costUsdEstimate`（提交时）、`costUsdPlanned`（计划后）、`costUsdActual`、`costIncomplete`
- `rubric.md` v2 的身份三维 / 门槛 / 风格分、可交付判定、每镜 retries 与最后错误码、各阶段耗时

不要把 API key、Cookie、完整上游响应中的认证信息或私人媒体提交到仓库。
