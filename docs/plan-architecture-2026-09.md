# 架构综合审查与治理设计（2026-09-06）

| 字段 | 值 |
| --- | --- |
| 状态 | v1 草案，待用户确认优先级；Codex 方案审查待额度恢复后补 |
| 基线 | `main` @ `8f82f52`（可灵 provider 已上线，生产 `videoProvider: kling`） |
| 输入 | 三个只读审查（服务治理 / 性能 / 功能完整度），每条结论带 `文件:行号`；本文只收敛为决策与路线，逐条证据见 §附录 |
| 产出 | §3 目标架构、§4 三个阶段的路线图、§5 需要用户拍板的决策 |

## 1. 一句话诊断

**「一条任务从提交到落盘，且不多花一分钱」这条主线做得异常扎实**：原子写 + 每 job 锁、配额判定与落盘同临界区、取消时绝不发计费 GET、已计费请求绝不重发、`uncertain_submit` 拒绝重试、留存清理只删产物不改状态。**主线之外的外壳很薄**：视频不限量、崩溃恢复有一处会重复计费、无备份、无回滚、无管理面、账号只能进不能修、后端一半能力前端不可达、性能上有三处会随任务数线性恶化。

现状规模：单台 2 核 1.8G ECS，`data/jobs` 155 条 / 85MB，内测用户量级为「一批认识的人」。这决定了路线：**先补财务与数据安全的洞，再补随规模恶化的性能点，最后再扩功能面**；不引入数据库、不做多实例，直到 §4 的第三阶段才重新评估。

## 2. 问题总表（按严重度，去重后）

| # | 维度 | 问题 | 证据 | 影响 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| G1 | 治理 · 钱 | 单片任务崩溃恢复：`submitting` 且无 `remoteId` 时无条件重排队，再发一次计费 POST | `recover.ts:28`、`runner.ts:92-98,144` | 一次 OOM / 重启即可能双倍付费；与 harness 侧 `uncertain_submit` 原则自相矛盾 | 0.5 天 |
| G2 | 治理 · 钱 | 视频完全没有配额，只有全站 `MAX_QUEUED_JOBS=20` | `quota.ts:255`、`create.ts:70` | 单账号一晚可烧数十美元；`/api/me` 的「今日剩余 n/10」在做视频时纹丝不动，误导 | 1–1.5 天 |
| G3 | 治理 · 数据 | `data/`（用户、邀请码、任务、成片）无任何备份，是唯一事实源 | `deploy.sh:12`、`scripts/` 目录 | 盘坏或误删即全量丢失，RPO 为无穷 | 0.5 天 |
| G4 | 治理 · 发布 | 部署无回滚判定、无 CI；health 非 200 不触发 `.next.prev` 回滚 | `deploy.sh:45-69` | 坏构建 = 持续 500 直到人工发现 | 回滚 2h，CI 0.5 天 |
| P1 | 性能 · 内存 | `sharp` 解码无像素上限，12MB 合法 JPEG 可解出 430MB；质量回退循环最多重解码 5 次；上传不受 `JOB_CONCURRENCY` 保护 | `upload.ts:13,87-91,175`、`preprocess.ts:12,22-35` | 两个用户同时传大图即 OOM（systemd `MemoryMax=700M`） | 0.5 天 |
| P2 | 性能 · IO | 首页 SSR、配额准入（在全局锁内）、runner 每次 pump、`activeCount`、retention 都全量串行读所有 `job.json` | `store.ts:180-189` 及六处调用 | 随历史任务数线性恶化，几千条后提交吞吐被拖垮；`retention` 不删 `job.json`，只增不减 | 索引 1–1.5 天 |
| P3 | 性能 · 带宽 | `/api/media` 无 `Cache-Control` / `ETag`；作品环一次拉 40 张全量穿透 Node | `media/route.ts:67-87`、`lumen-three.ts:205` | 2 核机事件循环被 40 路流挤满 | 2h |
| G5 | 治理 · 上游 | 可灵 `1303` 并发超限 / `1102` 余额不足映射为 429 后在 submit 阶段直接 fail，并计入止损阀；poll 阶段 429 又会被重试 | `kling/client.ts:70-73`、`runner.ts:159-173,387` | 用户看到「失败」而非「排队」；余额不足时无谓重打上游 | 0.5 天 |
| G6 | 治理 · 超时 | 15 分钟轮询上限是字面量，兼作 recover 的陈旧判定；`klingTaskTimeoutMs()` 无调用方 | `runner.ts:300`、`recover.ts:3`、`env.ts:215` | 上游慢于 15 分钟时本地判失败但上游照常出片计费：「付了钱丢了货」 | 0.5 天 |
| G7 | 治理 · 安全 | 登出不递增 `sessionEpoch`，30 天 Cookie 登出后仍有效；提交 / 上传无限流；`/api/health` 匿名回显上游选型；CSRF 只靠 SameSite | `logout/route.ts:6-10`、`rate-limit.ts` 引用面、`proxy.ts:23` | 中低；内测阶段可接受但应在开放前修 | 合计 0.5 天 |
| G8 | 治理 · 观测 | 日志无 request id；无指标 / 告警；成本无按天 / 用户 / provider 汇总；health 缺磁盘水位、队列积压、上游可达 | `log.ts`、`health/route.ts:19-59` | 出问题只能翻 journalctl；花了多少钱要手算 | 1.5 天 |
| F1 | 功能 · 账号 | 无改密、找回、注销；`changeUserPassword` 只有测试在调 | `api/auth/` 目录、`service.ts:105` | 忘密码 = 账号永久失联（邀请码已消费） | 改密 0.5 天，重置 CLI 0.3 天 |
| F2 | 功能 · 管理 | 管理员唯一特权是看无主任务；禁用用户、看用量、发码都要 SSH | `ownership.ts:12`、`schema.ts:28 disabled` 无写入 | 滥用只能改 `.env` 重启 | CLI 1 天 |
| F3 | 功能 · 诚实 | UI 固定发 `generateAudio: true`，可灵实例实际静音，界面从不说明；成本一律打 `$`，ccgoai 生图实为人民币 | `LumenHome.tsx:490,187`、`.env.example:34-36` | 「为什么没声音」「账目差 7 倍」 | 各 0.5h / 0.5 天 |
| F4 | 功能 · 能力面 | r2v / edit / extend 前端不可达；2K 出图、1080p、7 画幅 UI 写死；`labels.ts` 大半死代码；Harness 生产关闭且被钉在 grok | `LumenHome.tsx:26-36,485-490`、`router.ts:56` | 后端一半能力零曝光 | 决策为主 |
| F5 | 功能 · 生命周期 | 无删除单条、无分享链接、作品只显示 40 条无分页、无搜索 | `api/jobs/[id]/` 目录、`page.tsx:33` | 40 条以后老作品看不到只能等清理 | 各 0.5–1 天 |
| F6 | 功能 · 内容安全 | 无前置审核；moderation 失败只显示上游原文、不说明是否计费；无举报 / 封禁 | `runner.ts:230`、`upload.ts` | 上游封号风险；客服成本 | 0.7 天 |
| F7 | 功能 · 文档 | README 仍写已删除的 `LUMEN_ACCESS_TOKEN`；`.env.example` 有两个无人读的开关；无 runbook | `README.md`、`.env.example:147-148` | 新人按 README 起不来 | 0.5 天 |
| P4 | 性能 · 其他 | 上游轮询固定 2s 无退避且每次写盘发 SSE；客户端 SSE + 2s 轮询双通道；冷启动 await 两次全扫；iframe 从 jsdelivr 拉第二份 three；两个 WebGL 常驻 | 见附录 | 中低，累积性 | 合计 1 天 |

## 3. 目标架构（治理 · 性能 · 完整度三条线）

### 3.1 保持不变的决策（有意为之，写进文档防止被「优化」掉）

- **单进程 `next start`**：`store.withLock`、`withAdmissionLock`、SSE 总线、`inflight` 都是进程内状态，开第二个 worker 会同时破坏配额、原子性与 SSE。多进程前必须先换文件锁 / 外部总线。
- **文件系统存储，不上数据库**：单实例下 job.json + 原子 rename 已足够；引入 SQLite 会再踩一次原生依赖跨平台的坑。规模问题用 §3.3 的派生索引解决，而不是换存储。
- **轮询是真相，SSE 只是加速**：保持；但客户端在 SSE 健康时把轮询退到 10s。
- **`/api/media` 不走 `next/image`**：产物是私有动态文件，走 `next/image` 只会让 Node 再跑一遍 sharp；用缓存头解决。

### 3.2 服务治理线

**成本闸门（统一模型）**：把现在「文生图每日张数」扩成「按 mode 分桶的每日次数 + 按 `costUsdEstimate` 累计的每日金额上限」，仍在 `withAdmissionLock` 内、`writeJob` 之前判定，`createJob` 与 `retryJob` 共用。新增 `FREE_DAILY_VIDEO_QUOTA`（默认 10）、`FREE_DAILY_USD_CAP`（默认 3）。`/api/me` 的 quota 返回三桶，UI「今日剩余」按当前 mode 显示。管理员不豁免（沿用）。

**计费安全闭环**：`recover` 对「`submitting` 且无 `remoteId`」不再 requeue，改为 `failed` + `uncertain_submit`，由现有 `retry-guard` 409 拦截；可灵路径已发送 `external_task_id=jobId`，恢复时先 `GET /tasks?external_task_ids=` 回填 `remoteId` 再 `resume-pending`，把窗口彻底关掉。`rate_limited` / `quota_exhausted` 从终态失败改为「退避后回 `queued`，最多 3 次」，并从止损阀统计中排除。轮询上限按 provider 读（可灵用 `klingTaskTimeoutMs()`），与 recover 的陈旧判定解耦。

**数据安全**：每日 cron 打包 `data/users`、`data/invites`、全部 `job.json`（不含产物）到 OSS 或异机，保留 7 份；成片按需另议。`deploy.sh` 末尾 health 非 200 即 `mv .next.prev .next` + restart + 非零退出。GitHub Actions 最低配：`tsc` + `eslint` + `pnpm test`，push 到 main 触发。

**安全收口**：logout 递增 `sessionEpoch`；`POST /api/jobs`、`/api/uploads` 复用 `consumeRateLimit`（每分钟 10 / 5）；`maxQueuedJobs` 加 per-owner 子上限 5；`/api/health` 匿名只回 `{ok}`，详细字段需会话；proxy 对非 GET 校验 `Origin`。

**可观测性**：`log()` 增加 `reqId`（路由入口生成，AsyncLocalStorage 透传）与 `jobId / ownerId`；health 纳入磁盘剩余百分比、队列积压阈值、runner 存活；管理员 CLI `usage --day` 聚合 `costUsdActual` 按天 / 用户 / provider；`budget_exceeded` 与 `costOverTarget` 接 webhook 通知。

**Provider 接口演进**：`VideoProvider` 补 `validate(req): Issue[]`（取代 `create.ts` 里 grok / kling 各自的特判，画幅等错误前移到创建时 400）、可选 `cancel(handle)`、可选 `health()`。接第四家时只增目录与 router 一行。

### 3.3 性能线

**内存**：`sharp(input, { limitInputPixels: 40e6, sequentialRead: true })`；`MAX_IMAGE` 12→6MB、`MAX_VIDEO` 48→24MB；质量回退改为对已缩放中间结果重压；启动时 `sharp.concurrency(1); sharp.cache(false)`；systemd 加 `NODE_OPTIONS=--max-old-space-size=1024`。`uploadXaiFile` 改流式 FormData。

**IO**：`data/jobs/index.json`（`id, ownerId, status, mode, createdAt, completedAt, artifactsPurgedAt, costUsdEstimate/Actual`），由 `writeJob / updateJob` 增量维护，启动重建（照 `users/index.json` 的模式）。首页、`/api/jobs`、配额、`activeCount`、retention 全部改读索引；`pump()` 改为内存待办集合。超过 3× 留存期的记录归档到 `data/archive/`。做完之前 `DATA_RETENTION_DAYS` 先降到 14 控制目录数。

**带宽**：`/api/media` 加 `Cache-Control: private, max-age=31536000, immutable` + 弱 ETag + 304；Caddy 直出 `/_next/static/*` 与 `/lumina/*`。

**轮询**：上游 2s → 5s → 10s 阶梯；`progress` 无变化不写盘不发 SSE；客户端 SSE 健康时轮询退到 10s；冷启动 `maintenance()` 延后 30s。

**前端**：`LumenHome.tsx` 拆展览区 / 作品环为 `memo` 子组件，`onTurn` 用 ref；作品视图时暂停 dawn 的 rAF；幕布 iframe 的 three 改为构建时内联（只改 script 标签一行，文档记录偏离）。

### 3.4 功能完整度线

**必须补的诚实性**：任务卡与作品卡显示「有声 / 无声」；货币单位做成 `COST_CURRENCY` 透传 DTO；上游错误码给中文兜底（1102「平台余额不足，请联系管理员」、1301「未通过内容审核，本次不计费」）；README 重写运行节。

**账号闭环**：`POST /api/auth/password`（复用 `changeUserPassword`，递增 `sessionEpoch`）+ 顶栏入口；`scripts/reset-password.mjs` 管理员重置；注销 = 软删 + 清 `data/jobs` 归属，放第三阶段。

**管理闭环**：三个 CLI（`disable-user`、`usage --day`、已有 `mint-invites`）先行；`/api/admin/*` 与页面等有需求再做。

**任务生命周期**：`DELETE /api/jobs/:id`（终态才可删，删产物与记录）+ 环上删除；`?before=` 游标分页 + 「加载更多」；分享用 24h 签名 URL，与 `artifactsPurgedAt` 协同。

**能力面（需决策，见 §5）**：r2v / edit / extend 要么补 UI，要么删 `labels.ts` 死代码并在 README 标「仅 API」；Harness 要么定位为白名单实验，要么 README 标「未上线」；分辨率 / 2K / 音频作为高级选项芯片露出，由 provider `validate` 决定可用项。

**内容安全**：本地关键词黑名单前置（提示词）；服务条款页；moderation 失败文案说明计费情况；`invitedBy` 作为追溯抓手。

## 4. 路线图

| 阶段 | 目标 | 内容 | 估时 |
| --- | --- | --- | --- |
| **一 · 止血**（本周） | 不多花钱、不丢数据、能回滚 | G1 恢复不重提 · G2 视频配额 + 金额上限 · G3 每日备份 · G4 部署回滚 + CI · P1 sharp 限制 · P3 媒体缓存头 · F3 音频标注 · G5 429 退避 | 4–5 天 |
| **二 · 稳态**（下两周） | 随规模不恶化、出问题看得见 | P2 jobs 索引 + 归档 · G6 超时按 provider · G7 安全收口 · G8 日志 reqId + health 扩展 + usage CLI · P4 轮询阶梯 / 冷启动 · F1 改密 + 重置 CLI · F2 管理 CLI · F7 README / runbook / env 清理 | 6–8 天 |
| **三 · 外壳**（之后） | 产品闭环 | F5 删除 / 分页 / 分享 · F6 前置审核 + 条款 · F4 能力面决策落地 · Provider `validate/cancel/health` 接口迁移 · 前端拆分与 three 内联 · 注销账号 | 8–10 天 |

每阶段结束：门禁三绿 + `pnpm e2e` + 部署 + handoff 写回；阶段一、二的 diff 触及 AGENTS.md 列的高风险区（`jobs/`、`proxy.ts`、`api/`），按规则派 Codex 审。

## 5. 需要用户拍板

1. **视频配额默认值**：每日 10 条 + 每日 $3 金额上限，是否合适？（可灵 5s 720p 一条 $0.15，10 条 = $1.5）
2. **r2v / edit / extend**：补 UI（各 1–2 天，且可灵不支持，只在 grok 有 key 时可用）还是标「仅 API」删死代码？建议后者，等有 grok 预算再说。
3. **Harness 长片**：生产继续关闭并在 README 标「实验」，还是开白名单？它被钉在 grok，一条 30s ≈ $2.1–4.2。建议前者。
4. **备份目标**：阿里云 OSS（同账号，最省事）还是本机每日 rsync 拉回？建议 OSS。
5. **是否现在就把 `DATA_RETENTION_DAYS` 从 30 降到 14**：这是索引做完前控制目录数最便宜的手段。

## 附录 · 审查原文要点

三份审查各给出「已经做得好的地方」，共同点：注释密度高、每个非显然决策都写了原因；权限隔离是收口式的（越权一律 404）；`completedAt` 只在非终态→终态盖章一次，配额归日与留存共用同一定义；`stageThenCommit` 强制 tmp → rename，取消永不留半个文件。这些是最值得保持的资产，本文所有改动都应服从这些既有纪律。

量化参数建议（2 核 / 1.8G / 40G）：`JOB_CONCURRENCY` 保持 2；`MAX_IMAGE` 6MB；`limitInputPixels` 40MP；`sharp.concurrency` 1；`MAX_VIDEO` 24MB；Caddy 侧限并发上传 2；`DATA_RETENTION_DAYS` 14（索引后可回 30）；`MAX_QUEUED_JOBS` 保持 20；Node old-space 1024MB；SSE `setMaxListeners(200)` 保持但加日志。
