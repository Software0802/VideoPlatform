# Genius（原 流光 / Lumen）— 视频工作室

深色沉浸的单屏工作室（`design_handoff/design_handoff_genius_home`）：黎明河面上写一句提示词，输入即进入工作室，左侧操作台把滤镜 / 色彩 / 镜头拼进提示词，右侧展览区看进度与成片，作品页是环形画廊。UI 只暴露三条路径——文生视频 / 图生视频 / 文生图；API 与 provider 层仍支持 Grok 原生参考生 / 编辑 / 延长。无上游密钥时走模拟模式。30 / 45 / 60 秒一致性管线（Harness）已接入，由 `HARNESS_ENABLED` 开关；mock 端到端已验证，真实 key 的质量与成本验收仍待完成（见 `docs/handoff.md`）。

新会话先读 [`docs/handoff.md`](docs/handoff.md)。

## 运行

```bash
cp .env.example .env.local
# 没有密钥时走模拟模式（ffmpeg 水印片）
pnpm install
pnpm test
pnpm dev
```

打开 http://localhost:3000

### 真出片：官方 xAI 或 Sub2API

后台视频/图片走同一套 REST（`/v1/videos/generations|edits|extensions`、`/v1/images/generations`）。任选一条：

**官方 API key（按秒计费）**

```
XAI_API_KEY=xai-...
XAI_BASE_URL=https://api.x.ai/v1
```

**Sub2API 反代（Grok 订阅 / 拼车）**

本仓库不内嵌 Sub2API。先自行部署 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，在管理端加入 Grok OAuth 订阅账号（或 xAI API key 账号），建分组并打开 **image-generation** 权限，再签发 `sk-` 密钥。

```
SUB2API_API_KEY=sk-...
XAI_BASE_URL=http://127.0.0.1:8080/v1
UPSTREAM_TIMEOUT_MS=30000
UPSTREAM_RETRY_BASE_MS=250
```

只填 `SUB2API_API_KEY`、不填 `XAI_BASE_URL` 时，默认打本地 `http://127.0.0.1:8080/v1`。同时填了 `XAI_API_KEY` 时优先走官方 key。

**可选：可灵（Kling）直连视频**（工作区改动，详见 `docs/plan-kling-video.md` 与 `docs/handoff.md` §0）——设置 `KLING_API_KEY` 与 `VIDEO_PROVIDER=kling` 后，文生视频 / 图生视频改走可灵开放平台，价格约为 xAI 的三分之一；参考生视频 / 编辑 / 延长与长片仍固定在 xAI。变量说明见 `.env.example`。

Sub2API 的 Grok 媒体路由与 xAI 字段兼容；OAuth 订阅号需要付费权益探测通过才会接图/视频，否则上游返回 `503 grok_media_no_eligible_account`。

### 视频链路冒烟

先启动本地 Sub2API，并确认 Grok 分组已开启 **image-generation** 权限。把密钥只写在本机 `.env.local`（不要提交，也不要粘贴到聊天）：

```bash
SUB2API_API_KEY=sk-...
XAI_BASE_URL=http://127.0.0.1:8080/v1
```

然后启动 Lumen：

```bash
pnpm build
pnpm start
```

另开终端运行完整原生视频回路（T2V → I2V → R2V → Extend → Edit）：

```bash
pnpm run smoke:live
```

`smoke:live` 会先拒绝模拟模式，不会在上游不可用时静默生成假片；完成后报告每个 job 的状态、预估/实际成本和 Range 读取结果。没有订阅或只想验证本地 ffmpeg 时，可运行 `pnpm run smoke:mock`。

### 最小鉴权

设置 `LUMEN_ACCESS_TOKEN` 后，全部 `/api/*` 需要 `Authorization: Bearer <token>` 或 Cookie `lumen_token`。工作室打开时若收到 401，会提示输入令牌并写入 HttpOnly Cookie。未设置该变量时视为本地单用户。

**不要把开发端口暴露到公网。** 未设令牌时，排队任务会直接消耗上游额度。

## 文档

- 会话交接（当前状态 / 已完成 / 未完成）：[`docs/handoff.md`](docs/handoff.md)
- 项目规则：[`AGENTS.md`](AGENTS.md)
- 当前设计（as-built）：[`docs/design.md`](docs/design.md)
- UI 设计系统（Blueprint 首页）：[`DESIGN.md`](DESIGN.md)；原始交接包 `design_handoff/design_handoff_lumen_blueprint/`
- 阶段计划：[`docs/plan.md`](docs/plan.md)
- 审查报告：[`docs/review-2026-09-02.md`](docs/review-2026-09-02.md)（架构与 UI 重构）、[`docs/review-2026-08-29.md`](docs/review-2026-08-29.md)
- Phase 0 历史设计：[`docs/architecture.md`](docs/architecture.md)
