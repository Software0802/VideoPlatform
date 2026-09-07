# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

# 项目规则（流光 · Lumen）

## 文档维护规则（用户 2026-09-07 定）

- 更新 `docs/handoff.md`、`docs/design.md`、`DESIGN.md`、`docs/runbook.md` 与本文件时，**直接改写成当前真实状态，只保留正确的内容**：过时的结论（「工作区未提交」「审查进行中」「仍是占位」「尚未部署」等）一旦不再成立就删掉或改成事实，不得以「已过时 / 不再适用」标注的方式留在原地，也不得靠追加新小节去覆盖旧小节。
- 交接文档描述的是「现在是什么」，不是变更日志；历史与决策过程留在 git log 与 `docs/plan-*.md`（计划文档顶部标状态即可，正文不改写）。
- 写进文档的每条事实都要在代码、配置或实测里能对上；对不上的是推断，要么去验证，要么不写。

## 先读什么

- 交接文档 `docs/handoff.md`：当前状态、已完成 / 未完成、下一刀。每次会话从这里开始。
- 后端真相 `docs/design.md`（as-built）；阶段计划 `docs/plan.md`；架构治理路线 `docs/plan-architecture-2026-09.md`（阶段二：作品管理 / 稳态 / 安全）；智能体 / 多语言 / 订阅定价方案 `docs/plan-agent-i18n-subscription-2026-09.md`；UI 规格 `DESIGN.md`；用户系统 / 配额 / 留存清理方案 `docs/plan-users-quota.md`。
- 前端设计交接包 `design_handoff/design_handoff_genius_app/README.md`（规格）+ `Genius App.dc.html`（定稿原型），它们是侧栏 + 五视图换壳的依据；实施记录与 DOM 契约见 `docs/plan-ui-genius-app.md`。

## 前端约定（2026-09-06 晚起，Genius App 换壳：侧栏 + 五视图 + 悬浮创作面板）

- 路由用 `src/app/(shell)/` 分组：`layout.tsx` 服务端校验会话、下发 provider 能力，`page.tsx`（主页）/`create/page.tsx`/`agent/page.tsx`/`canvas/page.tsx`/`subscription/page.tsx` 五个路由共享同一个 `GeniusShell`。组件在 `src/components/genius/`：`GeniusShell.tsx`/`ShellContext.tsx`（唯一客户端状态所有者，`useShell()`）/`Sidebar.tsx`/`TopBar.tsx`/`icons.tsx`/`composer/`（创作面板）/`home/`/`create/`/`agent/`/`canvas/`/`subscription/`。视觉是侧栏 `#0c0c0d` + 内容区 `#0a0a0b` 的深色 App 语言：卡片 `#131316`、悬浮面板 `#16161a`（不透明）、描边 `rgba(255,255,255,.07/.09)`、主强调渐变 `linear-gradient(90deg,#ff8a3d,#ff4d8d 60%,#a855f7)`；圆角 14–16 / 12 / 8–9；文案走多语言字典（简体中文默认 / English，见下「多语言」；画布的工具名与节点标签沿用原型英文占位，见 `DESIGN.md`「与交接包的有意偏离」），品牌名 Genius。改 UI 前先读 `DESIGN.md`。
- 样式：`src/app/globals.css` 覆盖壳 + 主页 + 创作面板 + 创作页 + 登录页；智能体 / 画布 / 订阅各自一个文件 `src/app/styles/{agent,canvas,subscription}.css`，由 `globals.css` 顶部 `@import` 引入。BEM 类名 + `data-*` 状态，不用 Tailwind 工具类，不引组件库 / 图标库（图标内联 SVG，收进 `icons.tsx`）；字体仍是 Manrope + Noto Sans SC 经 `next/font/google`。控件 reset 必须用 `:where()` 包住，否则会盖掉单类规则的权重；带 `transform` 动画的祖先会成为 `position:fixed` 元素的包含块，toast 一类浮层要放在动画层外面，不能指望 `fixed` 逃出去。
- **悬浮创作面板必须是 `main` 的兄弟节点**（锚在 `.col`，`position:absolute`），不能塞进滚动容器；`main` 不为它预留 `padding-bottom`。
- 浏览器只经 `src/lib/client/*`（`jobs.ts`/`auth.ts`/`useJobLive.ts`/`http.ts`）访问 `/api/*`；组件不直接 `fetch`。未登录访问任意 `(shell)` 路由服务端 307 到 `/login`；401 时整页跳转 `/login`（`window.location.assign`）。顶栏头像菜单（disclosure，非 `role=menu`）显示完整邮箱 + 「退出」。
- UI 只暴露三条真实路径：视频页「图文」模式（图片槽为空 → `text_to_video`，放图 → `image_to_video`）与图片页「默认」模式（`text_to_image`）；其余模式行渲染但 `aria-disabled="true"`，点击 toast「即将上线」。`POST /api/jobs` 请求体以 `src/lib/jobs/schema.ts` 的 `createJobBodySchema`（strict）为准，其中可选 `model` = **产品 id**（取值见 `GET /api/models`，该路由按白名单挑字段，不下发 `provider` 与上游 `model`），缺省时由服务端按 mode 路由决定；模型芯片是产品下拉，只露产品名。时长 / 画幅是弹层里的按钮网格（`data-dur`/`data-ratio`/`data-res`），枚举由服务端按 provider 能力下发；`harnessEnabled()` 为真时时长追加 30 / 45 / 60（仅 t2v / i2v），创作页当前任务区按 `job.shots` 显示「生成分镜 n/m」。`reference_to_video / edit_video / extend_video` 仍在 API 与 provider 层，不要从后端删除。
- 积分口径 **¥1 = 100 积分**，只用于顶栏与创作按钮的显示换算（`ShellContext.creditsOf`），余额模型与后端计费（`priceCny`）不变。
- 幂等：一次逻辑创作一个 `idempotencyKey`（`ShellContext` 里 `idempotencyKey.current ??= newIdempotencyKey()`），提交成功才清空；用户改了提示词或任一选项就作废重取。
- 作品管理（2026-09-06 深夜）：主页瀑布流按 `GET /api/jobs?before&limit&kind` 游标分页加载，不再一次拉全量；支持分类筛选、标签编辑（`PATCH /api/jobs/:id`）、删除（`DELETE /api/jobs/:id`）、分享复制链接、模板回填。全局通知（toast + 顶栏铃铛）读 `GET /api/events`（`src/lib/client/useEvents.ts`），只在当前会话内生效，刷新页面不保留历史。
- 多语言（2026-09-07 凌晨，`src/lib/i18n/`）：文案一律走 `useT("ns.key")`，不写死中文/英文字符串；命名空间归属按视图划分（`shell/home/composer/create/canvas/login/share/common/agent/subscription`），新增文案先确认该视图已有的命名空间文件，键名只在 `messages/zh-CN/<ns>.ts` 里新增（它是键的事实源），`messages/en/<ns>.ts` 漏译会编译期报错。语言用 Cookie `lumen_locale`（`zh-CN`/`en`）+ `Accept-Language` 兜底，顶栏与登录页有 `LanguageSwitch.tsx`；`data-*` 状态值（如 `data-mode`）保持 ASCII，不随语言变化。e2e 断言中文文案的用例必须确保运行在 `zh-CN`——`playwright.config.ts` 已钉 `locale: zh-CN` + `accept-language`，新增用例不要自行覆盖这两项。

## 后端约定

- 视频与图片走同一套 xAI REST（`/videos/generations|edits|extensions`、`/images/generations`），禁止 `openai.videos.*`。
- 尾帧永不进入 **Grok** 请求体（golden test 保障）；可灵在 `capabilities().supportsLastFrameLock` 为真时以 `last_frame` 发送（仅图生视频）并强制 1080p 写回记录与售价，其余 provider 只落盘。源视频禁止 data URI 兜底。
- 状态先写 `data/jobs/{id}/job.json` 再发 SSE；轮询是真相。
- Harness（30/45/60 长视频）由 `HARNESS_ENABLED` 开关：未开启时 `orchestrator.execute` 抛 `HARNESS_NOT_ENABLED`、API 对 30/45/60 返回 400；开启后 `src/lib/harness/orchestrator.ts` 走 directing → keyframing → generating_shots → qc → stitching → persisting，30/45/60 永不直接发给 Grok（rest-map golden 保障）。mock 模式用 `mock-director.ts` 的确定性计划；视觉 QC 只在设置 `HARNESS_QC_VISUAL_THRESHOLD` 时启用。
- ffmpeg 一律经 `src/lib/ffmpeg.ts`（ffmpeg-static），不 spawn PATH 里的 ffmpeg。
- 路由按能力 + 优先级，不按 key 存在性：`VIDEO_PROVIDER_ORDER`（默认 `grok`，兼容旧 `VIDEO_PROVIDER=kling` → `kling,grok`）与 `IMAGE_PROVIDER_ORDER`（默认 `openai,grok`）逐个取「有 key、未被 `src/lib/providers/exhaustion.ts` 判定耗尽、`capabilities().modes` 声明支持该模式、（视频）接得下请求画幅」的第一个 provider；产品目录（`src/lib/products/catalog.ts`）同样只列 ORDER 内的 provider——配了 key 却没写进次序表的那家路由永远不会选中，目录也不摆它的产品；`edit_video`/`extend_video`/harness 长片仍恒定回落 grok。provider 返回 `quota_exhausted` 时该 provider × 通道（视频/图片分开）被标记耗尽 `PROVIDER_EXHAUSTED_TTL_MS`（默认 6h），任务自动改走下一家，`priceCny` **只降不升**（新家更贵且时长档更长时干脆不换，走退避）。一家可用的都不剩、但配了真 key 时提交抛 503 `no_provider_available`，**绝不静默落 mock**；页面与 `/api/health` 用不抛的 `uiProviderId()` 渲染读数。文生图画幅由 `imageAspectRatios()` 恒定给七种，不受视频 provider 能力影响。
- YMan 中转 provider（`src/lib/providers/yman/`，`https://vip.yman.cc/v1`）：视频三步 `POST /videos` → `GET /videos/{id}` → `GET /videos/{id}/content`；创建请求固定 `maxAttempts:1`（已计费不重发）；下载 content **必须带 Bearer**（不是匿名 CDN 直链），`src/lib/media/download-headers.ts` 按目标 origin 匹配对应上游 key 分发，认不出 origin 就不带任何 key。模型 ID 必须用 `GET /v1/models` 的**展示名**（如 `minimax-H3 文字`），旧内部名作别名识别，见 `src/lib/providers/yman/catalog.ts`。
- 文生图（`text_to_image`）设置 `OPENAI_API_KEY` 时改走 `src/lib/providers/openai-image/`（OpenAI 官方或兼容中转，如 ccgoai），未设置回落 xAI/mock，视频路径不受影响；路由见 `src/lib/providers/router.ts` `selectProvider`。上游可能 202 异步出图（`OPENAI_IMAGE_TASK_TIMEOUT_MS` 控制轮询总时限），生成 POST 一旦被接受即计费，故固定 `maxAttempts:1` 不自动重试；取消任务时 `ProviderGenerateRequest.shouldAbort` 会让 `task-poll.ts` 在下次 sleep 后与取 result 前中断，绝不发出计费的 result GET。新增环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_IMAGE_MODEL`、`OPENAI_IMAGE_FLEXIBLE_SIZES`、`OPENAI_IMAGE_QUALITY`、`OPENAI_IMAGE_PRICE_TABLE`、`OPENAI_IMAGE_TIMEOUT_MS`、`OPENAI_IMAGE_TASK_TIMEOUT_MS`，说明见 `.env.example` 与 `docs/design.md` §2b。
- 可灵（Kling）直连视频（`src/lib/providers/kling/`，方案 `docs/plan-kling-video.md`）：默认次序里**没有**可灵，必须显式把 `kling` 写进 `VIDEO_PROVIDER_ORDER`（或用旧开关 `VIDEO_PROVIDER=kling`，等价于 `kling,grok`）再配上 `KLING_API_KEY` 才会生效——只配一把 key 不算开启。开启后只接管 `text_to_video`/`image_to_video` 且非 harness，`reference_to_video/edit_video/extend_video` 与 30/45/60 长片永远留在 xAI（extend 依赖 xAI Files API）；`create.ts` 把任意时长归一为可灵仅支持的 5/10 并写回 `job.durationSec`/`resolution`，`retryJob` 同步重算；`last_frame` 与其它 provider 一样永不发给上游；创建任务固定不重试（已计费不能重发）；国际版账号必须用 `api-singapore.klingai.com`，`api-beijing` 会鉴权失败。详见 `docs/design.md` §2c。
- 用户系统：`src/lib/users/` 是用户存储与会话事实源（`user.json` 为事实源，`index.json` 为可重建缓存），`src/proxy.ts` 对 `/api/*` 做会话校验（register/login/logout/health 放行）。所有任务读写（detail/SSE/media/cancel/retry）、幂等 key、上传 sidecar 都必须带 `ownerId` 校验，非本人一律 404（上传认领因是请求体字段校验、语义就是 400，例外见 `docs/plan-users-quota.md` §5.3）。配额只算 `text_to_image`，判定与落盘必须在同一个 `withAdmissionLock` 临界区内完成（`src/lib/jobs/quota.ts`），`createJob` 与 `retryJob` 共用；新环境变量 `LUMEN_SESSION_SECRET`（必需，缺失即拒绝启动）、`FREE_DAILY_IMAGE_QUOTA`、`FREE_DAILY_FAILURE_LIMIT`、`LUMEN_ADMIN_USER_ID`。数据留存清理（`src/lib/jobs/retention.ts`）只写 `artifactsPurgedAt`，不改 `status`，不碰非终态任务；新环境变量 `DATA_RETENTION_DAYS`（默认 30，0 关闭）。已清理任务禁止一键重试。方案见 `docs/plan-users-quota.md`。
- 余额（2026-09-06 阶段一，`src/lib/billing/`，方案 `docs/plan-architecture-2026-09.md` §3.2、§5）：定价 × 余额是主闸门，`FREE_DAILY_IMAGE_QUOTA`/`FREE_DAILY_FAILURE_LIMIT` 降级为防滥用兜底。**硬约束**：余额判定（`assertBalance`）必须在 `withAdmissionLock` 临界区内、与 `writeJob` 同一次调用完成，不得挪到锁外；扣款必须在 `store.updateJob` 里、写终态之前完成（先扣后写），不得反过来写终态再扣款——那会开一个「预留已消失、余额还没减」的窗口；扣款按 `jobId` 幂等（`applyBalanceChange` 扫流水去重），任何补扣路径都必须复用这同一个幂等函数，不能自己再实现一遍扣款。详见 `docs/design.md` §2d。
- 媒体路由（`src/app/api/media/[jobId]/[file]/route.ts`）的 `Cache-Control` 必须是 `private, no-cache`（弱 ETag + 304 做带宽优化），**不得**改成 `max-age`/`immutable`——产物字节不变但「谁能读」会变（同浏览器换账号登录），长缓存会让浏览器跳过下面的 owner 校验直接吃缓存。
- 智能体（2026-09-07 凌晨，`src/lib/agent/`）：`llm.ts` 的 LLM 提供方顺序固定为 mock（`isMockMode()`）→ `AGENT_API_KEY`+`AGENT_BASE_URL`（默认 `api.openai.com/v1`，模型 `AGENT_CHAT_MODEL` 默认 `gpt-4o-mini`）→ `XAI_API_KEY`（`grok-4.6`）→ 都没有则 503 `agent_unavailable`，**绝不静默落 mock**；生产已配的 ccgoai / YMan 两家中转实测没有对话模型，必须单独配 `AGENT_API_KEY` 才能真用。会话落 `data/agent/<userId>/<sessionId>.json`，非本人 404，单用户上限 200 条。一轮固定收费 ¥0.05（`priceTable().agent.turn`，`ref:"agent:<turnId>"`），LLM 每个 action 通过 `POST /api/jobs` 同一个限流桶（`src/lib/jobs/rate-limit.ts`）后走 `createJob`（幂等 key `agent:<turnId>:<i>`），LLM 整体失败要走 `ref:"agent:<turnId>:refund"` 退款，不能自己另写一套退款逻辑。`GET/POST /api/agent/sessions` 等 API 与消息发送（20 次/分钟）都要走同一套用户会话鉴权，不得绕过。
- 订阅 / 会员积分池（2026-09-07 凌晨，`src/lib/billing/plans.ts`、`subscription.ts`）：订阅积分是与已购余额**独立**的会员积分池（`user.json.memberCreditsCny`），到期清零、跨 30 天期重置——**硬约束：订阅只能用已购池购买，绝不能用会员池买订阅**，否则「低于面值的钱买到面值积分」形成无限套利。扣款顺序固定先扣会员池、不足再扣已购池；锁序恒为 admission → user，不得颠倒（否则可能死锁或绕过余额判定）。定价 `costRatio = max(默认视频产品成本占比, 默认图片产品成本占比)`，月费 `= ceil1(积分/100 × costRatio ÷ (1−0.15))`（毛利率 15%，常量 `GROSS_MARGIN`），年费 = 12×月费不打折。`purchaseSubscription`/`settleSubscription` 均在用户锁内完成，幂等键复用 `ledger.ts` 的通用 `ref` 字段（`sub:<key>`），不要为订阅另起一套幂等逻辑。无支付网关，已购余额只能靠礼品码 / 管理员 CLI 充值。
- 作品管理 / 稳态（2026-09-06 深夜，阶段 B + 架构第二阶段）：`data/jobs/index.json` 是**派生缓存**，不是事实源——写完某个 `job.json` 之后增量维护索引，启动时可重建，读取前自愈；配额、余额预留、留存清理、首页列表、`GET /api/jobs` 分页、`activeCount` 一律读索引，不得再对整个 `jobs/` 目录做全表扫描。分页信封 `{jobs, nextBefore?}` 用任务索引保证同一毫秒的任务不会被切开。分享令牌（`src/lib/share/token.ts`）用独立于会话 Cookie 的 HMAC 派生密钥签发，`GET /api/share/:token` 与 `/api/share/:token/media` 是公开接口（不校验会话），**不要**把会话签名密钥或校验逻辑复用到分享令牌上，两套信任域必须分离。`src/proxy.ts` 对非 GET 请求校验 `Origin`/`Referer`，**两者都缺失时放行**——这是明确的设计取舍（非浏览器客户端 / 某些代理场景不带这两个头），不是遗漏，改动前先确认是否要收紧。日志的 `x-request-id`/`reqId`/`jobId`/`ownerId` 追踪走 `AsyncLocalStorage`（按需 `require`/动态 import `node:async_hooks`，不在模块顶层静态 import）——`@/lib/log`、`@/lib/billing/prices`、`@/lib/cost` 这三个模块必须仍然能被客户端组件 import，新增对它们的修改不得引入服务端专属依赖。

## 验证门禁

- 改代码后依次跑：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`pnpm test`，三者绿才算完成。`.github/workflows/ci.yml` 在 push main 与所有 PR 上跑同样三条（Ubuntu，顺带验证 sharp/ffmpeg-static 的 Linux 原生依赖能装上），不跑 `pnpm e2e`。
- 改 UI 后跑 `pnpm e2e`（Playwright，全部 mock 模式）。用例分五个文件，共 29 条：`e2e/genius.spec.ts`（19 条：空态：壳水合/侧栏五项/顶栏标题与积分/收起态输入条/瀑布流空态；文生视频：规格弹层选参数→创作→跳转 `/create`→成片可见→按估价扣积分；`[fail]` 标记：失败态不扣款→重新生成换新任务→取消；图生视频：上传首帧切换 `data-mode`；图片页：文生图产出静态图；长片：30s 一致性管线分镜读数推进；已清理作品：瀑布流占位卡/无成片请求/一键重试被拒；`retryBlocked`：`uncertain_submit` 阻断一键重试；五视图导航：标题与 `aria-current` 联动、画布不横向溢出；手机端 375 宽：五视图都不横向溢出）、`e2e/auth.spec.ts`（1 条：未登录被送到登录页→注册后进首页、头像菜单显示账号→退出后又被挡回）、`e2e/agent.spec.ts`（2 条：智能体真实闭环——开会话→一轮对话扣 ¥0.05→触发 `text_to_image` action→会话页渲染回复与任务卡）、`e2e/subscription.spec.ts`（4 条：四档显示真实人民币价格→余额不足报错→充值后购买成功→「我的方案」显示生效档位与会员积分）、`e2e/i18n.spec.ts`（2 条：顶栏语言切换即时生效→刷新后 Cookie 落地、服务端首屏与 `<html lang>` 同步→切回中文）。它会复用已在 3000 端口运行的 `next dev`，没有就自己起一个；`CI` 或 `E2E_ISOLATED=1` 时拒绝复用并用隔离 `DATA_DIR`（**Next 16 单实例锁**：3000 已有 dev server 在跑时，`E2E_ISOLATED=1` 会因端口冲突启动失败，此时改用非隔离复用或先停掉已在跑的 dev server），`CI` 或 `E2E_REQUIRE_MOCK=1` 时非 mock 直接失败而非跳过。base URL 必须是 `localhost`，`127.0.0.1` 会被 Next 16 dev 拒 403 导致不水合。仍可再用预览面板（或 Playwright 截图）人工看一眼五个视图。
- 内置浏览器面板在页面滚动后截图会空白，这是截图工具的问题；用 `translateY` 位移检查下方区块，或在真实浏览器里看。

## PR 评审流程

- PR 上的机器人 / 人工评审意见（Devin、Codex、CodeRabbit、reviewer）逐条判断：成立的修复并推送，不成立的说明理由。
- 每条成立的意见修复并推送后，用 `gh api` 在原评论线程下回复：修复提交号 + 改了什么 + 怎么验证的，然后把线程标记为已解决。这是用户 2026-09-05 授权的自动动作，不必再询问；不成立的意见也回复说明，不要静默忽略。
- 回复只针对已推送的修复，不要预告"将要修"。
- 探索式浏览器验证优先用 Playwright MCP（`.mcp.json` 已配）；回归用 `pnpm e2e`。

## 安全与额度

- 密钥只在 `.env.local`，不进聊天、不进提交。
- 未设 `LUMEN_ACCESS_TOKEN` 时不要把开发端口暴露到公网。
- 付费产品的用量控制默认「每种任务定价 × 用户余额」（超出时提示充值），不是日配额。

## 部署

- 生产实例：阿里云 8.209.212.178，`/opt/genius`，systemd `genius.service`（以 root 运行），反代借用同机 taiyu 的 Caddy 容器，公网地址 `https://genius.homeaistack.online`。完整打包与踩坑步骤（服务器装依赖、Turbopack 别名软链的必做步骤、`output: "standalone"` 为何在 Windows→Linux 不可用）见 `docs/design.md` §10.1，`docs/handoff.md`「运维与部署要点」一节有当前配置速览。日常运维操作（部署 / 回滚 / key 轮换 / 备份恢复 / 磁盘告警 / provider 耗尽 / 用户禁用与重置密码 / 礼品码 / 智能体不可用 / 订阅对账）见 `docs/runbook.md`。
- 部署机与构建机跨平台（Windows 构建、Linux 部署）时，`sharp`/`ffmpeg-static` 必须在部署机 `pnpm install --prod`，不能直接拷贝 Windows 的 `node_modules`。

# Skills

- 写或改视频 prompt、Director 系统提示、Identity Bible、`evals/prompts.json` 时，先用 `/video-prompt`。
- 被用户纠正时用 `/fb video-prompt <原因与期望>` 记录；反馈积累后用 `/improve-skill video-prompt` 提改进 PR。
- 人工评分写入 `evals/runs/YYYY-MM-DD.json`（格式见 `evals/rubric.md`），它是 improver 的主要信号源。

# 子代理调度

本项目使用全局子代理团队（`~/.claude/agents/`，来自 skills 仓库 `agent-team`），调度顺序与 Codex 审查分层见全局 CLAUDE.md「子代理调度」。项目差异只有下面几行：

- 验证门禁：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`pnpm test`；改 UI 后再跑 `pnpm e2e`（详见上文「验证门禁」）。
- 高风险代码（Codex 按需审 diff）：`src/lib/harness/`（预算与并发、崩溃恢复、QC / stitch）、`src/lib/jobs/`（状态机、Retry、schema、`quota.ts`、`retention.ts`）、`src/app/api/`（鉴权与请求体校验）、`src/lib/ffmpeg.ts`、`src/lib/providers/grok/`（rest-map、尾帧与 data URI 约束）、`src/lib/users/`（密码 / 会话 / 邀请码）、`src/proxy.ts`（会话网关）。
- 交接文档：`docs/handoff.md`；设计文档：`docs/design.md`（后端 as-built）、`DESIGN.md`（UI）；计划：`docs/plan.md`。
- 硬约束见上文「前端约定 / 后端约定」；Codex 审查会先读本文件。想给 Codex 加审查重点，放 `.claude/codex-review/plan.md` 或 `code.md`。
- 用户 2026-09-05 决定：跨厂商审查用在决策与高风险代码上，普通代码不审；Codex 走 ChatGPT plus 额度，同一份对象不重复审。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
