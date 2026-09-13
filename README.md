# Genius（原 流光 / Lumen）— 视频创作平台

侧栏 + 五视图的深色 App（`design_handoff/design_handoff_genius_app`）：主页瀑布流看真实作品，创作页跟进当前任务，悬浮创作面板接后端出片；智能体（提案审批制 LLM 编排）、画布（节点 DAG 运行）、订阅（余额 / 会员积分池 / 礼品码）都接真实后端。上游由**多家供应商按能力路由**：`VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER` 的次序决定优先级，命中条件是有 key、声明支持该模式、未被判耗尽、接得下画幅 / 分辨率 / 尾帧（`src/lib/providers/router.ts`）。`edit_video` / `extend_video` 已从路线图移出：API 与 provider 层保留、UI 置灰，等有中转承接（目前只有 grok 声明支持，ORDER 内没有可用 provider 承接时提交返回 503 `no_provider_available`）。无上游密钥时走模拟模式。30 / 45 / 60 秒一致性管线（Harness）已开放（生产 `HARNESS_ENABLED=true`）——shot 路由是通用 `t2v/i2v/r2v`、续接走「尾帧→i2v」，按 i2v+t2v 能力走 `VIDEO_PROVIDER_ORDER`（可灵 / YMan 都能承接）；可灵 30s 长片已真实成片（三视图角色表 + 档A 每镜首帧生效，见 `docs/acceptance-2026-09-13.md`）。

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

也可以让用户自己充值：管理员用 `node scripts/mint-gift-codes.mjs <数量> <金额> [--note "..."]` 铸礼品码（打印到标准输出，不写日志），用户在订阅页「兑换礼品码」输入即可到账（`POST /api/me/redeem`，详见 `docs/design.md` §5 与 `docs/handoff.md` §0）。

首次启用创作模板前，把示例种子拷进数据目录（不随代码自动生成）：

```bash
cp -r data-seed/templates data/templates
```

账号运维新增三个 CLI（`docs/handoff.md` §0）：

```bash
node scripts/reset-password.mjs <邮箱> <新密码>   # 管理员强制重置某账号密码
node scripts/disable-user.mjs <邮箱> --disable    # 封禁账号（--enable 解封）
node scripts/usage.mjs --days 7                   # 按天/用户/provider 统计用量并与流水对账
```

界面上的「模型」下拉列的是产品名（不露供应商），内置七档见 `src/lib/products/catalog.ts`，可用 `.env.example` 里的 `LUMEN_PRODUCTS`（JSON）按 id 覆盖或追加档位。

可选：配置 `KLING_API_KEY`（可灵直连视频）、`YMAN_API_KEY`（YMan 中转，视频 + 生图）或 `OPENAI_API_KEY`（文生图走 OpenAI 兼容 provider），并用 `VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER` 声明各自的优先级次序——配了 key 却没写进 ORDER 的 provider 不会被选中；一把 key 都没有才走模拟模式。`DATA_DIR` 默认 `./data`。

`docs/handoff.md` §0 新增的环境变量：`SHARE_TTL_HOURS`（分享链接有效期，默认 24 小时）、`ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_TIMEOUT_MS`（运维告警出站地址，不设则不外发）、`UPSTREAM_POLL_MAX_MS`（轮询阶梯上限，默认 10000）、`MAX_QUEUED_JOBS_PER_USER`（单账号同时在途任务数上限，默认 5）、`YMAN_TASK_TIMEOUT_MS`（YMan 任务本地等待上限，默认 900000）、`OPENAI_IMAGE_EDITS_ENABLED` / `YMAN_IMAGE_EDITS_ENABLED`（生图通道开 `/images/edits` 图生图，默认关；ccgoai 已实测透传）、`HARNESS_QC_VISUAL_MODEL`（Harness 视觉 QC 模型，未设用 agent 模型）、`HARNESS_LLM_TIMEOUT_MS`（Harness 的 Director / 视觉 QC 调用超时，默认 120000）。说明见 `.env.example`。

### 真出片：配置供应商

平台通过多家中转站 / 直连供应商协作出片。路由按 `VIDEO_PROVIDER_ORDER`（逗号分隔，取值 `kling|yman|grok`，代码默认 `grok`；兼容旧开关 `VIDEO_PROVIDER=kling` 视为 `kling,grok`）与 `IMAGE_PROVIDER_ORDER`（取值 `openai|yman|grok`，默认 `openai,grok`）的次序，取第一个「配了 key、声明 `capabilities().modes` 支持该模式、未被判定积分耗尽、（视频）接得下请求画幅 / 分辨率 / 尾帧」的 provider。一家可用的都不剩但配了真 key 时提交返回 503 `no_provider_available`，绝不静默落 mock。生产实例（2026-09-13 探查）：`VIDEO_PROVIDER_ORDER=kling,yman,grok`、`IMAGE_PROVIDER_ORDER=openai,yman`，配了 OpenAI 兼容 / 可灵 / YMan / 智能体四把 key，未配 xAI。下面是三家生产在用的供应商：

**可灵（Kling）直连视频**（详见 `docs/design.md` §2c）——文生视频 / 图生视频走可灵开放平台新系统 API，声明 `supportsLastFrameLock`（首尾帧锁，i2v 专属，强制 1080p）；时长枚举只有 5/10 两档，服务端向上归一并写回 `job.durationSec`。国际版账号必须用 `api-singapore.klingai.com`。变量：`KLING_API_KEY`、`KLING_BASE_URL`、`KLING_VIDEO_MODEL`（默认 `kling-2.6`）、`KLING_VIDEO_RESOLUTION`、`KLING_VIDEO_AUDIO`、`KLING_USD_PER_UNIT`（默认 0.10）、`KLING_TASK_TIMEOUT_MS`，详见 `.env.example`。

**OpenAI 兼容生图中转（生产用 ccgoai，`OPENAI_BASE_URL=https://ccgoai.club/v1`）**——文生图走 OpenAI Images 兼容 API，生产模型 `gpt-image-2`；`OPENAI_IMAGE_FLEXIBLE_SIZES=1` 时七画幅原生出图零裁切，按 `OPENAI_IMAGE_PRICE_TABLE`（画质档 × 尺寸档，单位为上游额度）计价；上游可回 202 异步任务（`OPENAI_IMAGE_TASK_TIMEOUT_MS` 管总时限），生成 POST 一旦接受即计费、固定不重发。变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_IMAGE_MODEL`、`OPENAI_IMAGE_*`，详见 `.env.example` 与 `docs/design.md` §2b。

**YMan 中转渠道**（视频 + 生图，`https://vip.yman.cc/v1`，详见 `docs/design.md` §2e）——视频三步 `POST /videos` → `GET /videos/{id}` → `GET /videos/{id}/content`（取片也要带 Bearer）；声明 t2v / i2v / r2v / t2i，参考生视频走这条。视频模型 ID 必须用上游 `GET /v1/models` 的**展示名**（默认 `YMAN_T2V_MODEL=minimax-h3`、`YMAN_I2V_MODEL=minimax-h3-933-图文`，旧名 `minimax-H3 文字` 作别名识别），生图默认 `YMAN_IMAGE_MODEL=gpt-image-2`；一家上游积分用完（`quota_exhausted`）会被自动标记耗尽 `PROVIDER_EXHAUSTED_TTL_MS`（默认 6 小时）并改走下一家，用户报价只降不升。全部变量说明见 `.env.example`。

**可选：xAI（官方或 Sub2API 反代）**——grok provider（`src/lib/providers/grok/`）走 xAI REST（`/v1/videos/generations|edits|extensions`、`/v1/images/generations`），声明全部六个模式（含目前只有它声明的 `edit_video`/`extend_video`）。官方 key：`XAI_API_KEY` + `XAI_BASE_URL=https://api.x.ai/v1`。Sub2API 反代：自行部署 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，建分组开 **image-generation** 权限后签发 `sk-` 密钥，填 `SUB2API_API_KEY`（不填 `XAI_BASE_URL` 时默认打本地 `http://127.0.0.1:8080/v1`；同时填了 `XAI_API_KEY` 时走官方 key）。OAuth 订阅号需付费权益探测通过才接图/视频，否则上游返回 `503 grok_media_no_eligible_account`。

### 视频链路冒烟

`pnpm run smoke:live`（`scripts/smoke-lumen.mjs --require-live`）跑的是 xAI 原生五模式回路（T2V → I2V → R2V → Extend → Edit）：`extend_video` / `edit_video` 目前只有 grok provider 声明支持，因此这条冒烟**依赖 XAI key 或 Sub2API 反代**（先起本地 Sub2API 并把 `SUB2API_API_KEY`/`XAI_BASE_URL` 写进本机 `.env.local`，不要提交）；生产没配 xAI 时 Edit/Extend 两段会失败。它先拒绝模拟模式，不会在上游不可用时静默生成假片；完成后报告每个 job 的状态、预估/实际成本和 Range 读取结果。没有订阅或只想验证本地 ffmpeg 时，可运行 `pnpm run smoke:mock`。

### CI

`.github/workflows/ci.yml` 在 push `main` 与所有 PR 上跑 `tsc --noEmit` → `eslint src` → `pnpm test`（与本地门禁一致），不跑 `pnpm e2e`。

## 文档

- 会话交接（当前状态 / 已完成 / 未完成）：[`docs/handoff.md`](docs/handoff.md)
- 项目规则：[`AGENTS.md`](AGENTS.md)
- 当前设计（as-built）：[`docs/design.md`](docs/design.md)
- UI 设计系统（Genius App 换壳）：[`DESIGN.md`](DESIGN.md)；原始交接包 `design_handoff/design_handoff_genius_app/`
- 阶段计划：[`docs/plan.md`](docs/plan.md)
- 审查报告：[`docs/review-2026-09-02.md`](docs/review-2026-09-02.md)（架构与 UI 重构）、[`docs/review-2026-08-29.md`](docs/review-2026-08-29.md)
- Phase 0 历史设计：[`docs/architecture.md`](docs/architecture.md)
