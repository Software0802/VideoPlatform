# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

# 项目规则（流光 · Lumen）

## 先读什么

- 交接文档 `docs/handoff.md`：当前状态、已完成 / 未完成、下一刀。每次会话从这里开始。
- 后端真相 `docs/design.md`（as-built）；阶段计划 `docs/plan.md`；UI 规格 `DESIGN.md`。
- 首页设计交接包 `design_handoff/design_handoff_lumen_blueprint/README.md`，它是首页像素级还原的依据。

## 前端约定（2026-09-05 起）

- 首页是单页 `src/components/lumen/LumenHome.tsx`，视觉遵循 Mono-Color 印刷语言：纸 `#F5F1E8`、钴蓝 `#2148B8` 主墨、赭红 `#C65F38` 辅墨；无圆角、无阴影、无渐变、无模糊，结构只靠 4 / 2 / 1px 规则线。改 UI 前先读 `DESIGN.md`。
- 样式写在 `src/app/globals.css`（BEM 风格类名 + `@theme` 令牌），不引入组件库，不用 `@react-three/fiber`、`drei` 或图标库。
- three.js 只走 `src/lib/scene/lumen-three.ts` 的纯函数场景（`mountReel / mountWall / mountDotField`），通过 `src/components/scene/SceneHost.tsx` 挂载；需要重建场景时换 `key`，不要在 render 中碰 ref。
- 浏览器只经 `src/lib/client/jobs.ts` 和 `useJobLive.ts` 访问 `/api/*`；组件不直接 `fetch`。401 上抛后由页面弹 `AccessTokenPrompt`。
- UI 只暴露三条路径：文生视频 / 图生视频 / 文生图。`harnessEnabled()` 为真时时长面板多出 30 / 45 / 60（仅 t2v / i2v），读数按 `job.shots` 显示分镜进度。`reference_to_video / edit_video / extend_video` 仍在 API 与 provider 层，不要从后端删除。
- `POST /api/jobs` 的请求体以 `src/lib/jobs/schema.ts` 的 `createJobBodySchema`（strict）为准，没有 `model` 字段，模型由服务端按 mode 决定。

## 后端约定

- 视频与图片走同一套 xAI REST（`/videos/generations|edits|extensions`、`/images/generations`），禁止 `openai.videos.*`。
- 尾帧只落盘，永不进入 Grok 请求体（golden test 保障）。源视频禁止 data URI 兜底。
- 状态先写 `data/jobs/{id}/job.json` 再发 SSE；轮询是真相。
- Harness（30/45/60 长视频）由 `HARNESS_ENABLED` 开关：未开启时 `orchestrator.execute` 抛 `HARNESS_NOT_ENABLED`、API 对 30/45/60 返回 400；开启后 `src/lib/harness/orchestrator.ts` 走 directing → keyframing → generating_shots → qc → stitching → persisting，30/45/60 永不直接发给 Grok（rest-map golden 保障）。mock 模式用 `mock-director.ts` 的确定性计划；视觉 QC 只在设置 `HARNESS_QC_VISUAL_THRESHOLD` 时启用。
- ffmpeg 一律经 `src/lib/ffmpeg.ts`（ffmpeg-static），不 spawn PATH 里的 ffmpeg。

## 验证门禁

- 改代码后依次跑：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`pnpm test`，三者绿才算完成。
- 改 UI 后跑 `pnpm e2e`（Playwright，`e2e/lumen.spec.ts`：空态 / 文生视频 / `[fail]` 重试与取消 / 存档详情 / 首帧上传 / 30s 长片，全部 mock 模式，约 1 分钟）。它会复用已在 3000 端口运行的 `next dev`（`lumen-dev` 预览），没有就自己起一个。base URL 必须是 `localhost`，`127.0.0.1` 会被 Next 16 dev 拒 403 导致不水合。仍可再用预览面板人工看一眼卷盘与画廊。
- 内置浏览器面板在页面滚动后截图会空白，这是截图工具的问题；用 `translateY` 位移检查下方区块，或在真实浏览器里看。

## 安全与额度

- 密钥只在 `.env.local`，不进聊天、不进提交。
- 未设 `LUMEN_ACCESS_TOKEN` 时不要把开发端口暴露到公网。

# Skills

- 写或改视频 prompt、Director 系统提示、Identity Bible、`evals/prompts.json` 时，先用 `/video-prompt`。
- 被用户纠正时用 `/fb video-prompt <原因与期望>` 记录；反馈积累后用 `/improve-skill video-prompt` 提改进 PR。
- 人工评分写入 `evals/runs/YYYY-MM-DD.json`（格式见 `evals/rubric.md`），它是 improver 的主要信号源。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
