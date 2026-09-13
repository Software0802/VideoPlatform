# Lumen 评测集

`prompts.json` 有两组固定输入（审查 2026-09-05 R03 起分开）：

- `cases`（20 条）：原生五模式回归集——T2V、I2V、R2V、Edit、Extend，中英各半，每模式两个边界档位。它按 grok provider（xAI）的字段约束写成，覆盖的 Edit / Extend 目前只有 grok 声明支持，跑这组需要 `XAI_API_KEY` 或 Sub2API；它证明这五条原生链路没有回退，**不能**用来验收长片一致性，也不覆盖可灵 / YMan 路由。
- `harnessCases`（8 条）：30 / 45 / 60 秒一致性管线用例——t2v / i2v、人物 / 场景、`tail_chain` / `hard_cut` / 用户尾帧定格。`harnessProtocol` 规定每条重复 2 次、与"三段原生 T2V 直接 concat"的基线盲评、两个操作场景（QC 重试、中断续跑）以及"失败样本不得移出分母"。Harness 现已供应商无关（shot 路由 `t2v/i2v/r2v`、续接尾帧→i2v、无 extend）；链路回归可用 mock 端到端代替上游——`LUMEN_FORCE_MOCK=1 HARNESS_ENABLED=true` 起 dev server 提一条 30s `text_to_video`，断言 `harnessPlan` 路由/续接/落盘文件即可，质量与成本评分仍须真实上游。

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

## 运行记录

真实评测完成后，把脱敏结果写入 `evals/runs/YYYY-MM-DD.json`。记录至少包含：

- case id、`purpose`（calibration / report）、`repeat`、`arm`（harness / naive_concat）、job id、provider、model
- 请求参数、脱敏后的 `harnessPlan`、每镜与整片实际时长
- `costUsdEstimate`（提交时）、`costUsdPlanned`（计划后）、`costUsdActual`、`costIncomplete`
- `rubric.md` v2 的身份三维 / 门槛 / 风格分、可交付判定、每镜 retries 与最后错误码、各阶段耗时

不要把 API key、Cookie、完整上游响应中的认证信息或私人媒体提交到仓库。
