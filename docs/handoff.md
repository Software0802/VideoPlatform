# 会话交接 — Genius（原 流光 · Lumen）

| 字段 | 值 |
| --- | --- |
| 更新日期 | 2026-09-05（晚，第三轮：预算门禁全覆盖 + 子代理调度） |
| 基线 | HEAD `6c01ba6`（M2.4 接入 + Playwright 冒烟已提交）；工作区未提交：审查 R01–R12 处理 + **Genius 单屏 UI 重构** + **第三轮**：Director / 角色表 / 视觉 QC 纳入预算预留、`uncertain_submit` 恢复决策、`costOverTarget` 软告警、新增子代理调度体系（`.claude/agents/`、`codex-review`）+ **第三轮续**：Codex 代码审查处置（崩溃重启预留重建、终态失败即时升级、`retryJob` 复制校验）+ Retry 禁用守卫（`retry-guard.ts`） |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33，three 0.185 |
| 门禁状态 | 2026-09-05 晚（第三轮收尾，含 Codex 审查处置 + Retry 守卫后最终重跑）：`tsc --noEmit` 绿；`eslint src e2e` 绿；`pnpm test` 42 文件 / 197 用例通过、1 条 skip；`pnpm e2e` 7 例通过（mock，1.9 分钟）；`pnpm run evals:check` 红（缺人物素材，预期） |
| 运行 | `pnpm dev` → http://localhost:3000；无密钥即 mock 模式。预览配置 `.claude/launch.json` → `lumen-dev`。本机 `.env.local`（不入库）已设 `HARNESS_ENABLED=1` |

新会话先读本文，再按需读 `AGENTS.md`（规则）、`docs/design.md`（后端 as-built，§6 前端 / §7 harness）、`DESIGN.md`（UI 规格，Genius 单屏）、`docs/plan.md`（里程碑）。

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

### 1c. Playwright 冒烟（2026-09-05 晚）

| 文件 | 作用 |
| --- | --- |
| `playwright.config.ts` | `testDir: e2e`，单 worker；`webServer` 用 `pnpm dev --port 3000` + `LUMEN_FORCE_MOCK=1 HARNESS_ENABLED=1`，`reuseExistingServer: true`（Next 16 同目录只能有一个 dev server）；base URL 用 `localhost` |
| `e2e/lumen.spec.ts` | 6 条：空态与三条路径 / 文生视频到成片（含 Range 206、下载链接、存档置顶）/ `[fail]` → Retry 换任务 → 取消 / 存档 → 详情 → Reuse 回填 / 首帧上传自动切图生视频且请求体带 `startUploadId` 无 `model` / 30s 长片读数推进到成片并核对 `shots` 与时长 |
| `package.json` | `pnpm e2e`、`pnpm e2e:ui`；`@playwright/test` 1.63 + Chromium 已装到本机 |

要点：`beforeEach` 等 `.hero canvas` 出现再操作（dev 模式水合慢，早点的 click 会被吞）；用 `127.0.0.1` 访问会 403（Next 16 dev origin 校验），必须 `localhost`。跑在已有 `data/` 上，不清库，用例都只看自己新建的任务。

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
- [x] Playwright 冒烟（2026-09-05，见 §1c）。未做：隔离 `DATA_DIR`（受 Next 16 单 dev server 限制，只能复用现有库）；CI 未接。
- [ ] 窄屏（≤ 900px）目前直接隐藏操作台，展览区与输入卡通栏；定稿以 1440+ 为准，手机端布局待设计。
- [ ] 「我的」导航项暂无页面（`aria-disabled`）。

### 产品主线

- [ ] **M1.9** 真实 key 冒烟并把 ticks 对账写入 `evals/runs/`（与上面合并做）。
- [ ] **M2.0** 即梦 spike 缺凭据，阻塞 M4 尾帧硬锁。
- [ ] **M3** skills / workflows / `awaiting_approval` 人审门。

## 4. 已知坑

- **mock 片必须有帧间变化**：harness QC 的 `freezedetect` 用 -60dB，任何"静帧慢推"经 x264 后都会被判冻帧。改 mock 出片时保留光漏叠层（或等价的运动）。**光漏必须在 RGB 空间混合**（`format=gbrp` 后再 `blend=screen`）：在 yuv420p 平面上 screen 会把 U、V 一起推高，整片和 poster 都会偏品红，与光漏颜色无关（2026-09-05 晚实测：原图阴影 [26,21,16] → YUV 混合 [48,12,42]，RGB 混合 [27,23,17]）。
- **mock 的 `poll` 现在有用了**：shot-executor 会真的轮询 mock（3.5s pending 窗口），每镜比 runner 直跑多等几秒；runner 单 clip 路径仍不轮询。
- 长片任务约 40–60 秒完成（mock，含 ffmpeg 编码），取消窗口足够长，可用来验证取消链路。
- Next dev 下 runner 是 `globalThis` 单例，改 runner / orchestrator 后新任务会用新模块，但已在 inflight 的任务用旧代码。
- 内置浏览器面板 `read_page` 偶尔返回 `Viewport: 0x0` / 旧 ref；点一下页面或重新 `read_page` 即可。滚动后截图空白问题仍在，用 `translateY` 位移法。
- `pnpm test` 冷启动偶发 1 个超时失败，重跑即绿。

## 5. 下一刀建议

1. `docs/plan.md` §6 1b：真实 key 跑一条 30s Harness，核对 Director 真实计划经 `lockPlan` 归一化后可执行、extend 镜 Files 上传与 QC 期望时长、账目完整（含本轮新增的 LLM 记账是否与真实 ticks 对得上，含 `LLM_RATE_USD_PER_MTOKEN` / `LLM_RESERVE_USD` 两组占位数字的核实）；结果写 `evals/runs/`。
2. `docs/plan.md` §6 1c：用校准样本定 `HARNESS_QC_VISUAL_THRESHOLD`。
3. `retry-guard.ts` 的说明文案对 mock 模式不准确（固定写「xAI 控制台」），以及 `"uncertain_submit"` 字面量在两处独立声明，可在下次动这块时顺手清理。
4. `interrupt_resume` 评测场景补「`submitting` 无 `remoteId`」窗口；角色表相关单测的 identity-sheet fixture 待补齐。
5. 然后回到 M1.9 对账与 M3。

## 2026-09-05：生成结果位置调整

按用户反馈，当前任务的图片或视频移到 Hero 内提示词输入框上方；完成后滚到结果，媒体使用 contain 完整显示。新增桌面视频位置断言和手机文生图位置断言。

## 2026-09-05 晚：审查 R01–R12 逐项处理

逐项结论与理由见 `docs/review-2026-09-05.md` §6。代码层改动：

| 文件 | 改动 |
| --- | --- |
| `src/lib/harness/shot-state.ts` / `shot-executor.ts` | shot `costUsd` 跨重试累计（`priorCostUsd`）、无 usage 标 `costUnknown`；新增 `beforeAttempt`（每次付费提交前，含自动重试）与 `ShotFailure.terminal`（直接 `needs_review`） |
| `src/lib/harness/orchestrator.ts` | `costUsdEstimate` 不再改写，改存 `costUsdPlanned`；`reserveBudget`（已支出 + 在途预留 + 本次目录价 ≤ 上限，账目不完整时重试停）；视觉 QC 首 / 中 / 尾三帧 + 用户首帧固定参考 + 身份门（`visualQcPasses`）；拼接后 `verifyFilmDuration`；Director / 视觉 QC token 记 `llmUsage` → `costIncomplete` |
| `src/lib/harness/visual-qc.ts` / `director.ts` / `llm-usage.ts` | completer 可回传 usage；`identity = min(face, hair, wardrobe)` |
| `src/lib/jobs/schema.ts` / `store.ts` / `create.ts` | public DTO 加 `costUsdPlanned`、`costIncomplete`；`retryJob` 对 harness job 继承计划与已成功镜（复制 `shots/`） |
| `src/components/lumen/LumenHome.tsx` | 成本不完整显示「≥」；长片 Retry 文案「重做失败分镜」 |
| `playwright.config.ts` / `e2e/lumen.spec.ts` | `CI` / `E2E_ISOLATED` 自起隔离服务（`DATA_DIR=test-results/e2e-data`）；`CI` / `E2E_REQUIRE_MOCK` 下非 mock 失败而非跳过 |
| `evals/prompts.json` / `rubric.md` / `README.md` / `scripts/validate-evals.mjs` / `evals/assets/` | 8 条 Harness 用例 + 评测协议；rubric v2（身份与技术项独立必过）；校验查素材；合成源视频 / 色板已入库，**人物照片待用户提供** |
| 新测试 | `src/lib/harness/budget.test.ts`、`src/lib/jobs/retry-harness.test.ts`；`orchestrator.test.ts` 加预算零提交用例 |
| 文档 | `docs/plan.md`（基线 / 四档状态 / §7 门禁表与待决事项）、`docs/design.md` §7.2、`README.md`、`PRODUCT.md`（仅追加附注）、`.claude/skills/video-prompt/SKILL.md` 通过标准 |

待用户决策：R01 产品范围收窄；R11 各工作包的工作量 / 预算 / 停止条件；`character-*.jpg` 素材来源；CI 托管平台。

门禁（本节改动后重跑）：`tsc --noEmit` 绿；`eslint src e2e playwright.config.ts scripts` 绿；`pnpm test` 全绿（含新增 `budget.test.ts` / `retry-harness.test.ts`）；`pnpm e2e` 7 例绿（复用 `lumen-dev`，mock）。`pnpm run evals:check` 为红（缺人物素材，预期）。

## 2026-09-05 晚：按 Genius 交接包重构 UI（深色单屏）

依据 `design_handoff/design_handoff_genius_home/`（README 规格 + `Lumen v2.dc.html` 定稿），把 Mono-Color Blueprint 首页整体替换为深色沉浸单屏。品牌名改为 **Genius**，文案全中文。落地摘要与有意偏离见 `DESIGN.md`。

| 文件 | 改动 |
| --- | --- |
| `src/components/lumen/LumenHome.tsx` | 全部重写：三个视图（首页 / 工作室 / 作品）；输入即转场；操作台四组芯片飞入并以空行分段拼进提示词，手动编辑后按"是否仍含该段"同步选中态；展览区 idle / busy / done / failed 四态（取消 / 重新生成 / 重做失败分镜 / 下载 / 关闭）；作品环视频 / 图片分栏、拖拽、角度读数、再生成、下载；时长 / 画幅点击循环（harness 开启时时长追加 30/45/60 并在模型名后带预估）；「登录」打开访问令牌对话框 |
| `src/lib/scene/lumen-three.ts` | 换成 `mountDawn`（黎明河面 shader，`setEnergy`）与 `mountRingDark`（真图 + 倒影环，`setScroll / setAutoRotate / onTurn`），TS 化并补 dispose；旧 `mountReel / mountWall / mountDotField` 删除 |
| `src/app/globals.css` | 全部重写为深色玻璃语言（BEM）；进场动画关键帧只写 `from`，由根节点 `data-enter` 门控只播一次；展览区宽度多一项 `100cqh×16/9` 约束（`container-type: size`），防止输入卡长高时压到顶栏；窄屏（≤ 900px）隐藏操作台 |
| `src/app/layout.tsx` | 字体换成 Manrope + Noto Sans SC；标题 `Genius` |
| `src/components/shell/AccessTokenPrompt.tsx` | 错误行改用 `.dialog__error` 类（原 `--color-danger` 变量不存在） |
| 删除 | `src/components/lumen/marks.tsx`、`src/types/scene.ts`（随旧场景一起失去引用） |
| `e2e/lumen.spec.ts` | 7 条重写：空态 / 文生视频 + 操作台飞入 + 成片位置 / `[fail]` 重试与取消 / 作品环拖拽与再生成 / 首帧上传 / 30s 长片 / 手机端。以 `.app[data-ready]` 判断水合，`.exhibit[data-state|data-job-id|data-status]` 读任务态 |
| 文档 | `DESIGN.md` 重写；`AGENTS.md` 前端约定与门禁一节；`docs/design.md` §6；`docs/plan.md` UI / 场景两行；`README.md` 首段；`PRODUCT.md` 追加附注 |

要点 / 坑：

- 另一会话的 `next dev` 占着 3000 端口时，本会话的预览面板起不了第二个 dev server（Next 16 同目录单实例），也够不到 3000；改用 Playwright 直接连 3000 截图核对（脚本思路见本节 e2e）。`pnpm e2e` 照常复用 3000。
- Playwright 的 `toBeHidden` 不看 opacity，操作台未展开时用 `aria-hidden` + `toHaveCSS("opacity","0")` 断言；`getByRole("alert")` 会撞上 Next 的 `__next-route-announcer__`，用类名定位。
- 图生视频任务在作品页点「用这条提示词再生成」回落为文生视频（首帧无法从公开 DTO 复用）。
- 未做：「我的」页面；窄屏下的操作台（目前隐藏）；`Lumen Baseline (current).dc.html` 依赖的旧 `_ds` 目录已随旧交接包删除，仅作历史对照。

### 2026-09-05 晚：成片色彩还原（用户反馈"图片的色彩有很大问题"）

排查方法：用 Playwright 把 three 0.185 隔离出来渲染已知图片并 `readPixels`，再用 sharp 对比缩略 / 作品环 / poster 文件 / 原图同一位置的像素。结论与改动：

| 层 | 事实 | 改动 |
| --- | --- | --- |
| three 色彩管线 | `texture.colorSpace = SRGBColorSpace` + 默认 `outputColorSpace` 正确，dim=1 时渲染值与源图逐像素一致 | 无 |
| 作品环材质 | 原型的未悬停 `color 0.6`（线性）把画面压暗到约 77%，`opacity .98` 透出粉色地平线 | `mountRingDark` 平面改为白色、不透明；悬停改为放大 1.04（平面与倒影同步）；倒影仍 0.12 |
| mock provider 光漏 | `blend=all_mode=screen` 直接作用在 yuv420p 平面上，色度平面被 screen 一起推高 → 整片与 poster 偏品红，**与光漏用什么颜色无关**（中性灰照样品红） | 先 `format=gbrp` 再混合、最后 `format=yuv420p`；光漏颜色同时从旧设计的钴蓝 / 赭红改为中性灰。QC 冻帧检测仍过（30s 长片 e2e 绿；相隔 1s 两帧平均像素差约 3/255） |

验证：作品环平面与 poster 文件同位置像素一致（[64,24,58] / [64,24,58]）；新图生视频 poster 对原图：天空 [223,202,173] / [223,203,172]，阴影 [27,23,17] / [26,21,16]。首页缩略仍按定稿 `opacity .78`（悬停 1），这是层级设计而非偏色，如需也可改为 1。

## 2026-09-05 晚（第三轮）：预算门禁覆盖全部付费调用 + 子代理调度体系

按 `docs/plan.md` §6 「1a 预算与恢复补齐」执行：此前预算护栏只挡分镜提交，Director / 角色表 / 视觉 QC 三类付费调用不受约束；`recoverHarnessShot` 的 requeue 也会丢失 `costUnknown` 等账目字段。本轮补齐并引入子代理调度（coder / tester / reviewer-codex / doc-writer）分工执行，Codex 对 `docs/plan.md` 方案的独立审查已并入 plan.md（见该文件改动记录），本次代码审查仍在跑，结论未出。

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/lib/harness/llm-usage.ts` | `LlmUsage` 类型，Director / 视觉 QC completer 回传 token 用量的公共形状 |
| `src/lib/harness/budget-coverage.test.ts` | 覆盖 Director / 角色表 / 视觉 QC 预留是否生效、`costOverTarget` 触发时机 |
| `src/lib/harness/shot-recover.uncertain.test.ts` | `submitting` 且无 `remoteId` → `needs_review` + `uncertain_submit` 的恢复分支 |
| ~~`.claude/agents/{coder,tester,reviewer-codex,doc-writer}.md`~~ → 已迁入全局 skills 仓库 `agent-team/agents/`（`~/.claude/agents` 链接到它） | 子代理角色定义（通用版，项目差异写在 AGENTS.md「子代理调度」） |
| ~~`.claude/skills/codex-review/`、`scripts/codex-review.ps1` + 两份 prompt~~ → 已迁入全局 skill `codex-review`（Node 脚本 `scripts/codex-review.mjs` + `prompts/{plan,code}.md`；输出在 `~/.claude/state/codex-review/VideoPlatFrom/`） | 调用本机 Codex 桌面版 CLI（ChatGPT Plus 订阅，`gpt-6-astra` / medium）对方案或代码做独立审查 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/lib/cost.ts` | 新增 `LLM_RATE_USD_PER_MTOKEN`（grok-4.6 输入 $3 / 输出 $15 每百万 token，**列表价占位，未经 ticks 核实**）、`estimateLlmCostUsd`、`LLM_RESERVE_USD`（Director $0.30、视觉 QC $0.05，均为按最坏情况估的保守预留） |
| `src/lib/jobs/schema.ts` | `JobLlmUsage` 新增 `unpricedCalls` / `costUsd`（老 job.json 缺字段按 0，经 `normalizeLlmUsage`）；public DTO 新增 `costOverTarget`（软告警，不停任务） |
| `src/lib/jobs/store.ts` | 公开 DTO 透出 `costOverTarget` |
| `src/lib/harness/orchestrator.ts` | `budgetCap()` 抽出为纯函数，始终按提交时 `costUsdEstimate`（不用 `costUsdPlanned`）算上限；`guardPlannedBudget` 在 Director 出计划后、任何分镜提交前先校验整片是否超预算；`withReservation` 覆盖 Director / 角色表 / 视觉 QC 调用（reserve→run→release），`reserveShotBudget` 覆盖分镜提交与重试；`bookLlmUsage(jobId, usage \| null, model)` 记账并触发 `costIsIncomplete` / `markCostOverTarget`；`costIsIncomplete` 语义改为只看 `unpricedCalls` 与角色表 `costUnknown`（LLM 调用只要回了 usage 就按列表价计入，不再阻塞重试）；`costOverTarget` 在实际花费 > 提交预估 × 1.5 时置位一次并 `log warn`，不停任务，标志不回落；`visualScore` 改为 `return await`（原先漏 await 会在 finally 之前产生未处理的 rejection） |
| `src/lib/harness/director.ts` / `visual-qc.ts` | 接口加 `LlmUsageHooks`（`onUsage(LlmUsage \| null)`），每次调用完成（含失败）都回调一次，供 orchestrator 记账 |
| `src/lib/harness/shot-recover.ts` | 新增 `"review"` 决策：`submitting` 且无 `remoteId` 时无法判断上游是否已接单，直接 `needs_review` + `error.code = "uncertain_submit"`（避免重复扣费），文案见 `UNCERTAIN_SUBMIT_MESSAGE`；`requeue` 分支保留 `costUnknown` 字段，`priorCostUsd` 取 `max(costUsd, 原 priorCostUsd)` 防止账目被覆盖 |
| 既有测试 | `budget.test.ts` / `orchestrator.test.ts` / `shot-recover.test.ts` / `shot-executor.test.ts` / `run-persisted-plan.test.ts` / `state.test.ts` 同步新签名与新断言 |

### 已验证

`pnpm exec tsc --noEmit` 绿；`pnpm exec eslint src` 绿；`pnpm test` 41 文件 / 183 用例通过、1 条 skip（较改动前 39 文件 / 167 用例增加，新增两个测试文件贡献部分用例）。`pnpm e2e` 本轮未跑——未改 UI 组件、页面或 `/api/*` 路由，只改 harness 内部与 schema/store 的可选字段。

### 子代理调度体系（入口）

`AGENTS.md` 新增「子代理调度」与「Codex 审查分层」两节，是权威说明；简述：coder / tester / doc-writer 负责实现 / 测试 / 文档三块，reviewer-codex 通过 `codex-review` skill 调用本机 Codex CLI 做独立于 Claude 的方案或代码审查，产出的 P0/P1/P2 意见由主代理逐条核实后再采纳（不盲从）。详细流程、触发时机与产物位置见 `AGENTS.md` 对应两节。

### 未处理 / 下一刀新增事项（本轮暴露，续之前已修复部分见下一小节）

- LLM 价格（$3 / $15 每百万 token）是列表价占位，未用真实 key 的 ticks 核实，`LLM_RESERVE_USD` 的两个数字（$0.30 / $0.05）也是按最坏情况的保守估计，同样待核实。
- 角色表相关的测试用例仍跳过（缺 identity-sheet fixture），`skip` 计数未变化，不是本轮引入。
- `llmUsage` 未进入公开 DTO（只有派生出的 `costOverTarget` / `costIncomplete` 暴露），评测模板 `evals/rubric.md` §5 的成本项没有 LLM 分项，只看总成本。
- `docs/plan.md` §6 的 1b（真实 key 30s 冒烟）与 1c（视觉 QC 阈值校准）仍未开始。
- `interrupt_resume` 评测场景尚未补「`submitting` 无 `remoteId`」这个窗口。
- 上游自动对账（ticks vs `costUsdActual`）未做。

## 2026-09-05 晚（第三轮续）：Codex 代码审查处置 + Retry 守卫

对第三轮 diff（预算门禁全覆盖，未提交状态）跑了 Codex 代码审查（`review-20260905-192747-uncommitted.md`，原在项目 `.codex-reviews/`，迁移后此类输出统一放 `~/.claude/state/codex-review/VideoPlatFrom/`，VERDICT: BLOCK，3 条 P1），主代理逐条核实：1 条是误报（分镜进入 persisting 时费用已在 `attemptCost` 里入账，未改）；2 条成立并已修。另外 tester 发现一处结构问题一并修复。最后按用户决定新增 Retry 禁用守卫。

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/lib/jobs/retry-guard.ts` | `UNCERTAIN_SUBMIT_CODE`、`RetryBlock` 类型、`retryBlock(rec)`：扫 `harnessShots[].error.code`，命中 `uncertain_submit` 就按镜号升序拼中文说明，否则返回 `null` |
| `src/lib/jobs/retry-guard.test.ts` | 11 条：null 场景、镜级 vs job 级判定、升序拼接、`retryJob` 409 且未落盘、不误伤 `qc_visual` 等其他错误码、`toPublic` 深等 + schema parse、`jsonError` 转 409 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/lib/harness/orchestrator.ts` | 新增导出 `seedInFlightReservations(records, shots, reserved)`：`generateShots` 调度前对有 `remoteId` 的 `pending`/`submitting` 分镜按 `shotListPrice` 重建在途预留，修复 Codex P1「崩溃恢复后 pending 分镜不重建预留」 |
| `src/lib/harness/shot-executor.ts` | `executeShotOnce` 现在识别 `ShotFailure.terminal`，命中即刻 `needs_review`，不再先排一次重试（tester 指出的结构问题） |
| `src/lib/harness/budget.test.ts` | 新增「in-flight reservations survive a restart」「escalates a terminal failure raised mid-attempt without scheduling a retry」两条用例 |
| `src/lib/jobs/create.ts` | `retryJob` 复制成片目录后逐个 `access` 保留镜的 `outputPath`，缺文件即删新 job 目录并抛 `ProviderHttpError(500, "retry_copy_failed")`（修复 Codex P1「复制失败被 `.catch` 吞掉」）；`retryJobUnlocked` 在状态检查后、任何写入前调用 `retryBlock` 命中即抛 `ProviderHttpError(409, "retry_blocked", message)` |
| `src/lib/jobs/retry-harness.test.ts` | 新增「refuses to create the retry when a kept shot's clip cannot be copied」 |
| `src/lib/jobs/schema.ts` | `jobPublicSchema` 新增可空 `retryBlocked`；`JobRecord` 改为 `Omit<JobPublic, "retryBlocked"> & {...}`（派生字段不落盘） |
| `src/lib/jobs/store.ts` | `toPublic` 填 `retryBlocked: retryBlock(rec)` |
| `src/components/lumen/LumenHome.tsx` / `src/app/globals.css` | 失败 / 过期态且 `retryBlocked` 非空时不渲染重做按钮，改显示说明行（新增 `.exhibit__blocked` BEM 类，1px 顶线分隔，沿用现有令牌，无新增颜色）；`retry()` 内同样守卫 |

### 已验证

真实浏览器实测一条 45s mock 长片触发 `uncertain_submit`：接口返回 409、按钮消失、多镜说明用「、」连接。门禁：`tsc --noEmit` 绿、`eslint src e2e` 绿、`pnpm test` 42 文件 / 197 用例通过 + 1 skip、`pnpm e2e` 7 例通过（1.9 分钟）。

### 未处理

- `retry-guard.ts` 的说明文案固定写「xAI 控制台」，mock 模式下理论上也可能出现 `uncertain_submit`，文案对 mock 场景不准确（纯文案问题，不影响拦截逻辑）。
- `"uncertain_submit"` 字面量在 `shot-recover.ts` 与 `retry-guard.ts` 两处独立声明，待后续处理该边界时应抽成共享常量。
