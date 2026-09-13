# 会话交接 — Genius（流光 · Lumen）

新会话先读本文，再读 [文档索引](README.md)、`AGENTS.md`、后端 `docs/design.md`、UI `DESIGN.md` 与 `docs/runbook.md`。当前路线是 `docs/plan-repo-optimization-2026-09.md`；历史方案正文与审查报告是对应基线的证据，不代表当前状态。

## 0. 当前状态

核对日期：2026-09-13。代码、部署记录与本轮实测分开记，不将工作树或本地 HEAD 自动当作生产版本。

| 项 | 状态 |
| --- | --- |
| 代码基线 | `main`/`origin/main` 已包含 N3.4 `37123bd` 与交接提交 `fb37e53`；`main` 首条绿 CI 为 `6b5449d`（R0.1 验收成立）。精确当前 SHA 用 `git rev-parse HEAD origin/main` 核对 |
| 生产版本依据 | 2026-09-13 用 deploy.sh 部署 `d7f34eb`（三条门禁、`--frozen-lockfile`、别名补链、health、公网 /login 全过）；`/opt/genius/BUILD_INFO.json` 与登录态 `GET /api/health` 的 `build.sha` 可机器核对线上版本。`build.node` 是构建机 Node（v24.16.0），运行时仍是 v22.22.2 |
| 本机 | Windows / PowerShell，Node v24.16.0，pnpm 10.33.0，Next 16.3.3，React 19.2.8 |
| 生产只读核查 | 阿里云 8.209.212.178，`/opt/genius`；Node v22.22.2，pnpm 10.33.0，Caddy v2.11.4；genius.service active，`User=genius`（uid 989，R1.5 drop-in 已生效），MemoryMax 700 MiB；`/opt/genius` 整树 genius:genius，`.env` 640；生产画布 1 份文档、0 处 legacy uploadId，`data/assets/` 待首个素材节点创建 |
| 入口 | `https://genius.homeaistack.online`；本地 `pnpm dev` 后访问 `http://localhost:3000`，不用 127.0.0.1（Next dev 可能 403） |
| 整合门禁 | `fb37e53 + R0` 在隔离副本依次通过 typegen/tsc/eslint/test：107 文件、1245 通过、1 既有跳过；生产构建通过且无全仓追踪警告；整合 e2e 36/36，画布重复三轮 10/10。R1 起 eslint 范围为 `src e2e scripts`（CI 与 deploy.sh 同步），`scripts/**/*.mjs` 带 `// @ts-check` 纳入 tsc；e2e 走独立 workflow（`.github/workflows/e2e.yml`，每日 UTC 20:00 定时 + 手动，不挂 PR）。单测与 e2e 错开运行，未放宽全局超时 |
| 测试环境 | 独立验证 worktree `D:\dev\repos\VideoPlatFrom-optimization-20260913`；e2e 端口 3178、E2E_ISOLATED=1、E2E_REQUIRE_MOCK=1；不读生产密钥，不调用真实上游 |
| 备份 | root cron 每日 03:17 跑新版 backup.sh（白名单已随 d7f34eb 上线）；部署前手动包 `backups/genius-data-20260913-174421.tgz` 为旧脚本产物、不含 relays.json；ECS 自动快照未获控制台证据，异地副本（已决：阿里云 OSS）与一致性恢复演练未完成 |

`37123bd` 部署记录中的 provider 配置：视频 ORDER `kling,yman,grok`，图片 ORDER `openai,yman`，无 XAI key；Grok 只是未启用的后备项。对话走 ccgoai `gpt-5.6-luna`，图片 `gpt-image-2/medium`，可灵 `kling-2.6`，YMan t2v `minimax-h3`、i2v `minimax-h3-933-图文`；Harness 与 OpenAI image edits 已开。原始真实验收见 `docs/acceptance-2026-09-13.md`，本轮未重新付费验证这些上游。

## 1. 系统地图

| 能力 | 入口与事实源 |
| --- | --- |
| 壳与五视图、账户页 | `src/app/(shell)/`，`src/components/genius/`，`ShellContext`/`useShell()`；浏览器仅经 `src/lib/client/*` 调 API |
| 任务与恢复 | `src/lib/jobs/`；job.json 事实源，任务索引可重建，先落盘再 SSE，模糊提交查回或锁重试 |
| Provider / relay | `providers/{registry,router,health,rejection}.ts` 与 `providers/relay/`；relays.json 为配置事实源，目录快照与冷却状态分开 |
| 资金与订阅 | `src/lib/billing/`；user.json.billing 与两池余额同一次原子提交，jsonl 是派生导出；admission → user 锁序 |
| 智能体 | `src/lib/agent/`；会话内 turns/proposal/budget；默认批准制，批准才建真实任务 |
| 画布与 DAG | `src/lib/canvas/`；revision 乐观并发，报价/冻结/预留/审批/取消/复用；run 不回写画布文档 |
| 画布素材 | `src/lib/assets/`；data/assets 持久字节与 sidecar，30 天独立期限，旧上传迁移 |
| 用户、会话、通知、分享 | `src/lib/users/`、`notifications/`、`share/`；owner 校验，通知持久索引，分享独立密钥域 |
| 长片与媒体 | `src/lib/harness/`；Director → 关键帧 → 分镜 → QC → 拼接 → 持久化；ffmpeg 只走 ffmpeg-static |
| 多语言 | `src/lib/i18n/`；zh-CN 为键源、English 编译期补齐，Cookie lumen_locale |

数据目录完整清单见 `docs/design.md` §5。当前备份脚本白名单包括账号、礼品码、资金导出、会话、画布/run、通知、模板、任务元数据，以及新增的 `assets/` 与 `relays.json`；不备任务成片、临时上传和可重建目录缓存。生产旧包是否含新白名单须部署后查 tar，不能凭源码推断。

## 2. 已实现产品能力

- **创作**：t2v/i2v/t2i，参考与首尾帧按产品能力；数量 1–4、素材复用、产品规格、分镜进度。可灵与 YMan 30 秒长片已有真实成片记录；30/45/60 售价独立档 ¥20/30/40，高清/有声加价按价表。edit/extend 后端保留、UI 置灰，当前生产无承接者。
- **中转**：N3.1–N3.4 已落地——注册表、通用工厂、配置管理接口、动态模型目录、产品生成、健康冷却/半开与确定拒单换家。点名产品不换家；模糊提交绝不重发。管理页、创作面板供应商分组仍待 R2。
- **作品与通知**：游标分页、标签、删除、分享、模板回填；终态通知持久化，SSE/重连/回前台对齐。通知最多 200 条，铃铛显示 10 条，打开即全部已读；run/agent 事件尚未进入该索引。
- **账号与钱**：邀请码注册赠 ¥5、改密、退出全部设备、账户页、礼品码兑换、流水、余额两池与订阅。订阅只能用已购池买，会员积分到期/跨期清零；R01–R09 资金与执行恢复修复已在既有提交中，协议见 design §2d/§3。
- **智能体**：真实 LLM 提案、价格快照、批准/驳回、会话预算、图生视频 imageRef、技能 kinds、locale 回复；一轮 ¥0.05，调用失败按原池退款，配置缺失与上游失败用不同错误码。
- **画布**：四类节点、连线输入、拖拽与保存冲突二选一；单节点或整图运行复用 createJob。总价冻结、逐节点转移份额、人工审批、内容寻址复用；审批 24h/排队 1h 超时收敛，已清产物不暗中重生成。
- **R0 素材修复**：保存素材时复制为独立 assetId，首次认领起 30 天，保存/重放不续期；刷新仍可预览，到期或缺失提示重新上传。启动在 tmp 清理前保护旧素材，缺原件标 missing；活动 run 的冻结图、报价与资金台账不被迁移改写。
- **R0 工程修复**：CI/部署 typecheck 前补 next typegen；备份加入 relay 配置与素材；画布 e2e 每段独立文档、断言真实 409；AGENTS 瘦身并保留 Next 受管理块，文档索引与大小有自动回归检查。收口时额外修复 relay probe 的付费 POST 默认重试风险：显式 maxAttempts:1；billed:false 只表示平台不记账，上游仍可能收费，本轮未运行真实探针。

模板种子在 `data-seed/templates`；新 DATA_DIR 首次使用需复制到 `data/templates`，部署脚本在目标不存在时落种，不覆盖既有模板。资金迁移基线与备份仍在服务器 `/opt/genius/migrate-baselines/`、`/opt/genius/data.bak.20260912-150535`，不得未经确认清理。

## 3. 全仓审查处理状态

原报告 `docs/review-repo-2026-09-13.md` 保留 dbead84 时的证据。下表描述当前进度；未实施项不记为已修。

| Finding | 当前状态 / 后续 |
| --- | --- |
| F-01 | typegen 前置已修并复现前后差异；`main` `6b5449d` CI 绿，验收成立 |
| F-02 | 备份白名单与真实打包回归已修；生产包检查待部署 |
| F-03 | 独立素材、30 天提示、迁移/归属/过期/刷新回归已落地 |
| F-04 | 画布三轮重复 10/10；整合 N3.4 后全量 e2e 36/36 |
| F-05 | 大 Context 结构确认；R5.1 重渲基线已测（§5），拆分为可维护性动机、待拍板 |
| F-06 | R1.3 已落地并**生产实测通过**（2026-09-13 部署 d7f34eb：`--frozen-lockfile` 首次通过、`build.sha` 回显核对成功）；git archive 构建与发布目录（R1.4）未做 |
| F-07 | 同机 cron 已核实；异地目标、加密、全写者维护屏障与恢复演练待 R4 |
| F-08 | 交接区分代码/部署/实测，纠正目录数与备份状态；整合门禁按实际结果收口 |
| F-09 | run/流水线性 IO 仍在；R4.1 的 `admission_ms` 埋点已落地（health 登录态 `admission.wait/hold` 分位数），其余治理待 R4 |
| F-10 | 已落地（R4.1，D-4=b）：`/api/admin/*` 支持本机管理令牌（`LUMEN_ADMIN_TOKEN`，Bearer + XFF 缺失或全 loopback + loopback host 三判据，`src/lib/admin-token.ts`），五个管理 CLI 默认走 HTTP 接口；`--offline` 须先探测服务未运行（ECONNREFUSED）才允许直写 |
| F-11 | 已落地：`withRelayLock` 进程级串行锁包住 create/update/delete 的读-改-写临界区，并发创建/更新不丢写的回归用例在 relay.test.ts |
| F-12 | 规则压到 12KB 内，保留资金/安全约束与框架管理块，大小有回归门禁 |
| F-13 | 大文件拆分待 R2/R5，不借修复改变业务行为 |
| F-14 | 已落地：Tailwind 依赖与 postcss 插件移除，`preflight.css`（tailwindcss@4.3.3，MIT）逐字拷贝为 `src/app/styles/reset.css`（`--theme()` 取回落值）；`@theme` 三变量无人使用已删 |
| F-15 | 已落地：`/gallery`、`/studio`、`/studio/:kind`、`/jobs/:id` 四个 stub page 删除，改由 `next.config.ts` `redirects()` 307 到 `/` |
| F-16 | evals:check 实测缺 character-zh/en 两张授权素材；无质量校准记录，先给批次报价，不调用付费接口 |
| F-17 | 已落地：eslint 范围 `src e2e scripts`（CI/AGENTS/deploy.sh 同步），`scripts/**/*.mjs` 加 `// @ts-check` 纳入 tsc 并补 JSDoc 类型 |
| F-18 | docs/README.md 覆盖全部 docs 文件，索引完整性有回归测试 |
| F-19 | Caddy 2.11.4 配置无 forwarded/trusted-proxy 覆盖，与官方默认行为交叉核对；未做公网伪造头实验 |
| F-20 | 保留双缺头放行。现有 smoke 与管理客户端使用 Cookie，直接收紧会破坏兼容，不能采纳报告中的相反前提 |
| F-21 | 保留现有对话 SDK，尚无需要替换的事实依据 |

## 4. 未完成与边界

- 无支付网关，订阅收入仍是内部记账；微信/支付宝都接的方向已定，但商户资质、渠道政策与沙箱条件未确认，R6 不直接开工。
- R3 尚无预算授权与授权人物素材；现有场景用例只覆盖 h45-t2v-zh/en-scene，不能代替人物身份阈值校准。YMan 长片的 r2v 档 B、minimax-h3 真账单价格仍待验证。
- 常规管理变更（充值/重置密码/停用/铸码）已改走应用内唯一写者（管理令牌 + HTTP）；`--offline` 直写保留但须先探测服务未运行。migrate-billing 与备份仍要求停服窗口；备份不能只停创作准入就声称一致性。
- SQLite 只在多写者/准入 p95/备份约束实际触发时选型。生产 Node 22.22.2 可支持内置模块，但 Node 22 文档仍标 1.1 Active development，不据此迁资金。
- 会话/画布/run 的整体归档与留存未做；画布素材的 30 天期限已单独实现，不等于删除画布或资金记录。
- 游离空 material 节点仍使整图报价失败；准入仍 strict 读用户 run 文件；这些行为尚未改变。
- 移动软键盘需真机验证，mock e2e 不能证明它；质量与成本不能由 mock 成片证明。
- 无异地备份恢复证据、无已核实的 ECS 自动快照设置；构建 SHA 回显（BUILD_INFO/health `build.sha`）已随 d7f34eb 部署生效，非 root 迁移（R1.5）已执行。

## 5. R5.1 前端重渲基线（2026-09-13 实测）

条件：生产构建 `next start`，mock + harness，Playwright 驱动，每场景重复 3 次取中位数。

| 视口 | 场景 | provider 重渲 | 消费者重渲（useShell 计数） | longtask（>50ms） |
| --- | --- | --- | --- | --- |
| 1440×900 | 提示词击键 | 1.0/击键 | 6.0/击键 | 0 |
| 1440×900 | SSE 进度窗口 | 14 | 86（6 条 SSE 事件，≈14/事件为上限；窗口含提交与 /create 换挂载） | 0 |
| 1440×900 | 静置 5s | 0 | 0 | 0 |
| 375×667 | 提示词击键 | 1.0/击键 | 6.0/击键 | 0 |
| 375×667 | SSE 进度窗口 | 14 | 84（7 条 SSE 事件，≈12/事件上限） | 0 |
| 375×667 | 静置 5s | 0 | 0 | 0 |

现状：`ShellContext.tsx` 的 `value` 是 91 字段对象字面量、无 `useMemo`；`useShell()` 共 17 处调用 / 14 文件，首页实际挂载消费者约 6 个。SSE 走原生 `EventSource` 两条流（`/api/events` 账号级、`/api/jobs/:id/events` 单任务）。

结论：无可感知阻塞；R5.2 拆分是可维护性动机而非性能止血，本轮是否实施待拍板。

## 6. 下一步与权限

1. R0 整合单测复核、文档契约与差异复核完成后，按用户授权只提交本轮文件并推送 main，等待 GitHub CI；不把 N3.4 归入本轮提交。
2. R1.1–R1.3 已落地：e2e 定时+手动 workflow 已在 `74248a5` 绿过一次（验收口径是连续 3 次绿）、deploy.sh 新流程已于 2026-09-13 部署 d7f34eb 实测通过、health `build.sha` 对照生效。R1.5 非 root 已执行；R1.4 发布目录仍待生产窗口；R1.6 已核对、保留现状。relay 写锁（F-11）已落地；R4.1 管理令牌与 CLI 改造已落地（F-10）；下一步按路线推进 R4/R5 余项（R5.2 已拍板本轮做）。
3. 用户已定：移除 Tailwind；e2e 先定时+手动；删除 skip-check；CLI 走应用管理入口；素材 30 天明示；真实评测先报价；本轮准备非 root 迁移；新路线取代旧排期。尚未授权任何实际评测花费。
4. 全程不启动未授权子代理；本轮 SureForge Standard 为 self-review-only。真实生产变更、停服务、改归属、覆盖/删除数据都须展示具体动作并确认。
