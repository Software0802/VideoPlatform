# 会话交接 — Genius（流光 · Lumen）

新会话先读本文，再读 [文档索引](README.md)、`AGENTS.md`、后端 `docs/design.md`、UI `DESIGN.md` 与 `docs/runbook.md`。当前路线是 `docs/plan-repo-optimization-2026-09.md`；历史方案正文与审查报告是对应基线的证据，不代表当前状态。

## 0. 当前状态

核对日期：2026-09-19（代码与本机门禁）；生产仍是 2026-09-15 那次部署，本轮**未部署**。代码、部署记录与实测分开记，不从本地状态推断生产版本。

| 项 | 状态 |
| --- | --- |
| 代码基线 | 精确 SHA 一律用 `git rev-parse HEAD origin/main` 核对，本文件不记自身所在的提交号。截至 `83065c7` 的内容 = 当前生产：`315818c` 会话/画布/终态 run 归档（`ARCHIVE_INACTIVE_DAYS`）、`8b5282f`+`0359830` 发布目录化 deploy 脚本（R1.4）、`6cc1611` 全仓审查报告（`docs/review-2026-09-15.md`）、`d8d326c`+`5087706` 整站背景呼吸灯与等待特效、`83065c7` 令牌文档对齐。此后新增 **响应体静默看门狗**（用户报的「画布节点成片后一直转圈」，根因与修法见 §2「上游传输」）与 **`review-2026-09-15` 的 39 条修复**（P1 五条 + P2/P3 三十四条，分类见 §3'，逐条依据在原报告 §0.0），这部分**尚未部署**，生产不含它 |
| 生产版本依据 | 生产 = `83065c7` 构建，`current -> releases/83065c7-20260915-134029`，`PREVIOUS=0359830-20260914-234013`；`releases/` 保留三份（另有 `legacy-13fb9ee`）。2026-09-15 `deploy.sh` 单次全流程通过：本地门禁、build（包 22M）、上传、服务器 `pnpm install --prod --frozen-lockfile`（84 包，2.6s）、Turbopack 原生包别名（sharp / ffmpeg-static）、`mv -T` 原子切链、重启与 health 轮询均成功，服务 active、本机 health 200 `ok=true`，公网 `/login` 200。浏览器实测公网登录页呼吸灯生效（`glow-breathe` 6s / `glow-drift` 10s，`--glow-peak=.4`、`--glow-rest=.14`）。登录态 `GET /api/health` 的 `build.sha` 本轮无生产会话，未核对；`/opt/genius/BUILD_INFO.json` 的内容未在服务器上回读，本地生成值为 `shortSha:83065c7`、`dirty:false` |
| 生产配置 | `/opt/genius/.env` 已配置 7 条 `AGENT_CHAT_MODELS`，默认 `gpt-5.6-luna`；`YMAN_T2V_MODEL=minimax_h3`。更新前状态备份为 `.env.bak.20260914-220732`，当前与备份均为 genius:genius 640 |
| 生产 relay | `data/relays.json` 于 2026-09-14 首次创建，仅含 `yman` 文件条目：`catalog.source=models-endpoint`，24 个模型配置（15 视频：13 定价 + 2 hidden；9 图片已定价），默认 t2v=`minimax_h3`、i2v/r2v=`minimax-h3-933-图文`、image=`gpt-image-2`。`data/relay-catalog/yman.json` 已自动生成 24 模型快照 |
| 本机 | 主开发机为 Windows / PowerShell（Node v24.16.0）；2026-09-17 这轮在 Linux 远程容器（Node v22.22.2）上完成，pnpm 10.33.0，Next 16.3.3，React 19.2.8 |
| 生产只读核查 | 阿里云 8.209.212.178，`/opt/genius`；Node v22.22.2，pnpm 10.33.0，Caddy v2.11.4；genius.service active，`User=genius`，MemoryMax 700 MiB；部署后 available 内存 831 MiB、根盘可用 14G；`.env` 640、`data/relays.json` 600，均 genius:genius |
| 入口 | `https://genius.homeaistack.online`；本地 `pnpm dev` 后访问 `http://localhost:3000`，不用 127.0.0.1（Next dev 可能 403） |
| 整合门禁 | 2026-09-19 本机（Linux 容器，Node v22.22.2，pnpm 10.33.0）：`pnpm typecheck` 0 错、`eslint src e2e scripts` 0、`pnpm test` 123 文件 / 1381 通过 / 1 跳过、隔离 mock+harness E2E **59/59**（含 setup，独立端口与 DATA_DIR；含本轮新增的画布工具栏/工具箱、节点模型芯片、面板模板按钮、置灰理由、音频页、创作搭子、挑战与横幅，以及此前的「临期作品」「上传坏文件」「画布等待态」「弹层焦点」「节点删除确认」）。E2E 在这台容器上要先把 `libnspr4/libnss3/libasound2` 解到用户目录并用 `LD_LIBRARY_PATH` 指过去（没有 root，装不了系统包）。**本轮只在一种端口配置下跑过**；「两种端口各 51/51」（一轮不设 `E2E_PORT`、服务落 3000，与 CI 同配置，正是定时轮次连红六次的那套；一轮 `E2E_PORT=3100`，本机惯用的那套）是新增这 8 条用例之前那一轮的实测，端口来源已统一到 `e2e/paths.ts`。本轮未跑 `pnpm build`、未部署。B-01 与 B-03 两个偶发假红已修（见 §3'），`run-graph.test.ts` 的 `beforeAll` 在机器忙时 10s 超时仍是已知的第三个偶发源，单跑 35/35 绿。E2E 曾有一次 `i18n.spec.ts`「登录页也能切换语言」因 `goto` 与 401 跳转竞争 ERR_ABORTED（用例注释已登记这个竞争），同配置重跑即绿——它不在本轮修复范围内。仅四个慢用例有局部等待上限调整，未放宽全局或业务超时。**评审收口后画布用例换过一条**（删掉「导出工作流」、加上工具箱「我的作品」页签），这一条本机没跑过：容器里的 Playwright 浏览器起不来 |
| 定时 E2E（GitHub Actions） | `.github/workflows/e2e.yml` 每日 UTC 20:00 跑 main。**本机绿不等于这条绿**：2026-09-13 起连续 6 个定时轮次全红（最后一次 `35401218591`，48 passed / 1 failed），每次都是同一条 `subscription.spec.ts`「余额足够时买下标准档」——它的 `fund()` 给 `grant-balance.mjs` 传 `--offline`，而 `--offline` 直写文件要求服务确实没在跑（`assertServiceStopped` 只放行 ECONNREFUSED）。本机门禁一直把 `E2E_PORT` 挪到 3100，探测打在空端口上就放行；CI 不设 `E2E_PORT`，服务正好在 3000，于是拒绝。同批 `auth.setup.ts` / `genius.spec.ts` 早已改走令牌 + `LUMEN_ADMIN_BASE_URL` 的 HTTP 管理接口，只有这一处漏改。现三个管理 CLI 调用点、`playwright.config.ts` 的 `baseURL` 与 `admin.spec.ts` 种 Cookie 的域共用 `e2e/paths.ts` 的 `e2eBaseUrl()`，e2e 里不再出现 `--offline`。定时轮次是否转绿须等下一次实跑，本文不提前记绿 |
| 测试环境 | E2E 使用独立 DATA_DIR、E2E_ISOLATED=1、E2E_REQUIRE_MOCK=1，不读生产密钥、不调用真实上游。端口两种都要能跑：本机习惯用 `E2E_PORT=3100`，CI 不设它（服务落 3000）。管理 CLI 的地址与浏览器 `baseURL` 同源于 `e2e/paths.ts` 的 `e2eBaseUrl()`，所以两种端口下行为一致；只在一种端口下验过不算验过 |
| 备份 | root cron 每日 03:17 跑 backup.sh（白名单含 `relays.json`+`assets/`）；2026-09-13 包 `backups/genius-data-20260913-211416.tgz` 已做首次真实恢复核对并一致，未做完整切换恢复；生产 OSS 变量与完整恢复演练仍待执行 |

当前生产 provider 配置：视频 ORDER `kling,yman,grok`，图片 ORDER `openai,yman`，无 XAI key；Grok 是未启用后备项。对话使用 ccgoai，`AGENT_CHAT_MODELS` 共 7 条且默认 `gpt-5.6-luna`；图片 `gpt-image-2/medium`，可灵 `kling-2.6`，YMan t2v `minimax_h3`、i2v/r2v `minimax-h3-933-图文`。Harness 与 OpenAI image edits 已开。原始付费上游验收仍以 `docs/acceptance-2026-09-13.md` 为准；本轮部署只调用免费的 YMan `/models`，未重新付费生成。

本地登录态 `GET /api/models` 实测 YMan 共 21 个产品：默认「快速」指向 `minimax_h3`，独立「海螺 H3」指向 `minimax-h3`；生产未取得管理员会话，登录态 `/api/models` 与 `/api/agent/skills` 尚未核对。

Windows 本机的 mock 视频/ffmpeg、通知原子写入与 relay 首次动态导入会超过原 5 秒窗口，因此工作树只放宽了 `create.test.ts`、`canvas.test.ts`、`notifications/store.test.ts`、`relay.test.ts` 的单测等待/超时；断言与业务超时均未放宽。

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
| 用户、会话、通知、偏好、分享 | `src/lib/users/`、`notifications/`、`prefs/`、`share/`；owner 校验，通知持久索引（job/run/agent），账号偏好独立于 user.json，分享独立密钥域 |
| 归档 | `src/lib/archive/sweep.ts`；`ARCHIVE_INACTIVE_DAYS`，runner 每小时维护调用，只写 `archivedAt` 或移入 `canvas-runs/*/archive/` |
| 长片与媒体 | `src/lib/harness/`；Director → 关键帧 → 分镜 → QC → 拼接 → 持久化；ffmpeg 只走 ffmpeg-static |
| 多语言 | `src/lib/i18n/`；zh-CN 为键源、English 编译期补齐，Cookie lumen_locale |

数据目录完整清单见 `docs/design.md` §5。当前备份脚本白名单包括账号、礼品码、资金导出、会话、画布/run、通知、偏好、模板、文件化技能、任务元数据，以及 `assets/` 与 `relays.json`；不备任务成片、临时上传和可重建目录缓存。生产旧包是否含新白名单须部署后查 tar，不能凭源码推断。

## 2. 已实现产品能力

- **创作**：t2v/i2v/t2i，参考与首尾帧按产品能力；数量 1–4、素材复用、产品规格、分镜进度。可灵与 YMan 30 秒长片已有真实成片记录；30/45/60 售价独立档 ¥20/30/40，高清/有声加价按价表。edit/extend 后端保留、UI 置灰，当前生产无承接者。
- **中转**：注册表、通用工厂、配置管理、动态目录、健康冷却/半开与确定拒单换家均已落地。目录模型可配置 `name/hidden/kind/price`，快照与配置深合并；只有已定价且非 hidden/chat、未被默认产品覆盖的模型生成图片或视频产品。管理页 `/admin/relays` 可展开模型表编辑并只 PATCH 改动项；legacy env 条目须先「转为可管理条目」。创作面板按供应商分组并按产品价格覆盖报价。点名产品不换家；模糊提交绝不重发。
- **作品与通知**：游标分页、标签、删除、分享、模板回填；通知持久索引按 `kind` 覆盖 job 终态、画布 run 终态与节点待审批、智能体提案待批准与轮次失败（design §2k），`/api/events` 的 `notification` 帧触发客户端同步，非目标页补 toast，点击分别跳 `/create`、`/canvas`、`/agent?session=`。最多 200 条，铃铛显示 10 条，打开即全部已读。
- **账号与钱**：邀请码注册赠 ¥5、改密、退出全部设备、账户页、礼品码兑换、流水、余额两池与订阅。订阅只能用已购池买，会员积分到期/跨期清零；R01–R09 资金与执行恢复修复已在既有提交中，协议见 design §2d/§3。
- **智能体**：真实 LLM 提案、价格快照、批准/驳回、会话预算、图生视频 imageRef、技能 kinds、locale 回复；`AGENT_CHAT_MODELS` 白名单下发真实模型名与逐模型 `turnCny`，turn 点名未知模型在扣款前 400，旧会话模型下架后回落默认。首页与会话页共用模型/图片/视频/技能选择器，提案按 `resolveProductChoice` 钉住实际产品并显示产品名，消息落款显示模型与创意档。技能开关是账号级偏好（`data/prefs/<userId>.json`，`PATCH /api/agent/skills`，旧 localStorage 一次性迁移）；历史抽屉可展开已归档会话。调用失败按原池退款，配置缺失与上游失败用不同错误码。
- **画布**：四类节点、连线输入、拖拽与保存冲突二选一；单节点或整图运行复用 createJob。总价冻结、逐节点转移份额、人工审批、内容寻址复用；审批 24h/排队 1h 超时收敛，已清产物不暗中重生成。
- **R0 素材修复**：保存素材时复制为独立 assetId，首次认领起 30 天，保存/重放不续期；刷新仍可预览，到期或缺失提示重新上传。启动在 tmp 清理前保护旧素材，缺原件标 missing；活动 run 的冻结图、报价与资金台账不被迁移改写。
- **归档留存**：`ARCHIVE_INACTIVE_DAYS`（默认 90，0 关闭）由 runner 每小时维护执行：不活跃且无活动轮次的会话与非最新、无 running run 的画布写 `archivedAt`（列表默认排除，已归档会话发新一轮自动恢复）；终态 run 移入 `canvas-runs/<user>/archive/`（详情可读，泵/资金扫描/幂等查找不再读它）。永不删文件、不动资金字段。backup.sh 白名单已加 `prefs/`；`canvas-runs/` 递归含 archive。
- **呼吸灯与等待特效**：`.shell`（含登录页、分享页、画布）叠两层 fixed 伪元素做整站背景呼吸灯，令牌与 keyframes 集中在 `src/app/globals.css`（`--glow-*`/`--wait-*`）；创作页任务卡、创作面板发送钮/图片槽、智能体思考态与任务卡、画布节点/连线/运行中态统一用冷光表示「等模型」、琥珀表示「等人工审批」，`prefers-reduced-motion` 时全部收敛为静止态，规格见 `DESIGN.md`「圆角 / 高度 / 阴影 / 动效」。
- **上游传输**（2026-09-17，用户报障）：`UPSTREAM_TIMEOUT_MS` 的 abort 定时器只管到响应头到达为止，此后读响应体没有任何时限。上游发完头就不再发数据也不断开时，成片下载的 `pipeline()` 与轮询的 `res.json()` 会永远挂着，任务于是永远停在 `persisting` / `pending` 这种非终态上——界面上的画布节点与创作页任务卡一直转圈，刷新也没用（服务端记录本来就没到终态），`pollUntilDone` 的 15 分钟总时限也轮不到执行（它在 `while` 条件上，代码停在 `await` 里）。现在 `fetchUpstream` 把 abort 控制器接到响应体上，每块数据续一次看门狗，`UPSTREAM_BODY_IDLE_MS`（默认 60s）内一块不来就放弃；判据是静默而非总时长，慢但持续传输的大文件不受影响。所有 provider 共用这条传输层。浏览器侧同理给 `fetchJob`/`fetchCanvasRun` 加了 `AbortSignal.timeout`——任务页的轮询是「上一拍回来才排下一拍」的链，一次永不 settle 的请求会把整条链掐断。回归：`grok/client.test.ts` 三条（去掉看门狗即挂到用例超时）+ `e2e/canvas-wait.spec.ts` 两条（画布单节点与整图运行，终态后必须不再显示等待态——这一侧此前无任何断言）。
- **到期与上传的反馈**（2026-09-17，review 2026-09-15 P1）：作品公开 DTO 多一个派生字段 `artifactsExpireAt`（`completedAt ?? updatedAt` + `DATA_RETENTION_DAYS`，与清理判据同源、不落盘），瀑布流卡片剩 ≤7 天出临期角标、详情浮层常驻到期说明并保留下载入口——留存逻辑本身没动。上传坏文件当场出错：浏览器按 `file.type`/`file.size` 先拦，服务端把 sharp 的解码失败统一成 400 中文文案（不再由 `jsonError` 的 500 把英文原文透出去），失败的首帧不再把模式顶成图生视频。
- **接上死代码与死入口**（2026-09-19，scout N-12/N-13）：此前「点了只弹即将上线」或压根没人 import 的那批，要么接到已有后端，要么换成一句真话。画布左侧 `.canvas-tools` 工具栏渲染出来了（`FIT_PAD_X=108` 本来就给它留着位），「工具箱」抽屉（`CanvasToolbox.tsx`，此前 0 引用）改读真数据——模板来自 `GET /api/templates`、「我的作品」来自 `GET /api/jobs` 成功作品的提示词去重，「应用到画布」新建一个填好提示词的生成节点；生成节点多一枚模型芯片写 `node.product`（这个字段报价与运行一直认，只是没有界面能写）；左下多一条缩放条。`src/lib/skills/types.ts` 变成真加载器：`<DATA_DIR>/skills/<id>/SKILL.md` 与内建 20 条技能合并（同 id 内建优先），进 `backup.sh` 白名单。`src/lib/workflows/types.ts` 变成画布投影 `workflowFromCanvas()`，出口 `GET /api/canvases/:id/workflow`（只读，不建 run、不报价；非本人与不存在同 404），界面上不给下载入口。`providers/jimeng.ts`（submit/poll 直接抛、`hasProviderKey` 还为它硬编码恒假）删掉，`jimeng` 从 `RESERVED_PROVIDER_IDS` 放出来成为普通 relay id——配好接入点就能跑，不配就跟任何未配置的 relay 一样。面板侧：「模板」从模式行挪成开清单的按钮（真模板）、「人声」改名「有声」并真的切到原生音轨产品、「多镜头」改读 30/45/60 长片档（点了真切时长）、置灰模式给具体理由而不是「即将上线」、音频页换成「声音随视频出 + 音轨可控的产品列表」（`uncontrolled` 的产品出不出声由上游定，不承诺也不加价）（这一页没有提交路径，`.composer__opts` 整行 hidden）、「创作搭子」发送把提示词经 sessionStorage 草稿交给真智能体（跳 `/agent`，原话不进地址栏与反代访问日志）、假的「配置面板」按钮删掉。首页「挑战」页签与活动横幅接 `GET /api/templates` 的 `challenge:true`（没有挑战时横幅是「开始创作」，点了展开创作面板）。原型遗留且无对应实现的 CSS/字典/图标（富文本条、骨架屏、结果卡、播放条、写死的模型列表等）一并删除。**仍是缺口**：视频编辑 / 续写没有服务商承接、也没有「拿哪条成片继续改」的入口；动作模仿没有后端；平台不生成独立音频；即梦没有凭据与协议，UI 上没有任何伪装成可用的入口。
- **画布移动端**（2026-09-17，review 2026-09-15 U-02）：窄屏（≤560px）场景层不再按 fit 缩到 0.23，固定 1:1 靠滚动平移，运行钮铺整行；长按 500ms 等价于右键建节点，节点拖拽走 pointer 事件并收 `pointercancel`，无 hover 的设备上删除钮常显、小控件加大热区。
- **R0 工程修复**：CI/部署 typecheck 前补 next typegen；备份加入 relay 配置与素材；画布 e2e 每段独立文档、断言真实 409；AGENTS 瘦身并保留 Next 受管理块，文档索引与大小有自动回归检查。收口时额外修复 relay probe 的付费 POST 默认重试风险：显式 maxAttempts:1；billed:false 只表示平台不记账，上游仍可能收费，本轮未运行真实探针。

模板种子在 `data-seed/templates`；新 DATA_DIR 首次使用需复制到 `data/templates`，部署脚本在目标不存在时落种，不覆盖既有模板。资金迁移基线与备份仍在服务器 `/opt/genius/migrate-baselines/`、`/opt/genius/data.bak.20260912-150535`，不得未经确认清理。

## 3. 全仓审查处理状态

原报告 `docs/review-repo-2026-09-13.md` 保留 dbead84 时的证据。下表描述当前进度；未实施项不记为已修。

| Finding | 当前状态 / 后续 |
| --- | --- |
| F-01 | typegen 前置已修并复现前后差异；`main` `6b5449d` CI 绿，验收成立 |
| F-02 | 备份白名单与真实打包回归已修；生产包检查待部署 |
| F-03 | 独立素材、30 天提示、迁移/归属/过期/刷新回归已落地 |
| F-04 | 画布每段独立文档 + 真实 409 断言 + 在途保存序列化；收口轮全量 e2e 40/40 |
| F-05 | 已落地（`b1c71d0`）：ShellContext 拆 Session/Notices/Jobs/Composer 四 Provider，`useShell()` 为聚合兼容层，复测无 longtask、每击键重渲组件数与基线持平（§5） |
| F-06 | R1.3 已落地并三次生产部署验证：`d7f34eb`/`c44f8a1` 的 `--frozen-lockfile` 与登录态 `build.sha` 通过，`13fb9ee` 的全流程、BUILD_INFO 与公网 health 通过；R1.4 发布目录（`8b5282f`/`0359830`）已于 2026-09-15 生产迁移并双向回滚演练通过；git archive 构建输入未做 |
| F-07 | 同机 cron 已核实；异地副本与恢复核对代码已落地（`34a8ac1`：`--stop-service` 一致性快照、openssl 加密 + ossutil 上传、`restore-check.mjs`），生产 `BACKUP_OSS_*`/`OSS_*` 配置、ossutil 安装与恢复演练待执行 |
| F-08 | 交接区分代码/部署/实测，纠正目录数与备份状态；整合门禁按实际结果收口 |
| F-09 | run/流水线性 IO 仍在；R4.1 的 `admission_ms` 埋点已落地（health 登录态 `admission.wait/hold` 分位数），其余治理待 R4 |
| F-10 | 已落地（R4.1，D-4=b）：`/api/admin/*` 支持本机管理令牌（`LUMEN_ADMIN_TOKEN`，Bearer + XFF 缺失或全 loopback + loopback host 三判据，`src/lib/admin-token.ts`），五个管理 CLI 默认走 HTTP 接口；`--offline` 须先探测服务未运行（ECONNREFUSED）才允许直写 |
| F-11 | 已落地：`withRelayLock` 进程级串行锁包住 create/update/delete 的读-改-写临界区，并发创建/更新不丢写的回归用例在 relay.test.ts |
| F-12 | 规则压到 12KB 内，保留资金/安全约束与框架管理块，大小有回归门禁 |
| F-13 | 已落地：`9e11ea0` runner 拆 `runner/{submit,poll,persist,failover,state}.ts`（壳 288 行）；`538f99c` globals.css 按视图拆 + CanvasView 拆节点卡/报价层/冲突弹层/轮询 hook，`exhaustive-deps` 0 disable |
| F-14 | 已落地：Tailwind 依赖与 postcss 插件移除，`preflight.css`（tailwindcss@4.3.3，MIT）逐字拷贝为 `src/app/styles/reset.css`（`--theme()` 取回落值）；`@theme` 三变量无人使用已删 |
| F-15 | 已落地：`/gallery`、`/studio`、`/studio/:kind`、`/jobs/:id` 四个 stub page 删除，改由 `next.config.ts` `redirects()` 307 到 `/` |
| F-16 | evals:check 实测缺 character-zh/en 两张授权素材；无质量校准记录，先给批次报价，不调用付费接口 |
| F-17 | 已落地：eslint 范围 `src e2e scripts`（CI/AGENTS/deploy.sh 同步），`scripts/**/*.mjs` 加 `// @ts-check` 纳入 tsc 并补 JSDoc 类型 |
| F-18 | docs/README.md 覆盖全部 docs 文件，索引完整性有回归测试 |
| F-19 | Caddy 2.11.4 配置无 forwarded/trusted-proxy 覆盖，与官方默认行为交叉核对；未做公网伪造头实验 |
| F-20 | 保留双缺头放行。现有 smoke 与管理客户端使用 Cookie，直接收紧会破坏兼容，不能采纳报告中的相反前提 |
| F-21 | 保留现有对话 SDK，尚无需要替换的事实依据 |

## 3'. 2026-09-15 全仓审查（UI / 易用性 / 健壮性）

原报告 `docs/review-2026-09-15.md` 保留 `046f59f` 时的证据，顶部的状态表是逐条判定。**五条 P1
（2026-09-17）与 P2/P3 共 34 条（2026-09-17 ~ 09-19，四批）已实施**，逐条依据见原报告 §0.0。
本文只记分类与还剩什么：

| 批次 | 内容 |
| --- | --- |
| P1 五条 | U-01 上传失败可见且不透传 sharp 原文、U-02 画布移动端可操作、B-03 relay 快照缓存键、B-01 `pnpm typecheck` 单一门禁、B-05 产物到期预告 |
| P2/P3 第一批（界面把话说清） | U-06 阻断栏不再讲运维口径、U-14 忙碌原因常驻、C-24 批量部分失败说清已建几条、U-09 档位徽标、U-10 会话钉进地址栏、U-19/C-23 两处错误反馈 |
| P2/P3 第二批（智能体收尸） | B-07 / B-09：`agent/settle.ts` 挂进 runner 每小时维护，卡住的 `thinking` 退款、`executing` 改回待批准 |
| P2/P3 第三批（钱与启动 + 小 UI） | B-10 重试涨价先确认、B-06 止损阀文案、B-11 启动不再全表扫，外加 15 条界面细节（计数器、规格弹层窄屏、轻提示层级、多镜头假开关、死入口标记、焦点环、旧技能开关、头像菜单、画布防抖补发、封面懒加载、订阅档位锁定、素材选择器假 tab、品牌化 404 等） |
| P2/P3 第四批（结构性） | C-13 轻提示队列、C-19 流水序号守卫与按类分页、U-18 节点/会话删除确认、C-11 时区（时间改挂载后渲染）、U-07 `useDialogFocus` 弹层焦点管理、U-08 英文态（标签 / 产品名 / metadata）、U-32 创作页成片区按视口收缩 |

仍未处理的 P2/P3 按原报告正文排队，主要是触控热区（U-15）、对比度令牌（U-22）、方向键
（C-17）、`aria-live` 粒度（C-05）这几条基础可访问性，以及 U-05/C-01 那族「浏览器请求没有
超时」（只修了轮询链上的 `fetchJob`/`fetchCanvasRun`）。

## 4. 未完成与边界

- 生产没有可用的管理员登录会话，本轮未核对登录态 `/api/health` 的 `build.sha`、生产 `/api/models` 与 `/api/agent/skills`；版本以 `BUILD_INFO.json`、匿名内外网 health 与服务状态交叉确认。
- YMan 目录售价按文档积分成本约 ×2 配置；默认「快速」的成本 ¥0.5/¥1，目录模型的 price/credits 尚未经上游真实账单核实，真实付费前仍需对账。
- 无支付网关，订阅收入仍是内部记账；2026-09-13 用户确认无商户主体 → R6 停止条件成立、不开工，继续礼品码；重开条件：取得可开通微信/支付宝商户号的主体。
- R3 首轮校准报价已冻结（plan R3 节，2026-09-13）：仅 scene 用例 ≈¥117–¥145，全 8 条（需授权人物照）≈¥350–¥425；状态「已报价，未开跑，等用户批预算」。授权人物素材仍缺，现有场景用例只覆盖 h45-t2v-zh/en-scene。YMan 长片的 r2v 档 B、minimax-h3 真账单价格仍待验证（R2.4 待用户提供账单实付积分）。
- 常规管理变更（充值/重置密码/停用/铸码）已改走应用内唯一写者（管理令牌 + HTTP）；`--offline` 直写保留但须先探测服务未运行。migrate-billing 与备份仍要求停服窗口；备份不能只停创作准入就声称一致性。
- SQLite 只在多写者/准入 p95/备份约束实际触发时选型。生产 Node 22.22.2 可支持内置模块，但 Node 22 文档仍标 1.1 Active development，不据此迁资金。
- 归档只是列表轴与目录位移，不是删除：会话/画布/run 文件与资金字段都保留；同 idempotency key 在 run 归档后重放会新建 run（有意取舍）。生产 `ARCHIVE_INACTIVE_DAYS` 未显式配置，部署新版后按默认 90 天生效。
- 游离空 material 节点仍使整图报价失败；准入仍 strict 读用户 run 文件；这些行为尚未改变。
- 视频编辑 / 续写（`edit_video`/`extend_video`）后端仍在、仍无服务商承接，UI 继续置灰；动作模仿与独立音频生成没有后端；即梦没有凭据与协议，只能按 relay 自行配接入点。
- 静默看门狗只覆盖走 `fetchUpstream` 的调用。仍有两处裸 `fetch`/无超时：`openai-image/native.ts` 下载 url 形参考图，以及 `src/lib/client/*` 里除 `fetchJob`/`fetchCanvasRun` 之外的浏览器请求（review 2026-09-15 U-05/C-01 登记的同一族）。前者是小文件、后者不在轮询链上，本轮没动。
- 移动软键盘需真机验证，mock e2e 不能证明它；质量与成本不能由 mock 成片证明。
- 异地副本代码已就绪（backup.sh `--stop-service` / OSS 加密上传 / `restore-check.mjs`），生产 OSS 变量未配置、ECS 自动快照设置仍未核实；恢复核对已做过一次（部署前包 `--compare` 一致），完整切换恢复演练未做。构建 SHA 回显（BUILD_INFO/health `build.sha`）两次部署均验证生效，非 root 迁移（R1.5）已执行。

## 5. 前端重渲测量（2026-09-13 实测）

R5.2 已落地（`b1c71d0`）：`ShellContext` 拆为 `shell/{Session,Notices,Jobs,Composer}Provider` 四个域 Provider + 各自 `useSession/useNotices/useJobs/useComposer`；`useShell()` 保留为聚合兼容层，消费者已全部改用域 hook。SSE 走原生 `EventSource` 两条流（`/api/events` 账号级、`/api/jobs/:id/events` 单任务）不变。

条件：生产构建 `next start`，mock + harness，Playwright 驱动，每场景重复 3 次取中位数。拆分后按四个域 hook 分别计数（同一组件可调多个域 hook，合计数 ≠ 组件数）。

| 视口 | 场景 | 拆分前（useShell 计数） | 拆分后（四域合计 / 每击键重渲组件数） | longtask（>50ms） |
| --- | --- | --- | --- | --- |
| 1440×900 | 提示词击键 ×17 | 6.0/击键 | 272 次 hook / 6 组件·击键（session 34/notices 85/jobs 68/composer 85） | 0 |
| 1440×900 | SSE 进度窗口 | 86（6 条 SSE 事件） | 177 次 hook（session 26/notices 52/jobs 49/composer 50，7 条事件） | 0 |
| 1440×900 | 静置 5s | 0 | 0 | 0 |
| 375×667 | 提示词击键 ×17 | 6.0/击键 | 272 次 hook / 6 组件·击键 | 0 |
| 375×667 | SSE 进度窗口 | 84（7 条 SSE 事件） | 171 次 hook（7 条事件） | 0 |
| 375×667 | 静置 5s | 0 | 0 | 0 |

结论：拆分前后每击键重渲组件数持平（6.0，击键写 composer 域、这些组件本就消费它），收益在跨域隔离——jobs/notices 域写入（如 SSE 更新）不再重渲 composer-only 消费者（Dock/Slot/RefStrip/ComposerBar）。无 longtask、无可感知阻塞。

## 6. 下一步与权限

代码侧 R0–R2、R4.0/R4.1（管理令牌 + `admission_ms` 埋点）、R5、R7（告警适配）均已落地；`review-2026-09-15` 的 39 条（P1 五条 + P2/P3 三十四条）已于 2026-09-17 ~ 09-19 实施（§3'），**尚未部署**。

本地可继续推进的代码工作（不需要生产窗口）：原报告剩下的基础可访问性四条（触控热区 U-15、对比度令牌 U-22、方向键 C-17、`aria-live` 粒度 C-05）与 U-05/C-01 那族「浏览器请求没有超时」的剩余部分；限流 `retryAfterSec` 落到文案（B-04）已有 `publicFields` 这条通道可用，界面侧尚未接。挑哪一批由用户定。

待用户/生产窗口动作：

0. **部署本轮修复**（未做，须用户确认窗口）：`deploy.sh` 的门禁步骤已改成 `pnpm typecheck`，部署前值得留意这一处脚本变更。新增可选环境变量 `UPSTREAM_BODY_IDLE_MS`（默认 60000，响应体静默看门狗）不配也能跑。
1. **登录态核对**：生产 `/api/health` 的 `build.sha` 应为 `83065c7…`；`/api/models`、`/api/agent/skills`（7 个模型 + `off`）、铃铛与历史抽屉「已归档」在真实账号下过一眼。归档 sweep 首次将在部署后 1 小时的维护 tick 执行，默认 90 天阈值，生产目前不会有对象。
2. **告警渠道**：`LUMEN_ADMIN_TOKEN` 已配置并实测生效（loopback→200 `{sent:false}`、公网→401，见 runbook「管理 CLI」节）；`.env` 仍待填 `ALERT_WEBHOOK_URL` + `ALERT_WEBHOOK_FORMAT`（feishu/dingtalk/wecom/generic）+ `ALERT_WEBHOOK_SECRET`（飞书/钉钉签名密钥），配后跑 `sudo -u genius node scripts/alert-test.mjs` 做真实触发验证（钉钉自定义机器人关键词填 `Lumen`）。
3. **备份异地副本**：`.env` 配 `BACKUP_OSS_BUCKET`/`BACKUP_OSS_PREFIX`/`BACKUP_ENC_PASSPHRASE`/`OSS_ACCESS_KEY_ID`/`OSS_ACCESS_KEY_SECRET`/`OSS_REGION`（或 `OSS_ENDPOINT`），安装 ossutil 2.x（见 runbook 备份节）；首次 `--compare` 核对已做，完整恢复演练（解包→切换→验证）待执行。
4. **R3 预算拍板**：scene-only ≈¥117–145 / 全 8 条 ≈¥350–425（报价见 plan R3 节）；全量评测还需**两张授权人物照**（`evals/README.md` 登记要求）。
5. **R2.4**：提供 YMan 账单实付积分以核对 `minimax-h3` 真实成本（`costUsdActual` 现为兜底估价）。
6. R4 后续（非生产窗口）：索引增量写；SQLite 仅在 §3.2 触发条件（多写者 / `admission_ms` p95 超阈 / 备份约束）成立时选型——health 已有 `admission.wait/hold` 分位数可观测。

约束：用户已定移除 Tailwind、e2e 定时+手动、CLI 走应用管理入口、素材 30 天明示、真实评测先报价；尚未授权任何实际评测花费。生产变更、停服、改归属、覆盖/删除数据都须展示具体动作并确认；不自动部署。
