# Genius（原 流光 / Lumen）— 视频工作室

深色沉浸的单屏工作室（`design_handoff/design_handoff_genius_home`）：黎明河面上写一句提示词，输入即进入工作室，左侧操作台把滤镜 / 色彩 / 镜头拼进提示词，右侧展览区看进度与成片，作品页是环形画廊。UI 只暴露三条路径——文生视频 / 图生视频 / 文生图；API 与 provider 层仍支持 Grok 原生参考生 / 编辑 / 延长。无上游密钥时走模拟模式。30 / 45 / 60 秒一致性管线（Harness）已接入，由 `HARNESS_ENABLED` 开关；mock 端到端已验证，真实 key 的质量与成本验收仍待完成（见 `docs/handoff.md`）。

新会话先读 [`docs/handoff.md`](docs/handoff.md)。

## 运行

```bash
cp .env.example .env.local
# 必须设置 LUMEN_SESSION_SECRET（任意长随机串），缺失服务会拒绝启动——会话 Cookie 靠它签名
# 没有任何生图/视频 key 时走模拟模式（ffmpeg 水印片）
pnpm install
pnpm test
pnpm dev
```

打开 http://localhost:3000 会被 307 到 `/login`：这是多用户实例，注册需要一次性邀请码。

```bash
# 生成 N 个一次性邀请码（打印到标准输出，不写日志）
node scripts/mint-invites.mjs 5 --note "内测第一批"
# 用其中一个码在 /login 的注册 tab 建号，登录后即可提交任务
```

新账号余额为 0（2026-09-06 起定价 × 余额是提交的主闸门，见 `docs/design.md` §2d），管理员用下面的 CLI 充值：

```bash
node scripts/grant-balance.mjs <邮箱> 20 --note "内测赠送"
```

可选：设置 `KLING_API_KEY`（可灵直连视频，见下）或 `OPENAI_API_KEY`（文生图走 OpenAI 兼容 provider，见 `.env.example` 的 `OPENAI_*` 段）；都不设时视频 / 图片各自回落 xAI 或模拟模式。`DATA_DIR` 默认 `./data`。

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

**可选：可灵（Kling）直连视频**（详见 `docs/plan-kling-video.md` 与 `docs/handoff.md` §0c）——设置 `KLING_API_KEY` 与 `VIDEO_PROVIDER=kling` 后，文生视频 / 图生视频改走可灵开放平台，价格约为 xAI 的三分之一；参考生视频 / 编辑 / 延长与长片仍固定在 xAI。变量说明见 `.env.example`。

**可选：YMan 中转渠道**（视频 + 生图，详见 `docs/design.md` §2e 与 `docs/handoff.md` 本轮小节）——设置 `YMAN_API_KEY` 后自动参与路由（默认次序 `VIDEO_PROVIDER_ORDER=kling,grok`、`IMAGE_PROVIDER_ORDER=openai,grok`，把 `yman` 加进对应的 ORDER 变量才会被选中，如 `VIDEO_PROVIDER_ORDER=yman,kling,grok`）。视频模型 ID 必须用上游 `GET /v1/models` 的展示名（默认 `YMAN_T2V_MODEL=minimax-H3 文字`、`YMAN_I2V_MODEL=minimax-h3-933-图文`），生图默认 `YMAN_IMAGE_MODEL=gpt-image-2`；一家上游积分用完（`quota_exhausted`）会被自动标记耗尽 `PROVIDER_EXHAUSTED_TTL_MS`（默认 6 小时）并改走下一家，用户报价不变。全部变量说明见 `.env.example`。

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

### CI

`.github/workflows/ci.yml` 在 push `main` 与所有 PR 上跑 `tsc --noEmit` → `eslint src` → `pnpm test`（与本地门禁一致），不跑 `pnpm e2e`。

## 文档

- 会话交接（当前状态 / 已完成 / 未完成）：[`docs/handoff.md`](docs/handoff.md)
- 项目规则：[`AGENTS.md`](AGENTS.md)
- 当前设计（as-built）：[`docs/design.md`](docs/design.md)
- UI 设计系统（Blueprint 首页）：[`DESIGN.md`](DESIGN.md)；原始交接包 `design_handoff/design_handoff_lumen_blueprint/`
- 阶段计划：[`docs/plan.md`](docs/plan.md)
- 审查报告：[`docs/review-2026-09-02.md`](docs/review-2026-09-02.md)（架构与 UI 重构）、[`docs/review-2026-08-29.md`](docs/review-2026-08-29.md)
- Phase 0 历史设计：[`docs/architecture.md`](docs/architecture.md)
