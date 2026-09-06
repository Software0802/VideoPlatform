# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

# 项目规则（流光 · Lumen）

## 先读什么

- 交接文档 `docs/handoff.md`：当前状态、已完成 / 未完成、下一刀。每次会话从这里开始。
- 后端真相 `docs/design.md`（as-built）；阶段计划 `docs/plan.md`；UI 规格 `DESIGN.md`。
- 首页设计交接包 `design_handoff/design_handoff_genius_home/README.md`（规格）+ `Lumen v2.dc.html`（定稿原型），它们是首页像素级还原的依据。

## 前端约定（2026-09-05 晚起，Genius 单屏）

- 整站是 `src/components/lumen/LumenHome.tsx` 一个 100vh 单屏（`body overflow:hidden`），三个视图：首页 / 工作室（输入即转场：左操作台、右展览区、输入卡落底）/ 作品（环形画廊）。视觉是深色玻璃语言：页面 `#0a0d12`、卡片 `rgba(28,30,36,.92)`、描边 `rgba(214,228,255,.12)`、强调 `#DDE1E8`；圆角 26 / 22 / 12 / 9；文案全中文，品牌名 Genius。改 UI 前先读 `DESIGN.md`。
- 样式写在 `src/app/globals.css`（BEM 风格类名 + `@theme` 令牌），字体 Manrope + Noto Sans SC 经 `next/font/google`；不引入组件库，不用 `@react-three/fiber`、`drei` 或图标库（图标是内联 SVG）。
- three.js 只走 `src/lib/scene/lumen-three.ts` 的纯函数场景（`mountDawn` 黎明河面背景、`mountRingDark` 作品环），通过 `src/components/scene/SceneHost.tsx` 挂载；需要重建场景时换 `key`，不要在 render 中碰 ref。任务进行中 `dawn.setEnergy(1)`。
- 浏览器只经 `src/lib/client/jobs.ts` 和 `useJobLive.ts` 访问 `/api/*`；组件不直接 `fetch`。401 上抛后由页面弹 `AccessTokenPrompt`（顶栏「登录」也打开它）。
- UI 只暴露三条路径：文生视频 / 图生视频 / 文生图。时长与画幅是点击循环的芯片（`data-dur` / `data-ratio`）；`harnessEnabled()` 为真时时长循环追加 30 / 45 / 60（仅 t2v / i2v），展览区阶段行按 `job.shots` 显示「生成分镜 n/m」。`reference_to_video / edit_video / extend_video` 仍在 API 与 provider 层，不要从后端删除。
- 展览区生成中的「丝绸幕布」是 ThreeUI `WovenCloth`（iridescent）的注册源码，走 `src/components/lumen/ClothVeil.tsx` → `src/shaders/woven-cloth/`（srcDoc iframe，自带 three r160）。`woven-cloth-iridescent.html` 逐字对应注册哈希，不要手改；`*.html` 经 `next.config.ts` 的 raw-loader 规则作字符串导入。
- 操作台四组（滤镜 / 磨皮 / 色彩 / 镜头）每组单选，选中项的提示词以 `

` 分段追加进 textarea；用户手动编辑后按"文本是否仍含该段"同步选中态。
- `POST /api/jobs` 的请求体以 `src/lib/jobs/schema.ts` 的 `createJobBodySchema`（strict）为准，没有 `model` 字段，模型由服务端按 mode 决定。

## 后端约定

- 视频与图片走同一套 xAI REST（`/videos/generations|edits|extensions`、`/images/generations`），禁止 `openai.videos.*`。
- 尾帧只落盘，永不进入 Grok 请求体（golden test 保障）。源视频禁止 data URI 兜底。
- 状态先写 `data/jobs/{id}/job.json` 再发 SSE；轮询是真相。
- Harness（30/45/60 长视频）由 `HARNESS_ENABLED` 开关：未开启时 `orchestrator.execute` 抛 `HARNESS_NOT_ENABLED`、API 对 30/45/60 返回 400；开启后 `src/lib/harness/orchestrator.ts` 走 directing → keyframing → generating_shots → qc → stitching → persisting，30/45/60 永不直接发给 Grok（rest-map golden 保障）。mock 模式用 `mock-director.ts` 的确定性计划；视觉 QC 只在设置 `HARNESS_QC_VISUAL_THRESHOLD` 时启用。
- ffmpeg 一律经 `src/lib/ffmpeg.ts`（ffmpeg-static），不 spawn PATH 里的 ffmpeg。
- 文生图（`text_to_image`）设置 `OPENAI_API_KEY` 时改走 `src/lib/providers/openai-image/`（OpenAI 官方或兼容中转，如 ccgoai），未设置回落 xAI/mock，视频路径不受影响；路由见 `src/lib/providers/router.ts` `selectProvider`。上游可能 202 异步出图（`OPENAI_IMAGE_TASK_TIMEOUT_MS` 控制轮询总时限），生成 POST 一旦被接受即计费，故固定 `maxAttempts:1` 不自动重试。新增环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_IMAGE_MODEL`、`OPENAI_IMAGE_FLEXIBLE_SIZES`、`OPENAI_IMAGE_QUALITY`、`OPENAI_IMAGE_PRICE_TABLE`、`OPENAI_IMAGE_TIMEOUT_MS`、`OPENAI_IMAGE_TASK_TIMEOUT_MS`，说明见 `.env.example` 与 `docs/design.md` §2b。

## 验证门禁

- 改代码后依次跑：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`pnpm test`，三者绿才算完成。
- 改 UI 后跑 `pnpm e2e`（Playwright，`e2e/lumen.spec.ts`：空态 / 文生视频与操作台飞入 / `[fail]` 重试与取消 / 作品环与再生成 / 首帧上传 / 30s 长片 / 手机端成片位置，全部 mock 模式，约 2.5 分钟）。它会复用已在 3000 端口运行的 `next dev`（`lumen-dev` 预览），没有就自己起一个；`CI` 或 `E2E_ISOLATED=1` 时拒绝复用并用隔离 `DATA_DIR`，`CI` 或 `E2E_REQUIRE_MOCK=1` 时非 mock 直接失败而非跳过。base URL 必须是 `localhost`，`127.0.0.1` 会被 Next 16 dev 拒 403 导致不水合。仍可再用预览面板（或 Playwright 截图）人工看一眼河面与作品环。
- 内置浏览器面板在页面滚动后截图会空白，这是截图工具的问题；用 `translateY` 位移检查下方区块，或在真实浏览器里看。

## 安全与额度

- 密钥只在 `.env.local`，不进聊天、不进提交。
- 未设 `LUMEN_ACCESS_TOKEN` 时不要把开发端口暴露到公网。

## 部署

- 生产实例：阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service`，反代借用同机 taiyu 的 Caddy 容器。完整步骤（打包内容、服务器装依赖、Turbopack 别名软链的必做步骤、`output: "standalone"` 为何在 Windows→Linux 不可用）见 `docs/handoff.md` §0.4 与 `docs/design.md` §10.1。
- 部署机与构建机跨平台（Windows 构建、Linux 部署）时，`sharp`/`ffmpeg-static` 必须在部署机 `pnpm install --prod`，不能直接拷贝 Windows 的 `node_modules`。

# Skills

- 写或改视频 prompt、Director 系统提示、Identity Bible、`evals/prompts.json` 时，先用 `/video-prompt`。
- 被用户纠正时用 `/fb video-prompt <原因与期望>` 记录；反馈积累后用 `/improve-skill video-prompt` 提改进 PR。
- 人工评分写入 `evals/runs/YYYY-MM-DD.json`（格式见 `evals/rubric.md`），它是 improver 的主要信号源。

# 子代理调度

本项目使用全局子代理团队（`~/.claude/agents/`，来自 skills 仓库 `agent-team`），调度顺序与 Codex 审查分层见全局 CLAUDE.md「子代理调度」。项目差异只有下面几行：

- 验证门禁：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`pnpm test`；改 UI 后再跑 `pnpm e2e`（详见上文「验证门禁」）。
- 高风险代码（Codex 按需审 diff）：`src/lib/harness/`（预算与并发、崩溃恢复、QC / stitch）、`src/lib/jobs/`（状态机、Retry、schema）、`src/app/api/`（鉴权与请求体校验）、`src/lib/ffmpeg.ts`、`src/lib/providers/grok/`（rest-map、尾帧与 data URI 约束）。
- 交接文档：`docs/handoff.md`；设计文档：`docs/design.md`（后端 as-built）、`DESIGN.md`（UI）；计划：`docs/plan.md`。
- 硬约束见上文「前端约定 / 后端约定」；Codex 审查会先读本文件。想给 Codex 加审查重点，放 `.claude/codex-review/plan.md` 或 `code.md`。
- 用户 2026-09-05 决定：跨厂商审查用在决策与高风险代码上，普通代码不审；Codex 走 ChatGPT plus 额度，同一份对象不重复审。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
