# 方案：智能体 · 多语言 · 订阅定价（2026-09-06 深夜）

| 字段 | 值 |
| --- | --- |
| 状态 | 已实施并部署生产，as-built 见 `docs/design.md` §2h（智能体）/§2i（订阅）/§13（多语言）；本文正文为历史方案，不再维护。2026-09-13 起产品方向为多中转按能力路由，Grok 为普通可选成员；本文 Grok 主视角部分为历史决策，现状以 `docs/design.md` 为准 |
| 基线 | `main` @ `444def9` |
| 用户原话 | 1. 完成智能体功能模块开发；2. 完成多语言功能模块开发；3. 订阅页价格数字按实际价格，加上毛利率 15% 作为订阅价格，完成此页面开发；4. 三步全部完成并通过测试后上线 |

## 0. 三条已定的取舍（用户不在线，主代理拍板，报告时逐条带出）

| 项 | 取舍 | 理由 |
| --- | --- | --- |
| 「实际价格」的口径 | **上游成本**（我们付给 provider 的钱，人民币），不是面向用户的售价表 | 「毛利率」是成本口径的词；售价表本身已含 60–80% 毛利，再加 15% 说不通 |
| 「加上毛利率 15%」的算法 | `price = cost / (1 − 0.15)`（毛利率 = 毛利 ÷ 售价） | 财务定义；与 `cost × 1.15` 相差 2.3%，常量 `GROSS_MARGIN` 一处可改 |
| 订阅积分必须是**独立池**（会员积分池，期末清零） | 订阅只能用「已购余额」购买；订阅送的积分进会员池，扣款先扣会员池再扣已购 | 若送进同一池，「用低于面值的钱买到面值积分」会形成无限套利（买→得→再买），这是硬约束 |

## 1. 智能体（`src/lib/agent/`、`src/app/api/agent/`、`src/components/genius/agent/`）

产品面：用户在智能体首页输入想法（可选一个技能、图片/视频产品），进入会话；每一轮智能体用 LLM 回复并**按需真的创建生成任务**（文生图 / 文生视频，走现有 `/api/jobs` 同一条服务层），会话右侧「资产」栏列出本会话产生的全部作品并跟进状态。历史记录抽屉列出真实会话。

实现面：

- LLM 客户端 `src/lib/agent/llm.ts`（**as-built，与本节起草时的设想不同**）：OpenAI 兼容 `chat.completions`，提供方按顺序取第一个可用的：mock 模式（`isMockMode()`）→ `AGENT_API_KEY`+`AGENT_BASE_URL`（默认 `api.openai.com/v1`，模型 `AGENT_CHAT_MODEL` 默认 `gpt-4o-mini`）→ `XAI_API_KEY`（`grok-4.6`）→ 都没有则 503 `agent_unavailable`，绝不静默落 mock。生产已配的两家中转（ccgoai / YMan）实测无对话模型，必须单独配 `AGENT_API_KEY` 才能真用。JSON 输出，zod 校验，最多重试 2 次。
- 一轮 = 一次任务定价：`priceTable().agent.turn`（默认 ¥0.05），提交前 `assertBalance`，扣款走 `applyBalanceChange`（`kind:"charge"`，`ref:"agent:<turnId>"` 幂等）。任务的钱照常由 `/api/jobs` 那条准入扣。
- 输出契约 `{ reply: string, actions: Array<{ type: "image" | "video", prompt: string, aspectRatio?: string, durationSec?: number, product?: string }> }`，每轮最多 2 个 action；每个 action 用 `createJob`（与 `POST /api/jobs` 同一服务函数）创建任务，幂等 key `agent:<turnId>:<i>`，任务失败（余额不足 / 校验 400）写进消息里而不是让整轮失败。
- 技能 `src/lib/agent/skills.ts`：把原型的 20 个技能名变成真实定义（id、中英文名与描述、system prompt 片段——写 prompt 时先读 `.claude/skills/video-prompt/SKILL.md`）。
- 会话存储 `data/agent/<userId>/<sessionId>.json`（`ownerId` 校验，非本人 404）；列表按 `updatedAt` 倒序，单用户上限 200。
- API：`GET/POST /api/agent/sessions`，`GET/PATCH/DELETE /api/agent/sessions/:id`，`POST /api/agent/sessions/:id/messages`，`GET /api/agent/skills`。限流：消息 20 次/分钟/用户。
- 前端：`AgentView` 三屏保留（首页 / 技能广场 / 会话），数据全部改真；文本模型下拉只留三档「自动 · 极速 / 均衡 / 精创」（映射 temperature / max_tokens），图片 / 视频模型下拉列真实产品（`GET /api/models`）+「自动」；假模型名删除。

## 2. 多语言（`src/lib/i18n/`、`src/components/genius/i18n/`）

- 已由主代理打好地基：`locales.ts`（`zh-CN` / `en`，Cookie `lumen_locale`，`Accept-Language` 兜底）、`format.ts`（`{name}` 占位）、`messages/<locale>/<namespace>.ts`（每视图一个命名空间，`zh-CN` 是键的事实源，`en` 类型由它推导，漏键即编译错误）、`I18nProvider` + `useT()`（根布局已挂）。
- coder-i18n：把壳（侧栏 / 顶栏 / 视图标题）、主页、创作面板、创作页、画布、登录页、分享页全部文案改成 `t("ns.key")`；顶栏加语言切换（disclosure，列 `LOCALE_LABELS`）；登录页也可切换。智能体与订阅两个视图由各自 coder 直接用 `useT()` 写，命名空间 `agent` / `subscription` 归他们。
- 服务端 API 的错误文案不翻译（前端已按错误码映射的继续映射；直接透传服务端中文的保持原样，记入已知未做）。

## 3. 订阅（`src/lib/billing/plans.ts`、`src/app/api/subscription/`、`src/components/genius/subscription/`）

### 3.1 定价

- 四档：标准 1200 / 专业 6000 / 尊享 15000 / 至尊 25000 积分每 30 天；所有档每日赠 60 积分（原型功能行）。
- **成本基准** `costRatio`：`（默认视频产品 5 秒默认档的上游成本 ÷ 其售价 + 默认图片产品 1K 的上游成本 ÷ 其售价）÷ 2`。「默认产品」= 产品目录里、provider 在 `VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER` 首位的那个（与路由的第一落点一致，随部署环境变，不随 key 耗尽抖动）。上游成本用 `src/lib/cost.ts` 的现成表（可灵 `KLING_UNITS_PER_SEC × KLING_USD_PER_UNIT × USD_CNY_RATE`，YMan 积分 ÷ 100，grok `RATE_USD_PER_SEC × 汇率`，openai/yman 生图价目表——注意中转站价目表单位已是人民币）。任何一项算不出时回落常量 `FALLBACK_COST_RATIO = 0.5` 并记 warn。
- `月费 = ceil1( (月积分 + 30 × 日积分) / 100 × costRatio / (1 − 0.15) )`（向上取到 0.1 元）；`年费 = 12 × 月费`，不打折（毛利率固定就没有打折空间；原型的「立减 40%」徽标删除）。
- `GET /api/subscription` 同时返回 `basis: { costRatio, grossMargin }` 供页面脚注解释「价格怎么来的」。

### 3.2 会员积分池

- `user.json` 新增 `memberCreditsCny`（默认 0）与 `subscription?: { id, planId, cycle, startedAt, expiresAt, periodIndex, periodStartedAt, lastDailyGrantOn? }`。
- `assertBalance`：`available = balanceCny + memberCreditsCny − reserved`。
- `applyBalanceChangeLocked` 扣款（`charge`，负 delta）：先扣会员池、不足部分扣已购池，流水行记 `memberCny`；入账（`grant`）按 `pool` 参数选池（默认已购池；订阅入账 `pool:"member"`）。幂等键统一用 `ref`。
- 购买 `POST /api/subscription { planId, cycle }`：用户锁内——有未到期订阅 409 `subscription_active`；`balanceCny`（只看已购池）< 价格 402 `insufficient_balance`；扣款 `ref:"sub:<id>"`；写 `subscription`；会员池置为本期积分（`grant` `pool:"member"` `ref:"sub:<id>:p0"`）。
- 惰性结算 `settleSubscription(userId)`（`GET /api/me`、`GET /api/subscription` 前调用，用户锁内）：到期 → 清订阅、会员池清零（`adjust` 负行）；跨 30 天期 → 会员池**重置**为本期积分（未用完清零，`adjust` + `grant` `ref:"sub:<id>:p<n>"`）；当天（Asia/Shanghai）未发过日积分 → 会员池 +0.6 元（`ref:"sub:<id>:d<YYYY-MM-DD>"`）。
- 已购池的进出口不变（礼品码 / 管理员 CLI / 任务扣款），`scripts/lib/users-store.mjs` 与 `grant-balance.mjs` 不得因新增字段丢字段。

### 3.3 页面

- 「我的方案」：当前档位（无订阅显示「未订阅」）、到期日、会员积分 / 今日已发日积分 / 已购余额三读数、兑换礼品码、流水抽屉（沿用）。
- 四档卡片：真实价格 ¥、月 / 年切换（年显示年总额 + 折合每月）、功能行只写真的（每 30 天 N 积分、每日赠 60、会员积分先扣、全产品可用）、按钮「订阅」→ 确认弹窗（价格、扣自已购余额）→ 成功 toast + `refreshMe`；已购余额不足 → 提示「余额不足，请先兑换礼品码」。脚注：定价 = 上游成本 ÷ 0.85。
- 无支付网关：订阅从已购余额扣，已购余额只能靠礼品码 / 管理员充值——记入已知限制。

## 4. 派工与文件归属

| coder | 独占文件 |
| --- | --- |
| coder-agent | `src/lib/agent/**`、`src/app/api/agent/**`、`src/components/genius/agent/**`、`src/app/styles/agent.css`、`src/lib/client/agent.ts`、`src/lib/i18n/messages/*/agent.ts`、`src/lib/env.ts`、`src/lib/billing/prices.ts`、`.env.example`、`e2e/agent.spec.ts` |
| coder-sub | `src/lib/billing/{plans,admission,ledger}.ts` 及测试、`src/lib/users/{schema,store}.ts`、`src/app/api/me/route.ts`、`src/app/api/subscription/**`、`src/lib/client/auth.ts`、`src/lib/client/subscription.ts`、`src/components/genius/subscription/**`、`src/app/styles/subscription.css`、`src/lib/i18n/messages/*/subscription.ts`、`scripts/lib/users-store.mjs`、`e2e/subscription.spec.ts` |
| coder-i18n | `src/components/genius/{GeniusShell,ShellContext,Sidebar,TopBar,views,LoginScreen}.tsx`、`src/components/genius/{home,composer,create,canvas}/**`、`src/app/s/**`、`src/app/globals.css`、`src/app/styles/canvas.css`、`src/lib/i18n/messages/*/{shell,home,composer,create,canvas,login,share,common}.ts`、`e2e/i18n.spec.ts`、`e2e/genius.spec.ts`（仅在选择器因文案改动而需要时） |

主代理收尾：门禁、Codex findings 判定、doc-writer、部署。
