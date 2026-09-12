# H 包：通知落盘、错误码多语言、账户页、移动端回归

日期：2026-09-12。基线：`04efdce`（已部署生产）。状态：Codex 评审已过（§6.1）、用户 2026-09-12 确认（§7 三项按默认建议），实施中。
上位计划：`docs/plan-unimplemented-2026-09-08.md` §9（H：账号、语言、移动端和数据留存）。本文只覆盖其中**无外部依赖、纯代码可交付**的四刀；忘记密码（需发信渠道）、账号删除政策、会话/画布留存期限继续按上位计划待产品确认，不在本包。

## 0. 目标与非目标

| 刀 | 用户可见结果 | 非目标 |
| --- | --- | --- |
| H1 通知落盘 | 刷新 / 换设备后铃铛里仍能看到最近的「任务完成 / 失败」记录，未读红点跨刷新一致 | 不做邮件 / 推送；不通知画布 run、智能体轮次（它们各自页面已有状态，二期再并入同一索引） |
| H2 错误码多语言 | 英文界面下 402/409/429/503 等常见错误的 toast 是英文，不再是服务端中文原文 | 不改服务端 `message`（日志与 CLI 仍靠它）；不翻译上游透传的原文 |
| H3 账户页 | `/account`：邮箱、注册时间、两池余额与订阅摘要、修改密码、退出全部设备、积分流水入口 | 不做资料编辑（昵称 / 头像）、不做账号删除、不做忘记密码 |
| H4 移动端回归 | 375 / 390 / 768 三档下五视图 + 登录 + 账户页的主要按钮可触达、弹层可关、键盘不遮输入、无横向溢出 | 不重做画布移动端交互（上位计划留给可用性测试） |

## 1. 共同约束（沿用 AGENTS.md）

- 浏览器只经 `src/lib/client/*` 访问 `/api/*`；组件不直接 fetch。
- 文案一律 `useT("ns.key")`，键只在 `messages/zh-CN/<ns>.ts` 新增，`en` 漏译编译期报错。
- 新增落盘文件一律 `writeJsonAtomic`；路径带 ownerId；读回再核 ownerId；坏文件按各自纪律处理（通知是展示数据：坏文件记 warn 视为空，不 fail closed——它不是资金）。
- **不碰 `user.json`**：通知索引与已读游标不进资金提交点（避免每条任务完成都在用户锁里重写余额快照）。
- 不改 `src/proxy.ts` 放行名单：新增路由全部要会话。

## 2. H1 通知落盘

### 2.1 数据

`data/notifications/<userId>.json`：

```ts
{
  schemaVersion: 1,
  ownerId,
  epoch: string,            // 存储代际（随机 id）：文件损坏/重建时换新值，旧客户端的游标全部作废
  nextSeq: number,          // 下一条要分配的序号（同一 epoch 内单调递增）
  lastReadSeq: number,      // 用户已读到的序号（含）
  items: Array<{
    seq: number,
    id: string,             // `${jobId}:${status}`，同一次完成只入一次
    kind: "job",
    jobId: string,
    status: "succeeded" | "failed" | "canceled" | "expired",
    mode: JobPublic["mode"],
    prompt: string,         // 截 120 字，成功时的摘要
    errorCode?: string,     // 失败时的稳定码（与 H2 共用字典）
    errorMessage?: string,  // 服务端原文兜底
    at: string,
  }>,
}
```

- 每用户保留最近 200 条（`MAX_NOTIFICATIONS`），append 时从头截断。
- 坏文件 / 不存在：记 warn 后以新 `epoch` 重建空文件（通知不是资金，不 fail closed）；`epoch` 变了意味着客户端手里的 `seq` 不再可比，见 §2.3 的 409。
- 每用户一把内存串行锁（同 `run-store.ts` 的 tail-promise 形状，按 userId 分桶），读-改-写在锁内；与 admission / user 锁无关，不参与既有锁序。
- 标题不落盘：客户端按 `status` 用 `shell.notice.*` 渲染，语言切换后历史通知也跟着变。

### 2.2 写入点

`src/lib/jobs/store.ts` `updateJob`：在 `writeJobJson` + `upsertJobIndex` 之后、返回之前，若 `!isTerminalStatus(before) && isTerminalStatus(next.status) && next.ownerId`，调用 `appendJobNotification(next)`。**best-effort**：抛错只 `log("warn")`，不影响任务落盘与扣款（通知丢一条比任务卡住便宜）。`updateJob` 是全仓唯一的终态边沿（`stampCompletedAt` 的注释已论证），所以不需要在 runner / cancel / recover 各处再加。

`id` 幂等：崩溃恢复重推同一终态时 `items.some(i => i.id === id)` 直接返回。

### 2.3 API

- `GET /api/notifications` → `{ epoch, items, lastReadSeq, unread }`：**全量**返回（上限 200 条，单文件一次读，不做分页——分页 + 游标在 200 条的量级上只会引入「跳过 / 误标已读」的缝，Codex 评审已指出）；`items` 按 seq 倒序；`unread` 由服务端算（`seq > lastReadSeq` 的条数），客户端不自己数。
- `POST /api/notifications/read` body `{ epoch, upToSeq }` → `epoch` 不等于当前代际回 409 `notifications_stale`（客户端收到后重拉 GET，不重试 POST）；否则 `lastReadSeq = max(lastReadSeq, min(upToSeq, nextSeq-1))`，返回同 GET 形状。
- 两条都 `requireUser`，`withRequestContext`，非本人在路径层就不可能命中。

### 2.4 客户端

`src/lib/client/notifications.ts`：`fetchNotifications`, `markNotificationsRead`。

`ShellContext`：
- **同步函数 `syncNotifications()`**：拉 `GET /api/notifications`，整体替换本地 `notices`（映射成现有 `Notice[]`，title 由 status 派生）、`unread`、`epoch`；失败按 2s → 5s → 10s 退避重试三次后放弃（下一个触发点再来）。
- **触发点与 toast 边沿判断解耦**（Codex P1）：挂载时；SSE 每次 `open`（含重连——`useEvents` 增加 `onOpen` 回调）；`document.visibilitychange` 回到可见时；本地观察到「非终态 → 终态」那一跳之后。断线期间漏掉的终态由重连 / 回前台那次同步补齐，不再依赖看到边沿。
- SSE 到「非终态 → 终态」那一跳时仍即时插入本地 `Notice` + toast（现逻辑不变），随后的 `syncNotifications()` 用服务端结果整体覆盖（去重键 `id`，服务端有 `seq` 的以服务端为准）。SSE 只是提醒，落盘是真相。
- 铃铛打开：`markNoticesRead` 改为 `POST /api/notifications/read {epoch, upToSeq: 本地最大 seq}`——因为本地永远持有全量，「打开铃铛 = 全部已读」语义成立；成功后用返回值覆盖 `unread`；409 `notifications_stale` 则 `syncNotifications()` 后结束（不重试 POST）；其它失败只 toast。
- 通知条目点击行为不变（跳创作页 + 设为当前任务）；任务已不在本地 `jobs` 里时先 `fetchJob(jobId)` 再跳。

### 2.5 留存

不新增清理任务：200 条上限即留存策略；任务被 `DATA_RETENTION_DAYS` 清理后通知仍在，点开时 `fetchJob` 返回带 `artifactsPurgedAt` 的记录，创作页已有占位处理。

## 3. H2 错误码多语言

- `src/lib/i18n/messages/zh-CN/common.ts` 新增 `common.err.<code>`，覆盖服务端全部稳定码。清单**不靠手抄**（Codex 评审指出上面初稿漏了 `quota_exceeded` / `failure_limit_reached` / `billing_*` 等）：实施时用单测 `error-codes.test.ts` 静态扫描 `src/**/*.{ts,mjs}`（排除 `*.test.ts`）里三类出口——`new ProviderHttpError(<status>, "<code>"`、`quota.ts` 的 `code: "<code>"`、`billing/protocol.mjs` 的 `code` 常量——收集到的每个码都必须在 `zh-CN/common.ts` 有 `common.err.<code>` 键，缺一条测试红；新增错误码就必然带上文案。
- 另加 `common.err.unknown`（`{requestId}` 占位，服务端 `x-request-id` 已随响应头下发）与 `common.err.notifications_stale`。
- `src/lib/client/http.ts` `ApiError` 增加 `requestId?: string`（从响应头 `x-request-id` 读）。
- `src/lib/i18n/` 新增纯函数 `errorText(t, error: unknown): string`，规则只有三条：
  1. `ApiError` 且 `common.err.<code>` 存在 → 字典文案；其中 `invalid_argument` / `invalid_state` / `conflict` 这类**参数细节在 message 里**的码 → `字典文案：服务端 message`（英文界面下后半段仍是中文——明示是服务端细节，不装作翻译了）；
  2. `ApiError` 但字典没有该码（理论上只剩上游透传 / 新码漏测）→ `common.err.unknown` 带 `requestId`，**不再直接显示服务端 message**（与 §6 验收一致）；
  3. 非 `ApiError`（网络错、解析错）→ `common.err.unknown`，`requestId` 为空时省略括号。
- 替换点：`ShellContext.showToast(e.message)` 系、`CanvasView`、`AgentChat`、`SubscriptionView`、`PasswordDialog`、登录页——全仓 grep `instanceof Error ? e.message` 逐处换成 `errorText(t, e)`。canvas 已有的 `canvas.err.*`（执行位 errorCode）保留，不合并。
- 服务端不改：`message` 继续中文，日志与 CLI 依赖它。

## 4. H3 账户页

- 路由 `src/app/(shell)/account/page.tsx`，`ShellView` 增 `"account"`（`viewOfPath` 识别 `/account`，顶栏标题 `shell.nav.account`），**侧栏不加第六项**——入口是头像菜单里新增「账户」，与现有「修改密码」「退出」并列（修改密码保留在菜单里，账户页内也能打开同一个 `PasswordDialog`）。
- 组件 `src/components/genius/account/AccountView.tsx`，样式 `src/app/styles/account.css`（`globals.css` 顶部 `@import`），BEM `account-*`，卡片 `#131316` / 描边 `.07`，与订阅页「我的方案」同语言。
- 三张卡：
  1. **账号**：邮箱、注册时间（`GET /api/me` 增 `createdAt` 字段——服务端白名单挑字段，不下发 `sessionEpoch` / `passwordHash` 等）、当前语言（复用 `LanguageSwitch`）。
  2. **余额**：已购池 / 会员池 / 在途预留 / 可用（读壳里的 `me.balance`）、订阅摘要（档位 + 到期日，读 `me.subscription`），「查看流水」跳 `/subscription#ledger`——订阅页现有流水是按钮驱动的抽屉（`openDrawer`），**本包要补**：`SubscriptionView` 挂载时读 `window.location.hash === "#ledger"` 即 `openDrawer()` 并清掉 hash（`history.replaceState`），验收从账户页点过去确实看到流水；「充值 / 订阅」跳 `/subscription`。
  3. **安全**：「修改密码」打开 `PasswordDialog`；「退出全部设备」→ 新增 `POST /api/auth/logout-all`（`revokeUserSessions` 已存在，bump `sessionEpoch`），成功后客户端 `window.location.assign("/login")`（自己这台也失效，与改密一致）。二次确认用页内 disclosure（不引 `confirm()`）。
- e2e：`e2e/auth.spec.ts` 加一条——头像菜单 → 账户 → 三张卡可见 → 退出全部设备 → 回到登录页 → 旧 Cookie 再访 `/account` 被 307。

## 5. H4 移动端回归

- 新增 `e2e/mobile.spec.ts`，`test.use({ viewport })` 三档 375×667 / 390×844 / 768×1024，每档跑：登录 → 主页 → 打开创作面板并展开规格弹层 → 提交一条文生图 → `/create` 看到成片 → `/agent` 发一轮 → `/canvas` 右键建一个文生图节点、点「运行整图」看到报价弹层并能关闭 → `/subscription` 打开购买确认 → `/account` → 头像菜单退出。断言：`document.documentElement.scrollWidth <= clientWidth`；每个弹层 / 对话框有可见的关闭控件且 Esc 可关；主要按钮 `boundingBox` 完全在视口内。
- **软键盘遮挡属「尚未验证」**：Playwright 模拟不了软键盘，本包只保证布局不依赖 `100vh`（改 `100dvh`）这一静态条件，真机（iOS Safari / Android Chrome）验收在交接文档「已知限制」里明确标为未做，不由 CSS 检查判定通过。
- 回归里发现的样式问题**逐条修**，不做重设计；改动集中在 `globals.css` 的 `@media (max-width: 900px)` 与各视图 css 的对应段。已知嫌疑（未验证，回归时确认）：顶栏账户芯片 375 下是否挤掉铃铛；订阅页四档卡片是否横向溢出；画布右上「运行整图」与报价弹层在窄屏是否被裁。

## 6. 顺序与门禁

H2 → H1 → H3 → H4（H2 的 `errorText` 被 H1/H3 的新 UI 直接用；H4 最后一起回归）。每刀各自过 `tsc` / `eslint` / `test`；H1/H3/H4 改 UI 各跑一次 `pnpm e2e`。四刀合一次部署。

单测：`notifications/store.test.ts`（append 幂等、200 条截断、坏文件重建换 epoch、旧 epoch 的 read 请求 409、read 游标不回退、跨用户路径隔离）、`error-codes.test.ts`（源码扫描出的每个码都有字典键）、`errorText.test.ts`（字典命中 / 参数码拼接 / 未知码 requestId / 非 ApiError）、`updateJob` 终态边沿只 append 一次（复用 `store.test.ts` 的 fixture）。

## 6.1 Codex 评审（2026-09-12，VERDICT: BLOCK → 已按下表修订）

| Finding | 判定 | 处置 |
| --- | --- | --- |
| P1 通知同步绑在终态边沿上，断线期间漏的通知到刷新才补 | 成立 | §2.4 改为独立的 `syncNotifications()`，在 SSE open/重连、页面回前台、挂载四处触发 |
| P1 倒序分页 + 最大序号游标会跳过 / 误标已读 | 成立 | §2.3 改为全量同步（≤200 条），去掉 `after/limit`；`unread` 服务端算 |
| P1 坏文件重建后序号回退，旧客户端游标失效 | 成立 | §2.1 加 `epoch`；read 带 `epoch`，不匹配 409 `notifications_stale` |
| P1 错误码清单手抄遗漏（`quota_exceeded` 等），未知码兜底自相矛盾 | 成立 | §3 改为源码扫描单测保证覆盖；未知码一律本地化兜底 + requestId |
| P2 `/subscription#ledger` 现无 hash 驱动 | 成立 | §4 把 hash → `openDrawer()` 纳入实施范围 |
| P2 移动端路径漏画布；软键盘不能靠 CSS 判过 | 成立 | §5 补画布步骤；软键盘明确标「未验证」 |

## 7. 待确认项

1. 通知是否也要覆盖画布 run 终态与智能体轮次失败？本方案不覆盖（二期并入同一索引，`kind` 字段已预留）。
2. 「退出全部设备」是否需要输入当前密码？本方案不需要（会话本身就是凭证；改密已有密码校验）。
3. `/account` 是否要进侧栏？本方案不进（保持五视图，入口在头像菜单）。
