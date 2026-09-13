# 项目规则（Genius / 流光 · Lumen）

## 阅读与文档维护

- 会话先读 `docs/handoff.md`；索引 `docs/README.md`，路线 `docs/plan-repo-optimization-2026-09.md`。
- 后端读 `docs/design.md`，UI 先读 `DESIGN.md`，运维读 `docs/runbook.md`；旧计划不是现状。
- UI 原型：`design_handoff/design_handoff_genius_app/README.md` + `Genius App.dc.html`；DOM 契约 `docs/plan-ui-genius-app.md`。
- 更新 handoff/design/DESIGN/runbook/本文件时，直接改写为当前真实状态；失效结论删掉或改正，不留「已过时」段落，不追加新节覆盖旧结论。
- 交接描述现在，不是变更日志；历史留 git log 与计划正文，`docs/plan-*.md` 只改顶部状态。每条事实须有代码、配置或实测依据；推断须验证或不写。
- 本文件只留规则/索引，含 CRLF 保持 ≤12,288 字节；详解归领域文档。

## 前端与接口

- `(shell)` 共用 GeniusShell；layout 验会话、下发能力，ShellContext/useShell 管共享状态；结构见 DESIGN。
- 深色令牌见 DESIGN；BEM + ASCII `data-*`；无 Tailwind（reset：`styles/reset.css`），不引组件库/图标库；SVG 收进 icons.tsx，字体经 next/font/google。
- 样式按视图放 `app/styles/`，由 `globals.css` 导入；控件 reset 用 `:where()`；fixed 浮层放在 transform 动画祖先之外。
- 悬浮创作面板必须与 `main` 同级，锚在 `.col`、`position:absolute`；不能放滚动容器，`main` 不为它预留底部 padding。
- 组件不直接 fetch；浏览器只经 `src/lib/client/*` 访问 API。未登录 shell 页面服务端 307 到 `/login`，401 用 `window.location.assign` 整页跳转；头像菜单为 disclosure（非 role=menu），显示完整邮箱与退出。
- 文案走 `useT` 和所属视图 namespace；`messages/zh-CN/<ns>.ts` 是键源，English 必须补齐。仅 `DESIGN.md` 明示的原型占位可保留英文；Cookie `lumen_locale` + Accept-Language 兜底，状态值不翻译。
- 创作请求以 `createJobBodySchema`（strict）为准；model 是产品 id。产品、时长、画幅、分辨率、参考图数按服务端能力，不按 key 猜；`/api/models` 白名单下发供应商/上游展示名/costHint，不下发密钥。
- t2v/i2v/t2i 为基础路径，参考与首尾帧按产品能力开放；未开放模式置灰并提示，不伪造成功。`reference_to_video/edit_video/extend_video` 后端保留，edit/extend UI 继续置灰。
- 规格按钮保留 `data-dur/data-ratio/data-res`；Harness 开启才给 t2v/i2v 加 30/45/60 秒，进度按 job.shots 显示分镜。¥1=100 积分只做显示换算，不改后端 priceCny。
- 一次逻辑创作复用同一 idempotencyKey，成功才清，提示词/选项改变则作废；网络重试不新造 key。智能体每次发送生成 turnId，重试原样带回。
- 作品用 `GET /api/jobs?before&limit&kind` 分页；标签/删除/分享/模板用既有客户端入口。通知以持久索引为准，SSE 提醒并触发对齐（design §2k）。

## 供应商与执行

- provider 身份走 `registry.ts`，ProviderId 为开放字符串，ORDER 只接受已注册 id；路由与产品目录都按能力 + ORDER + 可用性，不以配 key 代替启用。默认值、旧 VIDEO_PROVIDER 兼容与 fallback 见 design §1/§2e。
- 配了真 key 但无人可接时返 503 `no_provider_available`，绝不静默 mock；页面/health 用不抛错的 `uiProviderId()`。文生图七种画幅独立于视频能力。
- 付费创建固定 `maxAttempts:1`；读超时、断连、裸 5xx 属模糊提交，查回接管或 `uncertain_submit` 锁重试，绝不重买。确定拒单才换家；priceCny 只降不升，点名产品不换成别人家的产品。
- N3.4 治理见 `providers/{health,rejection}.ts` 与 design §2e/§7；排除已试过的家，遵守 RELAY_MAX_SWITCHES 并记录 providerSwitches。分镜只换失败镜，不动成功镜。
- relay 统一工厂，配置来源为文件 > LUMEN_RELAYS 种子 > 老 env 折算；缺省 yman/openai 仍可解析。注销进影子表以支持历史任务；管理接口 requireAdmin，非管理员 404；keyEnv 只存环境变量名（design §2l）。
- Grok 只走 xAI REST `/videos/generations|edits|extensions`、`/images/generations`，禁止 `openai.videos.*`。Grok 是普通 provider，不是平台基座。
- 尾帧永不进入 Grok 请求体（golden 保证）；仅声明 supportsLastFrameLock 的可灵 i2v 发 last_frame，并强制 1080p 写回记录与售价。其它不支持的 provider 只存尾帧；源视频禁止 data URI 兜底。
- 可灵只有 5/10 秒档，创建与重试都归一并写回；国际账号用 api-singapore.klingai.com。YMan 视频为 POST /videos → GET /videos/:id → GET /content，模型用 /models 展示名、旧名只作别名。
- 下载鉴权由 `media/download-headers.ts` 按目标 origin 对应上游分发；YMan content 必须 Bearer，未知 origin 不带任何 key。
- OpenAI 兼容生图的 202 轮询遵循 task-poll；取消后不得再取可能计费的 result。参考图仅在 edits 开关与 supportsImageReference 同时允许时走 multipart /images/edits（design §2b）。
- Harness 30/45/60 受 HARNESS_ENABLED 控制；关闭时 API 400、orchestrator 抛 HARNESS_NOT_ENABLED，长时长不得进入原生请求体。按 i2v+t2v 能力走 ORDER，shot 为 t2v/i2v/r2v，续接尾帧→i2v，不用 extend。
- 三视图/档 A 首帧遵循生图参考能力；Director/QC 用 agentLlmConfig，超时 llm_upstream_failed 不产生付费分镜/锁重试；估价含视频+LLM+图，mock 用 mock-director，视觉 QC 须设阈值（design §7）。
- ffmpeg 一律经 `src/lib/ffmpeg.ts`（ffmpeg-static），不 spawn PATH 中的版本。

## 数据、安全与资金硬约束

- 状态先写 job.json 再发 SSE，轮询是真相。job.json/user.json 是事实源，索引是可重建缓存；写事实再更索引，启动重建、读取自愈。
- 配额、余额预留、留存、列表分页、activeCount 读任务索引，不对 jobs 做全表扫描；同一毫秒的任务不能被游标切开。
- 任务 detail/SSE/media/cancel/retry、幂等 key、上传、素材、会话、画布都校验 ownerId；非本人一律 404、不可探测。上传认领属于请求体校验，统一 400 是明确例外。
- LUMEN_SESSION_SECRET 缺失拒绝启动；会话同时校验禁用状态与 epoch。分享令牌使用独立 HMAC 派生密钥和信任域，不能复用会话签名/校验；公开分享入口不要求登录。
- 私有媒体与上传/素材 `Cache-Control: private, no-cache`，owner 校验先于 ETag/304；禁止 max-age/immutable，换账号不能吃到前一账号缓存。
- Origin/Referer 双缺放行是现有明确取舍，收紧前须确认并核对 Cookie CLI/smoke。请求追踪走 AsyncLocalStorage；`log`/`billing/prices`/`cost` 必须可被客户端 import，不得顶层引入服务端依赖，async_hooks 按需加载。
- 余额判定必须在 withAdmissionLock 内与 writeJob 同次准入；t2i 配额 create/retry 共用同一临界区。定价×余额为主闸门，日配额/失败限额只防滥用。
- 锁序恒为 admission → user。扣款在 updateJob 写终态之前完成；扣款、补扣、退款统一走 applyBalanceChange，按 jobId/ref 幂等，不另写资金入口。
- 退款必须带 refundOf，按原扣款 memberCny 拆回原池；找不到原扣款失败关闭，禁止把会员积分退成永久已购余额。
- user.json.billing 操作链与两池余额同一次原子写提交；jsonl 只是派生导出物，不一致报 billing_export_corrupt，缺失可重建。同键不同输入 409 billing_idempotency_conflict。
- 无 billing 的存量账号禁止余额变动；迁移必须离线、人工基线、user/ledger 双 sha256 与重放核对，不支持 --force。管理 CLI 的 --offline 目前只是停服声明，不是跨进程锁，不得与线上服务并发写。
- 订阅只能用已购池买，绝不允许会员池购买；正常扣款先会员后已购。assertBalance 前先 settleSubscription，跨期旧积分不进可用额；购买扣款保存订单快照，重放补记录不重扣；复用通用 ref 幂等（design §2i）。
- 媒体留存只清终态产物、写 artifactsPurgedAt，不改 status，不碰非终态；已清产物禁止一键重试。画布素材独立存 assets，30 天到期明示；保存不续期，迁移缺原件标 missing，不伪造字节，不改运行快照（design §2j）。

## 智能体与画布

- Agent LLM 顺序为 mock → AGENT_API_KEY/BASE_URL → XAI → 503 agent_unavailable，不静默 mock；上游调用失败用 502 agent_upstream_failed 并按原池退轮次费，不混淆「未配置」。
- Agent 默认提案批准：proposal 落报价/有效期，批准才走同一限流桶 createJob；拒绝不建不退轮次费。同 turnId 同参重放、异参 409，陈旧 thinking 惰性退款；轮次/提案均核 budget，校验 imageRef/kinds，按 locale 回复（design §2h）。
- 画布 PATCH 必带 expectedRevision；409 保留本地并明确二选一，不静默覆盖。单节点与 DAG 统一走 createJob，输入缺失不降为无图生成，素材先复制再认领。
- DAG 先确定性报价再冻结图与总价；run.reservation → transfer → job.reservation 一份钱恰好预留一次。查回既有 job 先于价变判断；运行不回写画布文档，产物用执行位 overlay。
- runHeldFunds 不能只靠任务索引：索引缺失但执行位已终态不复活预留，非终态孤儿继续占用。取消意图持久化、停新提交；取消后不接受审批。
- 审批 24h、排队 1h 超时均收敛 blocked，预留随 run 终态释放；内容寻址复用须校验产物在盘，已清则 output_purged，只有显式 regenerate 才重跑（design §2j）。

## 验证、评审与运维

- 代码门禁依次为 `pnpm exec next typegen && pnpm exec tsc --noEmit`、`pnpm exec eslint src e2e scripts`、`pnpm test`；全绿才完成，不能依赖 dev 遗留类型。CI Ubuntu 同样执行并安装原生依赖。
- UI 必跑 `pnpm e2e`（mock）；隔离用 E2E_ISOLATED=1、E2E_REQUIRE_MOCK=1、独立 E2E_PORT。中文断言保留 zh-CN locale/accept-language，不把真实 key 导致的 skip 当通过。
- 端到端清单以 `e2e/*.spec.ts` 为准；画布冲突用独立文档与真实 PATCH 409 断言。移动端须核对 375/390/768，软键盘需真机验证，不能冒充 Playwright 已覆盖。
- 探索浏览器优先 Playwright MCP，回归用 pnpm e2e；若内置面板滚动截图空白，用真实浏览器或 translateY 检查，不凭空断定 UI 消失。
- PR 的机器人/人工意见逐条判定；成立的修复并推送后，在原线程用 gh api 回复提交号、修改与验证，再标已解决；不成立的也说明理由。只回复已推送事实，不预告「将要修」。
- 密钥仅本地 .env.local / 服务器 .env，不进聊天/提交；未设 LUMEN_ACCESS_TOKEN 时不要把开发端口暴露公网。真实上游评测先确认报价与预算，缺授权素材不能用占位图凑绿。
- 生产 8.209.212.178 `/opt/genius`、genius.service，借用 taiyu Caddy；运维查 runbook。生产变更/停服/改归属单独确认，不自动部署。
- Windows→Linux 禁止复制原生 node_modules；sharp/ffmpeg-static 在部署机 pnpm install --prod，打包与 external 别名见 design §10.1。开发用 localhost，127.0.0.1 可能被 Next dev 403。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
