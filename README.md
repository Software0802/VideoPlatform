# 流光 / 视频工作室

Web 工作室。当前可演示：文生图、文生视频，以及 Grok 原生图生 / 参考生 / 编辑 / 延长。无上游密钥时走模拟模式。Harness Director 的严格规划模块已落地并可单独验证；完整长视频一致性管线仍未启用。

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

- 当前设计（as-built）：[`docs/design.md`](docs/design.md)
- 阶段计划：[`docs/plan.md`](docs/plan.md)
- 审查报告：[`docs/review-2026-08-29.md`](docs/review-2026-08-29.md)
- Phase 0 历史设计：[`docs/architecture.md`](docs/architecture.md)
