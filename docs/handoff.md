# 会话交接 — 流光 · Lumen

| 字段 | 值 |
| --- | --- |
| 更新日期 | 2026-09-05 |
| 基线 | `ee1ac26 feat: 失败态重试 / 取消入口与 mock 失败标记`；本轮（Playwright 冒烟 + Playwright MCP）尚在工作区 |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33，three 0.185 |
| 门禁状态 | `tsc --noEmit` 绿；`eslint src` 绿；`pnpm test` 33 文件 / 143 用例绿（冷启动偶发超时，重跑即可）；`pnpm test:e2e` 5 条绿（约 1 分钟，含 build） |
| 运行 | `pnpm dev` → http://localhost:3000；无密钥即 mock 模式。预览配置 `.claude/launch.json` → `lumen-dev` |

新会话先读本文，再按需读 `AGENTS.md`（规则）、`docs/design.md`（后端 as-built）、`DESIGN.md`（UI 规格）、`docs/plan.md`（里程碑）。

---

## 1. 本轮做了什么（2026-09-05）

### 1d. 文档收敛

删除 `IDEA.md`（一句话）与 `PRODUCT.md`（暗场 / 钨丝灯方向，与 Mono-Color 冲突；仍成立的四条原则并入 `DESIGN.md` 「产品原则」）。`docs/architecture.md` 与两份 review 移到 `docs/archive/`，rev 3 仍成立的决策摘进 `docs/design.md` §12。`docs/plan.md` 删去与本文重复的「现状盘点」。现行文档只剩：`AGENTS.md`、`README.md`、`DESIGN.md`、`docs/design.md`、`docs/plan.md`、本文。


### 1c. Playwright 冒烟 + Playwright MCP（2026-09-05 晚）

| 文件 | 改动 |
| --- | --- |
| `playwright.config.ts` | Chromium 单 worker；无 `PLAYWRIGHT_BASE_URL` 时 `pnpm build && pnpm start -p 3100`，环境 `LUMEN_FORCE_MOCK=1`、`DATA_DIR=.tmp/e2e-data`，不污染 `data/jobs`；headless 加 SwiftShader 参数供 three.js |
| `e2e/smoke.spec.ts` | 5 条：空态 / 文生视频到 Done 与下载链接 / 图生视频首帧上传自动切路径 / `[fail]` 失败后 Retry 换新 Job / 存档进详情与 Reuse 回填 |
| `package.json` | `test:e2e`；devDep `@playwright/test` |
| `.mcp.json` | Playwright MCP（`npx @playwright/mcp@latest`），agent 探索式验证用 |
| `.gitignore` | `.playwright-mcp/`、`playwright-report/` |
| `AGENTS.md` | 验证门禁加 e2e 与 MCP 说明 |


### 1b. 失败态重试 / 取消入口（2026-09-05 晚）

| 文件 | 改动 |
| --- | --- |
| `src/components/lumen/LumenHome.tsx` | 读数区块新增 `.readout__actions`：进行中显示「取消任务 / Cancel」，`failed / expired` 显示「重新生成 / Retry」，样式同 `Reuse ↑` 的 `link-accent`。取消改写当前任务；重试是服务端复制出的新任务，直接替换 `job` 并 upsert 进存档 |
| `src/app/globals.css` | `.readout__actions` 与 disabled 态 |
| `src/lib/providers/mock.ts` | 新增 `MOCK_FAIL_MARKER = "[fail]"`：提示词含它时 `submit` 抛 `ProviderHttpError(502, "mock_failure")`，用来在 mock 模式下稳定制造失败任务 |
| `src/lib/providers/mock.test.ts` | 补失败标记用例 |
| `.claude/launch.json` | `autoPort: true` |

已验证（mock，内置浏览器 + curl）：提示词 `[fail]` → 读数赭红 `失败 / Failed` + 错误文案 + Retry 链接 → 点击后换成新 Job 号；普通任务提交后立刻点 Cancel → `失败 / Canceled · 已取消`。

### 1a. 首页重建

按 `design_handoff/design_handoff_lumen_blueprint/README.md` 在 `src/app` 重建首页，替换 09-02 的 Agent 会话页。

### 新增 / 重写

| 文件 | 作用 |
| --- | --- |
| `src/components/lumen/LumenHome.tsx` | 单页首页，唯一客户端状态所有者：prompt / mode / ratio / dur / 首尾帧 / tray / job / 画廊滚动与拖拽 / detail |
| `src/components/lumen/marks.tsx` | `SectionRule / RegistrationMark / RuledDataStrip` 三个设计系统标记 |
| `src/lib/scene/lumen-three.ts` | 纯 three.js 三场景 `mountReel / mountWall / mountDotField`（从交接包 `lumen-three.js` 移植，TS 化，补 dispose，THREE.Clock 换自写计时器） |
| `src/components/scene/SceneHost.tsx` | 通用 canvas 挂载器：`mount(canvas) => handle`，卸载时 dispose，换 `key` 重建 |
| `src/app/page.tsx` | server 读 `listJobRecords` 前 40 条 + mock 标记，渲染 `LumenHome` |
| `src/app/layout.tsx` | `next/font/google`：Libre Bodoni / Courier Prime / Jost / Noto Sans SC |
| `src/app/globals.css` | 全部重写为 Mono-Color 令牌与 BEM 类；`AccessTokenPrompt` 的 `.dialog / .field / .btn` 同步换墨 |
| `src/lib/client/labels.ts` | 从 `components/agent/labels.ts` 迁入（状态文案 / 阶段索引 / 计时） |
| `AGENTS.md` / `DESIGN.md` / `docs/design.md §6` / `README.md` / `docs/plan.md` | 规则与文档同步 |

### 删除（无引用）

`src/components/agent/*`（Backdrop / Composer / SessionShell / Sidebar / Thread / Turn）、`src/components/shell/HealthStatus.tsx`、`src/lib/studio-kind.ts` 及其测试、`types/scene.ts` 里的 `SceneSkinId`。依赖卸载：`@react-three/fiber`、`@react-three/drei`、`@phosphor-icons/react`。

### 已验证（mock 模式，内置浏览器）

- 首屏、三条路径、环形画廊、存档、任务详情、Footer 与 Blueprint 一致。
- 文生视频：输入 → Generate → 读数 `Job XXXX / 阶段 / 计时 / 百分比` → 卷盘加速 → `Done` → 成片区块出现（视频可播、可下载）。
- 图生视频：首帧经 `/api/uploads`（role=start）上传后缩略显示、自动切到图生视频、请求带 `startUploadId`，任务完成。
- 折叠面板：路径单选、模型下拉（切图片模型自动切文生图）、时长 / 画幅按钮、首尾帧按钮。
- 画廊点击进入详情并平滑滚动；`Reuse ↑` 回填提示词并滚顶。

## 2. 与交接包的差异（有意为之）

| 项 | 交接包 | 实现 | 原因 |
| --- | --- | --- | --- |
| 模型下拉 | 三项，含 `grok-imagine-video · fast` | 两项：`grok-imagine-video` / `grok-imagine-image` | `createJobBodySchema` 是 strict，没有 `model` 字段；服务端按 mode 定模型 |
| 画廊张数 / 半径 | 8 张、R=7.2 | 最近 12 张、`R = max(7.2, n×0.9)` | 真实成片超过 8 张时按设计半径会重叠 |
| 样片 | 固定 8 张 `assets/lumina` | 有真实成片用真实成片；没有才回落 `public/lumina` 并标 `SAMPLE` | 存档要反映真实任务 |
| 成本行 | 固定公式 | 真实任务用 `costUsdActual ?? costUsdEstimate`；样片用 `estimateCostUsd` | 同上 |
| 首屏底部 | 两条说明 | mock 模式多一条赭红 `Mock · 模拟输出` | 告知用户当前不是真出片 |
| SectionRule 墨色 | 设计系统默认 board ink `#242321` | 钴蓝 | 页面只允许两种墨 |

## 3. 未完成 / 待办

### 首页相关（小）

- [ ] 「video · fast」变体：若要支持，需在 `createJobBodySchema` 加 `model`（或 `speed`）字段并在 rest-map 映射，再把下拉恢复三项。
- [x] Playwright 冒烟 5 条（2026-09-05）。取消用例未写：mock 任务 1 秒完成，没有稳定窗口。
- [ ] 移动端只做了基本折行（≤720px）；交接包是桌面优先，未提供移动稿。
- [x] 失败态重试链接（2026-09-05）。
- [x] 取消任务入口（2026-09-05）。取消窗口很短：mock 视频约 1 秒即完成，真实 Grok 才有意义。
- [ ] 服务健康 / 上游类型（原 `HealthStatus`）不再显示；`/api/health` 仍可用。
- [ ] 点阵场景 `mountDotField` 已移植但未挂载（Blueprint 未用）。

### 产品主线（沿用 `docs/plan.md`）

- [x] **M1.1** 首页重建已固化为 `dc66201`；本轮改动待提交。
- [ ] **M2.4** QC + 把 Director / Keyframe / shot plan / stitch 接入 `orchestrator.execute` → 读取 `HARNESS_ENABLED` → 放开 30/45/60。
- [ ] **M1.9** 真实 key 冒烟并把 ticks 对账写入 `evals/runs/`（目录仍空）。
- [ ] **M2.0** 即梦 spike 缺凭据，阻塞 M4 尾帧硬锁。

## 4. 已知坑

- **mock 的 `poll` 是死代码**：`mockProvider.submit` 返回 `localVideoPath` 后 runner 直接进 `persisting`，从不轮询，所以 mock 里 3.5 秒的 pending 窗口从未生效，视频任务约 1 秒完成。要造失败用 `[fail]` 标记；要造慢任务得改 runner 或让 mock 不返回 `localVideoPath`。
- Next 16 同一目录只允许一个 `next dev`；若 3000 被遗留进程占着，`preview_start` 会启动失败（它会打印 PID），先结束旧进程再起。
- 内置浏览器面板在页面 `scrollY > 0` 时截图为纯纸色，但 DOM 与真实渲染正常。检查下方区块时用 `document.querySelector('.lm').style.transform = 'translateY(-Npx)'` 位移后截图，或在真实浏览器里看。
- `next dev` 会把 "This is NOT the Next.js you know" 块重新写进 `AGENTS.md`，保留它即可。
- `pnpm test` 冷启动偶发 1 个超时失败，重跑即绿；若持续失败再查。
- `public/lumina/*.webp` 是占位样片；`data/jobs/` 里已有若干 mock 成片（黑底水印片），存档在 `mix-blend-mode: screen` 下会显得几乎全蓝，这是素材问题不是样式问题。

## 5. 下一刀建议

1. 提交本轮：`test: Playwright 冒烟五条与 Playwright MCP 配置`。
2. 回到 **M2.4**（QC + Director / Keyframe / shot plan / stitch 接入 `orchestrator.execute`）。
3. 若要给取消写 e2e，先给 mock 加 `[slow]` 标记让 submit 延时几秒。
