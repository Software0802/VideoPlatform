# 会话交接 — 流光 · Lumen

| 字段 | 值 |
| --- | --- |
| 更新日期 | 2026-09-05 |
| 基线 | `ee1ac26 feat: 失败态重试 / 取消入口与 mock 失败标记`；本轮（M2.4 Harness 接入）见 §1 |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33，three 0.185 |
| 门禁状态 | `tsc --noEmit` 绿；`eslint src` 绿；`pnpm test` 37 文件 / 158 用例绿 |
| 运行 | `pnpm dev` → http://localhost:3000；无密钥即 mock 模式。预览配置 `.claude/launch.json` → `lumen-dev`。本机 `.env.local`（不入库）已设 `HARNESS_ENABLED=1` |

新会话先读本文，再按需读 `AGENTS.md`（规则）、`docs/design.md`（后端 as-built，§7 是 harness）、`DESIGN.md`（UI 规格）、`docs/plan.md`（里程碑）。

---

## 1. 本轮做了什么（2026-09-05，M2.4）

把已有的 Director / Keyframe / shot 并行 / stitch 库接进 `orchestrator.execute`，读取 `HARNESS_ENABLED`，放开 30 / 45 / 60。

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/lib/harness/orchestrator.ts` | 真正的管线：`queued → directing → keyframing → generating_shots → qc → stitching → persisting`。可注入依赖（`createHarnessOrchestrator(deps)`），每阶段按 job.json 续跑。导出 `lockPlan`（计划归一化）、`stitchOrder`（extend 成片替换被延长的镜）、`stitchDimensions`、`HarnessFailure` |
| `src/lib/harness/qc.ts` | 技术 QC：时长 ±0.4s、`blackdetect`（≥0.5s）、`freezedetect`（≥2s，-60dB）。纯解析函数 + `runShotQc`，不过即 `ShotQcFailure` |
| `src/lib/harness/visual-qc.ts` | grok-4.6 视觉 rubric（五维 0–1，均值总分）请求构造 / 解析 / `tightenShotPrompt`（重试时追加 Bible 锁定项）。只在 `HARNESS_QC_VISUAL_THRESHOLD` 设置且非 mock 时被调用 |
| `src/lib/harness/mock-director.ts` | mock 模式的确定性 Director：15s generate 片 + tail-chain I2V，无 extend |
| 对应 `*.test.ts` | orchestrator 端到端（假 provider 出 64×36 的 lavfi 片：成功链、QC 失败两次后 needs_review、崩溃续跑不重跑 Director）、QC 真片检测、视觉 QC、mock director |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/lib/env.ts` | `harnessEnabled()`、`harnessShotConcurrency()`（默认 2）、`harnessQcVisualThreshold()`（默认 null = 跳过） |
| `src/lib/jobs/runner.ts` | 长片任务从 `runOne` 直接派给 orchestrator，只接手它交回的 `persisting`；pump 也捡起 harness 中间态（重启续跑）；`HarnessFailure` 映射为 job 失败码 |
| `src/lib/jobs/create.ts` / `request-validation.ts` | `HARNESS_ENABLED` 开启后接受 30/45/60（仅 t2v / i2v），`harness.enabled = true`，预估用 `packHarnessDuration`；`assertModeConstraints` 用 15s 代入校验其他字段，30/45/60 依旧不进 Grok |
| `src/lib/jobs/schema.ts` / `store.ts` | public DTO：`harness.enabled` 改布尔；新增 `shots[]`（id / index / durationSec / status / retries / error），Bible 仍不公开 |
| `src/lib/harness/shot-state.ts` | shot 记录新增可选 `qc` 报告；`retry_exhausted` 的 message 带上最后一次真实错误 |
| `src/lib/harness/shot-executor.ts` | 导出 `ShotFailure`；`persistOutput` 可返回 `{ outputPath, qc }`；新增 `shotOverride`（每次重试重新算 prompt） |
| `src/lib/harness/run-persisted-plan.ts` / `run-persisted-shot.ts` | 新增 `beforeShot` 钩子（抽尾帧 / 成本护栏）；plan 级 `onState` 现在会收到每个 shot 的状态变化（原先只收阻塞态，导致进度不动） |
| `src/lib/harness/state.ts` | `updateHarnessBible`（角色表 assetId 回写） |
| `src/lib/harness/stitch.ts` | loudnorm 后固定 `-ar 44100`（否则出 96kHz） |
| `src/lib/ffmpeg.ts` | `runFfmpegCapture` 返回 stderr（滤镜报告在那里） |
| `src/lib/providers/mock.ts` | Ken Burns 推进速率随时长缩放 + 叠一层双墨动态光漏（`gradients` 滤镜，screen 18%）。原因：静帧慢推经 x264 压缩后帧间差异低于 -60dB，harness QC 会把 mock 片全判成冻帧 |
| `src/components/lumen/LumenHome.tsx` / `page.tsx` / `globals.css` | `harness` prop：时长面板多出 `| 30s 45s 60s`（`aria-label="30s 长片"`），摘要显示 `Grok · harness · 长片 30s · ≈ $2.10`；读数用 `HARNESS_LABELS`（分镜 / 锁帧 / 生成分镜 n/m / 质检 / 拼接）；首屏说明多一条 `Harness · 30 / 45 / 60s` |
| `src/app/api/health/route.ts` | `harnessRunnable` 反映开关 |
| `.env.example` / `AGENTS.md` / `docs/design.md` / `docs/plan.md` | 同步 |

### 已验证

- 单测：orchestrator 7 例（含 QC 重试 → needs_review、崩溃续跑）；全量 158 绿。
- mock 端到端（内置浏览器 + curl，`HARNESS_ENABLED=1`）：
  - 30s：`job_eb823fd200f7` → 2 镜 tail-chain → `outputs/video.mp4` 30.04s 1280×720 立体声，poster 有，画廊 / 存档正常入列。
  - 45s：`job_8641455443c5` → 3 镜，读数依次 `生成分镜 / Shots 1/3 · 33%` … `完成 / Done · 100%`，成片区块视频 0:45 可播。
  - QC 真实拦截：改 mock 前，第一条 30s 任务因 `qc_frozen_frames` 重试 2 次后以 `needs_review` 失败，错误文案带原因（这是 QC 在工作，不是 bug）。
- `data/jobs/` 里没有残留 `*-shot-*` 暂存目录。

## 2. 设计取舍（本轮）

| 项 | 取舍 | 原因 |
| --- | --- | --- |
| QC 时机 | 在每镜落盘前（`persistOutput` 内）做，不在 job 级 `qc` 阶段回炉 | tail-chain 下游镜依赖上游尾帧；上游被 QC 拒收就不该让下游开跑。job 级 `qc` 只做聚合校验 + 成本护栏 |
| 视觉 QC | 实现完整但默认关闭 | design.md H2 要求阈值由对照集校准；`evals/runs/` 仍空，不能拍脑袋定 0.6 |
| Director 输出归一化 | `lockPlan` 丢掉 Director 自己编的 startFrame/endFrame assetId，只保留用户首帧和管线抽的尾帧 | Director 无法知道真实 asset 路径；否则 shot 提交时 resolveAsset 必炸 |
| mock 不出 extend | mock director 只用 generate + tail-chain | extend 必须 `file_id`（xAI Files），mock 没有；真实 Director 可出 extend，orchestrator 已处理上传与 `stitchOrder` |
| 超预算 | 重试前检查 `costUsdActual > estimate × 2` → `budget_exceeded` 失败 | M3 才有 `awaiting_approval`，先失败并说明 |
| 预估口径 | 提交时按 `packHarnessDuration`（30s ≈ $2.10），Director 出计划后按真实 packing 重算（mock 全 generate → $2.40） | UI 摘要与最终账单口径一致，差异可解释 |

## 3. 未完成 / 待办

### M2.4 收口（下一刀）

- [ ] **真实 key 冒烟**：跑一条 30s，重点看 (a) 真实 Director 输出经 `lockPlan` 后能否全部被 `buildShotRequest` 接受（r2v 需要 sheetAssetIds，由 keyframing 补）；(b) extend 镜 Files 上传与 QC 期望时长（前一镜实测 + 延长段）；(c) `costUsdActual` 与 ticks 对账。结果写 `evals/runs/YYYY-MM-DD.json`。
- [ ] 据对照集定 `HARNESS_QC_VISUAL_THRESHOLD`，再默认启用视觉 QC。
- [ ] 取消长片任务时 `shots/` 下已生成的分镜片不清理（在 job 目录内，不影响正确性）；如需省盘再加。
- [ ] Director 真实计划里 `grok_r2v` 镜的参考图只取角色表；用户参考图（`inputs/ref-*.jpg`）目前只作为 `referenceAssetIds` 传给 Director，未自动挂到 Bible。

### 首页相关（沿用）

- [ ] 「video · fast」变体需要 `createJobBodySchema` 加字段。
- [ ] Playwright 冒烟未建；本轮仍是内置浏览器 + curl 人工验证。
- [ ] 移动端只做了基本折行。
- [ ] 三条路径区块的文生视频描述仍写「4–10 秒」，开启 harness 时未提长片。

### 产品主线

- [ ] **M1.9** 真实 key 冒烟并把 ticks 对账写入 `evals/runs/`（与上面合并做）。
- [ ] **M2.0** 即梦 spike 缺凭据，阻塞 M4 尾帧硬锁。
- [ ] **M3** skills / workflows / `awaiting_approval` 人审门。

## 4. 已知坑

- **mock 片必须有帧间变化**：harness QC 的 `freezedetect` 用 -60dB，任何"静帧慢推"经 x264 后都会被判冻帧。改 mock 出片时保留光漏叠层（或等价的运动）。
- **mock 的 `poll` 现在有用了**：shot-executor 会真的轮询 mock（3.5s pending 窗口），每镜比 runner 直跑多等几秒；runner 单 clip 路径仍不轮询。
- 长片任务约 40–60 秒完成（mock，含 ffmpeg 编码），取消窗口足够长，可用来验证取消链路。
- Next dev 下 runner 是 `globalThis` 单例，改 runner / orchestrator 后新任务会用新模块，但已在 inflight 的任务用旧代码。
- 内置浏览器面板 `read_page` 偶尔返回 `Viewport: 0x0` / 旧 ref；点一下页面或重新 `read_page` 即可。滚动后截图空白问题仍在，用 `translateY` 位移法。
- `pnpm test` 冷启动偶发 1 个超时失败，重跑即绿。

## 5. 下一刀建议

1. 提交本轮：`feat: M2.4 一致性管线接入 - QC / orchestrator / 放开 30-45-60`。
2. 真实 key 跑 30s（§3 第一条），把 Director 真实计划样本存进 `evals/runs/`，定视觉 QC 阈值。
3. 然后回到 M1.9 对账与 M3。
