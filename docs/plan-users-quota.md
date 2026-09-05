# 方案：用户系统 · 日配额 · 数据留存清理

| 字段 | 值 |
| --- | --- |
| 状态 | v2，已按 Codex 评审（BLOCK，6×P1 + 1×P2）修订，待用户确认后实装 |
| 日期 | 2026-09-06 |
| 前置 | `d028578`（生图 provider + 生产部署已完成） |
| 影响面 | `src/lib/jobs/`、`src/app/api/`、`src/proxy.ts`（AGENTS.md 列的高风险区） |
| 评审记录 | `~/.claude/state/codex-review/VideoPlatFrom/review-20260905-162140-plan.md` |

## 1. 目标与不做项

**目标**：把当前「全站一个共享口令」的单用户实例，变成可以发给一批认识的人使用的多用户实例，每个账号每天最多出 10 张图。

**明确不做**（本轮）：邮箱验证（服务器无 SMTP）、找回密码、付费档与支付、OAuth、多实例/水平扩容、管理后台 UI。

## 2. 存储：沿用现有文件系统风格

不引入数据库。理由：现有 `job.json` 已是「先落盘再发 SSE、轮询是真相」的模型，单实例部署，引入 SQLite 只增加原生依赖（这次部署已被 sharp/ffmpeg 的跨平台二进制坑过）而不解决任何当前问题。

```
data/
  users/
    index.json          # { "email@x.com": "usr_xxx" } —— 派生缓存，非事实源
    usr_xxx/user.json   # 事实源
```

**唯一事实源是 `usr_xxx/user.json`**（P2 修订）。`index.json` 只是 email→id 的加速缓存，可由扫描 `data/users/*/user.json` 完整重建。

写入顺序固定为「先写 user.json，再更新 index.json」，两步都用现有 `store.ts` 的「临时文件 + rename」原子替换。任一步之间崩溃的恢复规则：

| 崩溃点 | 结果 | 恢复 |
| --- | --- | --- |
| user.json 写入前 | 无残留 | 无需处理，用户重试注册 |
| user.json 已写、index 未更新 | 用户存在但登录查不到 | 启动时校验：扫描 users 目录重建 index |
| 两步都完成 | 正常 | — |

服务启动时校验 index 与目录一致，不一致即重建；注册走一把与 `src/lib/jobs/admission.ts` 同款的进程内串行锁。

## 3. 会话：HMAC 签名 Cookie

Cookie 值 = `usr_xxx.<过期时间戳>.<HMAC-SHA256>`，密钥取新环境变量 `LUMEN_SESSION_SECRET`（未设置时服务启动即报错，不允许静默降级）。有效期 30 天，`timingSafeEqual` 校验。

**撤销能力**（P1-1 修订）：无服务端会话表意味着不能踢单个会话，因此：
- 每次请求校验会话后**都要读一次 `user.json` 确认 `disabled` 不为真**——封禁立即生效，代价是每请求一次小文件读（单实例、量小，可接受）。
- 全体登出 = 轮换 `LUMEN_SESSION_SECRET`。
- 用户改密码时在 `user.json` 写 `sessionEpoch`，签名内容包含它，改密即让旧 Cookie 全失效。

## 4. 注册与邀请码

注册需要：邮箱、密码（≥ 8 位）、**邀请码**（复用 `LUMEN_ACCESS_TOKEN`，语义从「全站访问口令」改为「注册邀请码」）。

**升级窗口**（P1-4 修订）。现网实例正在用 `LUMEN_ACCESS_TOKEN` 保护全部 `/api/*`，语义切换必须避免出现「谁都能注册」或「谁都进不去」的窗口，因此规定：

1. 新增独立变量 `LUMEN_INVITE_CODE`，**不复用**同一个变量名——两者可以并存一段时间。
2. `LUMEN_INVITE_CODE` 未设置时，`/api/auth/register` 一律返回 403（宁可谁都注册不了，也不能谁都能注册）。
3. 部署顺序：先在 `.env` 写好 `LUMEN_INVITE_CODE` 与 `LUMEN_SESSION_SECRET` → 再重启到新版本 → 管理员第一个注册 → 把返回的 user id 写进 `LUMEN_ADMIN_USER_ID` → 再重启一次。
4. 旧的 `LUMEN_ACCESS_TOKEN` 在新版本里不再有任何作用，部署完从 `.env` 删除。

**管理员**（P1-1 修订）：不再用邮箱匹配（邮箱可被抢注）。改为 `LUMEN_ADMIN_USER_ID` 绑定具体 user id，该 id 由 §4.3 的流程产生。未设置时**没有任何人是管理员**，无主的历史任务对所有人不可见。

## 5. 隔离：ownerId 必须覆盖四条路径

`JobRecord` 增加 `ownerId?: string`。除了任务本身，Codex 指出另外三条会被绕过的路径，一并处理：

### 5.1 任务读写

| 位置 | 改动 |
| --- | --- |
| `POST /api/jobs` | 从会话取 `ownerId` 写入记录 |
| `GET /api/jobs` | 只返回本人任务 |
| `GET /api/jobs/:id`、`/events`（SSE）、`/cancel`、`/retry` | 非本人 → **404**（不用 403，避免探测任务是否存在） |
| `GET /api/media/:jobId/:file` | 同样按 owner 校验，不能因为是静态文件就跳过 |

### 5.2 幂等回放（P1-2）

现状：`idempotency.ts` 的 `fileFor(key)` 是 `sha256(clientKey)`，不含用户；`create.ts` 在校验之前先查这个映射，命中即 `return toPublic(rec)` —— **猜到他人的 key 就能拿到他的任务**。

修订：幂等文件名改为 `sha256(ownerId + "\0" + clientKey)`，且回放命中后**仍要校验 `rec.ownerId === 当前用户`**，不一致视为未命中。旧的无主幂等记录一律视为未命中（它们是开发期产物）。

### 5.3 上传资产（P1-3）

现状：`upload.ts` 写的 sidecar 没有归属字段，`create.ts` 的 `loadSidecar` / 认领只校验 ID 与 role 就 `rename` —— **知道他人 uploadId 就能把他的文件认领走**。

修订：sidecar 增加 `ownerId`，上传时写入；`loadSidecar` 校验归属，不符即按「上传不存在」拒绝（同样用 404 语义，不泄露存在性）。旧的无主上传视为不存在。验收要覆盖「跨用户认领被拒且原文件仍在」。

## 6. 配额：每账号每天 10 张

### 6.1 计数口径（P1-5 修订，这条直接关系到花钱）

Codex 指出：`cancel` 只改本地状态、**不中止上游的图片生成**，且失败也可能发生在上游已计费之后。原方案「失败/取消不计数」会让人反复提交再取消——本地不扣额度，你的上游余额却在真扣。

修订口径：**只要任务到过 `submitting`（即已向上游发出计费请求），就永久占用一个额度**，无论最终 succeeded / failed / canceled。

| 场景 | 占额度 | 理由 |
| --- | --- | --- |
| 参数校验失败、队列满、配额本身超限 | 否 | 从未碰上游，没花钱 |
| 已提交上游，随后成功 | 是 | 正常消费 |
| 已提交上游，随后失败或被取消 | **是** | 上游可能已经扣费 |

代价：上游故障导致的失败会占用户额度。补偿方式是管理员手工改 `job.json`（本轮不做退还 UI）。这是**宁可让用户少出一张，也不让你多付一次钱**的取舍。

### 6.2 并发与重试（P1-4 修订）

现状：`retryJob` 走独立的 `withAdmissionLock(retryJobUnlocked)`，完全不经过创建路径的配额检查；且「先查数量再落盘」若不在同一临界区，同一用户并发 5 个请求可以一起通过检查。

修订：**配额判定与任务落盘必须在同一个 `withAdmissionLock` 临界区内完成**，且 `retryJob` 走同一段检查（重试同样会向上游发新的计费请求）。

验收必须覆盖：剩 1 个名额时并发 5 个创建只成功 1 个、创建与重试竞争同一名额、满额后幂等回放不新增消费。

### 6.3 其余

- 「今日」按 **Asia/Shanghai** 自然日，不做每用户时区。
- 超限：`429 quota_exceeded`，消息含「今日已用 10/10，北京时间 0 点重置」。
- 数据来源：从 `job.json` 现场统计，不维护第二份计数器（会漂移）。单实例、每人每天 10 条，量级极小。
- 环境变量 `FREE_DAILY_IMAGE_QUOTA`（默认 10）。
- UI：画幅芯片旁显示「今日剩余 n/10」，由 `GET /api/me` 提供。

### 6.4 一个必须讲清楚的限制

配额是**按账号**而非按自然人。共享同一个邀请码的情况下，一个人注册多个账号即可绕过。要做到「按人」，需要一次性邀请码（每码只能用一次、可追溯发给谁）——**这是本轮之外的额外工作，需要你决定是否现在要**。

## 7. 登录 / 注册页

新路由 `/login`：登录 / 注册两个 tab，注册多一栏邀请码。视觉复用 `src/app/globals.css` 既有令牌与 `mountDawn` 河面背景，不新增设计语言、不引组件库。未登录访问 `/` → 服务端重定向。顶栏「登录」改为「用户名 / 退出」。现有 `AccessTokenPrompt` 弹窗退役。

新增 API：`POST /api/auth/register`、`/login`、`/logout`，`GET /api/me`（email、plan、今日已用/剩余）。

**限流**：登录与注册按 IP + 邮箱做进程内滑动窗口（10 次/分钟），防在线撞库。这是本方案唯一的新增内存态，重启即清空。

## 8. 数据留存清理（P1-7 修订）

Codex 指出原方案有四处冲突：状态机里 `succeeded` / `failed` / `canceled` 都是**无出边的终态**，根本转不到 `expired`；`cleanupJobArtifacts` 不清理 `inputs/`；作品环只收 `succeeded`，不会显示「已过期」；而 `create.ts` 允许 `expired` 任务重试，清理后重试会缺输入文件。

修订：**不动执行状态，另设产物留存状态**。

- `JobRecord` 增加 `artifactsPurgedAt?: string`。清理只写这个字段，`status` 保持 `succeeded` 不变——不碰状态机。
- 清理范围：终态任务超过 `DATA_RETENTION_DAYS`（默认 30）时删 `outputs/` **与 `inputs/`**（`cleanupJobArtifacts` 需相应扩展）。
- UI：作品环仍收 `succeeded`，但 `artifactsPurgedAt` 非空的显示占位卡「作品已过期清理」，不给播放/下载入口。
- **重试**：`artifactsPurgedAt` 非空的任务禁止一键重试（输入已删）；UI 引导「用这条提示词重新生成」，走全新提交与全新配额。
- `data/tmp/`、`data/idempotency/` 超 24 小时直接删。
- 触发：复用现有 `sweepTmp` 的定时器（启动一次 + 每小时）。

## 9. 实施顺序与验收

1. 用户存储 + 会话 + 注册/登录 API + 限流。单测：密码哈希与校验、签名伪造/过期、`disabled` 即时生效、改密使旧 Cookie 失效、并发注册同邮箱只产生一个 id、index 损坏后能重建。
2. `proxy.ts` 换成会话校验；`ownerId` 落到 job + **幂等 + 上传 + media + SSE** 四条路径。单测：越权访问全部返回 404、跨用户幂等 key 不回放、跨用户认领上传被拒且原文件保留。
3. 配额：判定与落盘同临界区，创建与重试共用。单测：第 10 条通过 / 第 11 条 429、已提交上游后取消仍占额度、提交前失败不占、并发 5 个只过 1 个、跨零点重置（注入固定时钟）。
4. `/login` 页面与顶栏改造。`pnpm e2e` 补：注册 → 登录 → 出图 → 退出 → 越权访问他人任务 404。
5. 留存清理 + 单测：清理只写 `artifactsPurgedAt` 不改 status、inputs 一并删、已清理任务不可重试。

**门禁**：`tsc` / `eslint` / `pnpm test` 全绿，`pnpm e2e` 全绿。

## 10. 已知风险

| 风险 | 处理 |
| --- | --- |
| 配额按账号而非按人 | §6.4，需用户决定是否上一次性邀请码 |
| 无邮箱验证 → 邮箱可伪造 | 有邀请码兜底；管理员靠 `LUMEN_ADMIN_USER_ID` 绑定而非邮箱匹配 |
| 上游故障导致的失败仍占额度 | §6.1 的取舍，管理员可手工改 `job.json` 补偿 |
| 密码存本机文件 | `.env` 与 `data/` 权限 600/700；scrypt 加盐；不入库 |
| HMAC 会话无法单点撤销 | §3 用每请求读 `disabled` + `sessionEpoch` 覆盖主要场景 |
| 单实例、本地文件 | 本轮明确不做水平扩容 |
