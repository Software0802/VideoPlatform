# 会话交接 — 流光 · Lumen

| 字段 | 值 |
| --- | --- |
| 更新日期 | 2026-09-05 |
| 基线 | 工作区（未提交）。git 仍只有两次提交：`3038174 Initial commit`、`79675ec feat: 流光视频工作室 Lumen` |
| 环境 | Windows 11 / PowerShell，`D:\dev\repos\VideoPlatFrom`，Next.js 16.3.3，React 19.2.8，pnpm 10.33，three 0.185 |
| 门禁状态 | `tsc --noEmit` 绿；`eslint src` 绿；`pnpm test` 33 文件 / 142 用例绿（冷启动偶发超时，重跑即可） |
| 运行 | `pnpm dev` → http://localhost:3000；无密钥即 mock 模式。预览配置 `.claude/launch.json` → `lumen-dev` |

新会话先读本文，再按需读 `AGENTS.md`（规则）、`docs/design.md`（后端 as-built）、`DESIGN.md`（UI 规格）、`docs/plan.md`（里程碑）。

---

## 1. 本轮做了什么（2026-09-05）

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
- [ ] Playwright 冒烟（mock 模式：空态 / 提交并等待完成 / 点击存档进详情）尚未建立；目前只有人工验证。
- [ ] 移动端只做了基本折行（≤720px）；交接包是桌面优先，未提供移动稿。
- [ ] 失败态只在读数行显示赭红 `失败 / Failed` + 错误文案，没有重试按钮（旧 Turn 里的 retry 已随删除移除；`retryJob` 仍在 `lib/client/jobs.ts`）。
- [ ] 取消任务入口未做（`cancelJob` 仍在 `lib/client/jobs.ts`）。
- [ ] 服务健康 / 上游类型（原 `HealthStatus`）不再显示；`/api/health` 仍可用。
- [ ] 点阵场景 `mountDotField` 已移植但未挂载（Blueprint 未用）。

### 产品主线（沿用 `docs/plan.md`）

- [ ] **M1.1** 按模块分批 git 提交——现在整个业务代码仍活在工作区里，这是最大风险。
- [ ] **M2.4** QC + 把 Director / Keyframe / shot plan / stitch 接入 `orchestrator.execute` → 读取 `HARNESS_ENABLED` → 放开 30/45/60。
- [ ] **M1.9** 真实 key 冒烟并把 ticks 对账写入 `evals/runs/`（目录仍空）。
- [ ] **M2.0** 即梦 spike 缺凭据，阻塞 M4 尾帧硬锁。

## 4. 已知坑

- 内置浏览器面板在页面 `scrollY > 0` 时截图为纯纸色，但 DOM 与真实渲染正常。检查下方区块时用 `document.querySelector('.lm').style.transform = 'translateY(-Npx)'` 位移后截图，或在真实浏览器里看。
- `next dev` 会把 "This is NOT the Next.js you know" 块重新写进 `AGENTS.md`，保留它即可。
- `pnpm test` 冷启动偶发 1 个超时失败，重跑即绿；若持续失败再查。
- `public/lumina/*.webp` 是占位样片；`data/jobs/` 里已有若干 mock 成片（黑底水印片），存档在 `mix-blend-mode: screen` 下会显得几乎全蓝，这是素材问题不是样式问题。

## 5. 下一刀建议

1. 先做 **M1.1**：至少一次 `feat: Blueprint 首页重建` 提交把当前工作区固化。
2. 补失败态的重试 / 取消入口（一行赭红下划线链接即可，风格同 `Reuse ↑`）。
3. 然后回到 **M2.4**。
