import path from "node:path";

export const OFFICIAL_XAI_BASE = "https://api.x.ai/v1";
export const DEFAULT_SUB2API_BASE = "http://127.0.0.1:8080/v1";
export const OFFICIAL_OPENAI_BASE = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
/** 可灵新系统域名。路径不带 `/v1`，所以这里也不补。 */
export const OFFICIAL_KLING_BASE = "https://api-beijing.klingai.com";
export const DEFAULT_KLING_VIDEO_MODEL = "kling-2.6";
const DEFAULT_KLING_USD_PER_UNIT = 0.1;
/** YMan（中转渠道）的 OpenAI 兼容 REST root，**带** `/v1`（路径是 `/videos`、`/models`）。 */
export const OFFICIAL_YMAN_BASE = "https://vip.yman.cc/v1";
/**
 * 默认模型名用 `GET /v1/models` 的**展示名**——上游文档明确要求 `model` 用这一串，
 * 后台内部名（`minimax_h3_t2v` / `minimax_h3_ref2v`）只作为别名被认出来，见
 * `@/lib/providers/yman/catalog`。
 */
export const DEFAULT_YMAN_T2V_MODEL = "minimax-h3";
export const DEFAULT_YMAN_I2V_MODEL = "minimax-h3-933-图文";
/** YMan 也兼容 OpenAI Images API；生图默认走它的 gpt-image-2。 */
export const DEFAULT_YMAN_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_YMAN_UNKNOWN_CREDITS = 150;
const DEFAULT_USD_CNY_RATE = 7.2;
const DEFAULT_PROVIDER_EXHAUSTED_TTL_MS = 6 * 60 * 60_000;
/** 分享链接默认 24 小时到期（方案 §1.4）。 */
const DEFAULT_SHARE_TTL_HOURS = 24;

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
}

/**
 * The single administrator, bound to a user id rather than an email (plan §4:
 * an email can be squatted). Unset means nobody is an administrator, and the
 * ownerless jobs from before the user system are then visible to no one.
 */
export function adminUserId(): string | undefined {
  return process.env.LUMEN_ADMIN_USER_ID?.trim() || undefined;
}

/**
 * 免费档每人每天能出的图数（plan §6.1）。口径是「今日成功 + 当前在途 < 上限」，
 * 失败 / 取消 / 过期不占额度，只对文生图计数。0 表示暂停所有人的生图提交。
 *
 * 自 2026-09-06 的余额模型（方案 §3.2）起它不再是主闸门——主闸门是
 * `@/lib/billing/admission` 的「余额 − 在途预留 ≥ 本次售价」——所以默认值从 10 抬到
 * 200，只当防滥用兜底：正常付费用户碰不到，脚本刷图仍会被挡住。
 */
export function freeDailyImageQuota(): number {
  return intFromEnv(process.env.FREE_DAILY_IMAGE_QUOTA, 200, 0);
}

/**
 * 止损阀（plan §6.1）：今日失败 + 取消达到它就拒绝该账号的新提交。
 * 与配额相互独立——它挡的是「反复提交再失败」消耗上游余额，不是正常用量。
 */
export function freeDailyFailureLimit(): number {
  return intFromEnv(process.env.FREE_DAILY_FAILURE_LIMIT, 30, 1);
}

/**
 * 产物留存天数（plan §8）。终态任务的 `completedAt ?? updatedAt` 早于它，
 * 就删掉该任务的 `inputs/` 与 `outputs/` 并写 `artifactsPurgedAt`；`status` 不动。
 * 0 = 关闭清理（永久保留）。负数与非法值按非法处理，回落默认 30。
 */
export function dataRetentionDays(): number {
  return intFromEnv(process.env.DATA_RETENTION_DAYS, 30, 0);
}

/**
 * 分享链接的有效期（小时，默认 24）。令牌本身就是权限，没有服务端的吊销表，所以
 * 到期是唯一的收回手段——不接受 0 / 负数 / 非法值（那等于签一条永久链接），一律
 * 回落默认；上限一年，免得一个手滑的大数变成事实上的永久有效。
 */
export function shareTtlHours(): number {
  const raw = Number(process.env.SHARE_TTL_HOURS ?? DEFAULT_SHARE_TTL_HOURS);
  if (!Number.isFinite(raw)) return DEFAULT_SHARE_TTL_HOURS;
  const hours = Math.floor(raw);
  return hours >= 1 ? Math.min(hours, 24 * 365) : DEFAULT_SHARE_TTL_HOURS;
}

/** 空串与非法值一律回落默认，避免 `Number("")===0` 把额度悄悄清零。 */
function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function jobConcurrency(): number {
  const n = Number(process.env.JOB_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

export function maxQueuedJobs(): number {
  const n = Number(process.env.MAX_QUEUED_JOBS ?? 20);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

/**
 * 单个账号能同时在途的任务数（方案 §3.2「安全收口」），默认 5。
 *
 * 全站的 `MAX_QUEUED_JOBS` 挡的是「实例被压垮」，挡不住「一个人把 20 个槽全占了」——
 * 那既是对其他用户的拒绝服务，也是脚本刷单最省事的形态。余额是钱这一侧的闸门，
 * 这条是并发那一侧的：钱够也不能一口气排 50 条。
 */
export function maxQueuedJobsPerUser(): number {
  const n = Number(process.env.MAX_QUEUED_JOBS_PER_USER ?? 5);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

/**
 * 运维告警的 webhook（方案 §3.2「可观测性」）。不设 = 不外发，只留日志。
 *
 * 必须是 http(s) 的绝对地址：认不出的值当没配，而不是让 `fetch` 在每次告警时抛。
 */
export function alertWebhookUrl(): string | undefined {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** 告警外发的单次超时（毫秒），默认 5 秒、上限 30 秒。挂住的 webhook 不能拖住任务。 */
export function alertWebhookTimeoutMs(): number {
  const n = Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS ?? 5_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 30_000) : 5_000;
}

/**
 * 磁盘剩余低于这个百分比就算不健康（方案 §3.2）。
 *
 * 常量而不是环境变量：它是「还能不能写下一个成片」的下限，不是每个实例各有一套的
 * 偏好。`/api/health` 的 `ok` 纳入它，并在跨过阈值时发一条告警——`DATA_DIR` 写不下
 * 东西时任务会在 persist 那一步失败，而那时钱已经花出去了。
 */
export const DISK_FREE_PCT_FLOOR = 5;

export function grokApiKey(): string | undefined {
  const official = process.env.XAI_API_KEY?.trim();
  if (official) return official;
  const proxy = process.env.SUB2API_API_KEY?.trim();
  if (proxy) return proxy;
  return undefined;
}

export function hasXaiKey(): boolean {
  return Boolean(grokApiKey());
}

export function forceMock(): boolean {
  const v = process.env.LUMEN_FORCE_MOCK?.trim();
  return v === "1" || v === "true";
}

/** OpenAI 官方生图用的 key。只影响 text_to_image，视频路径永不读它。 */
export function openaiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function hasOpenaiKey(): boolean {
  return Boolean(openaiApiKey());
}

/** OpenAI REST root including `/v1`, no trailing slash. */
export function openaiBase(): string {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  if (!raw) return OFFICIAL_OPENAI_BASE;
  return normalizeApiBase(raw, OFFICIAL_OPENAI_BASE);
}

export function openaiImageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;
}

export type OpenaiImageQuality = "low" | "medium" | "high" | "auto";
const OPENAI_IMAGE_QUALITIES: readonly string[] = ["low", "medium", "high", "auto"];
export const DEFAULT_OPENAI_IMAGE_QUALITY: OpenaiImageQuality = "high";

/**
 * 上游是否接受任意尺寸。官方 gpt-image-1 只有 1024x1024 / 1536x1024 / 1024x1536 三档，
 * 兼容 OpenAI Images API 的中转（如 ccgoai）则接受任意 16 的倍数尺寸。
 * 置 1 / true 时七个画幅全部按原生尺寸出图、不再本地裁切；未设置时保持官方三档 + 居中裁切。
 */
export function openaiImageFlexibleSizes(): boolean {
  const v = process.env.OPENAI_IMAGE_FLEXIBLE_SIZES?.trim();
  return v === "1" || v === "true";
}

/**
 * 生图画质档。请求里不显式带 quality 时上游按 medium 计费，所以每次都必须显式传；
 * 默认 high（额度在上游侧限制，本地只管出好图），非法值回落 high。
 * 只在 `OPENAI_IMAGE_FLEXIBLE_SIZES` 打开时生效——官方路径仍按 1k→low / 2k→high 的既有语义。
 */
export function openaiImageQuality(): OpenaiImageQuality {
  const raw = process.env.OPENAI_IMAGE_QUALITY?.trim().toLowerCase();
  if (!raw) return DEFAULT_OPENAI_IMAGE_QUALITY;
  return OPENAI_IMAGE_QUALITIES.includes(raw)
    ? (raw as OpenaiImageQuality)
    : DEFAULT_OPENAI_IMAGE_QUALITY;
}

/**
 * 是否启用图生图（`/images/edits`，multipart 带 `image[]` 参考图）。默认关：ccgoai 是否
 * 透传这条接口**未验证**，验证通过前打开等于让带参考图的请求直接撞上 404。
 */
export function openaiImageEditsEnabled(): boolean {
  const v = process.env.OPENAI_IMAGE_EDITS_ENABLED?.trim();
  return v === "1" || v === "true";
}

/** 同上，YMan 生图通道的 `YMAN_IMAGE_EDITS_ENABLED`。 */
export function ymanImageEditsEnabled(): boolean {
  const v = process.env.YMAN_IMAGE_EDITS_ENABLED?.trim();
  return v === "1" || v === "true";
}

/**
 * 图片档位价目表的 JSON 原文（quality × 尺寸档）。价目是上游特定的，仓库不预设；
 * 解析、校验与损坏时的回落都在 `@/lib/cost`，这里只负责把原文取出来。
 */
export function openaiImagePriceTableRaw(): string | undefined {
  return process.env.OPENAI_IMAGE_PRICE_TABLE?.trim() || undefined;
}

/**
 * 用户售价表的 JSON 原文（方案 §3.2）。与上面那张成本表无关：这张是我们向用户
 * 收的人民币定价。解析、部分覆盖与坏 JSON 的回落都在 `@/lib/billing/prices`。
 */
export function priceTableRaw(): string | undefined {
  return process.env.LUMEN_PRICE_TABLE?.trim() || undefined;
}

/**
 * 产品目录的覆盖 / 追加 JSON 原文（`src/lib/products/catalog.ts`）。
 *
 * 产品是「对用户露出的模型」——名字、能力、默认档，供应商名不露出。默认表写在代码里，
 * 但换模型、加档位、调默认分辨率都不该等一次发版，所以留这条口子。解析、按 id 合并与
 * 坏 JSON 的回落都在 catalog 里，这里只取原文。
 */
export function lumenProductsRaw(): string | undefined {
  return process.env.LUMEN_PRODUCTS?.trim() || undefined;
}

/**
 * `LUMEN_RELAYS`：中转 provider 配置的 JSON 数组原文（方案 `plan-relay-provider` §2）。
 * 只在 `data/relays.json` 不存在时作首次种子；文件一旦存在就以文件为准。
 * 解析与合并都在 `providers/relay/config.ts`，这里只取原文。
 */
export function lumenRelaysRaw(): string | undefined {
  return process.env.LUMEN_RELAYS?.trim() || undefined;
}

/**
 * gpt-image-1 常要 30–120 秒才返回，远超通用的 `UPSTREAM_TIMEOUT_MS`（默认 30s）。
 * 用通用超时会在图片已经生成、正要返回时 abort，而这一次调用照样计费。
 */
export function openaiImageTimeoutMs(): number {
  const n = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? 180_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10 * 60_000) : 180_000;
}

/**
 * 异步出图任务的**总**时长上限（毫秒），默认 10 分钟。
 *
 * 与 `OPENAI_IMAGE_TIMEOUT_MS` 是两回事：那条管**单次 HTTP 请求**，这条管
 * 「202 受理 → 轮询 `/images/tasks/{id}` → 取回 result」整条链。中转站（ccgoai）在出图慢时
 * 直接回 202，实测 high 档 2K 一张约 102 秒、4K 更久，所以总上限必须远宽于单请求超时。
 * 超时只是本地放弃等待：任务在上游仍然活着，也仍然只在取回 result 时才计费。
 */
export function openaiImageTaskTimeoutMs(): number {
  const n = Number(process.env.OPENAI_IMAGE_TASK_TIMEOUT_MS ?? 600_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 60 * 60_000) : 600_000;
}

/** 可灵开放平台新系统的单串 API Key。缺失时可灵完全不参与路由。 */
export function klingApiKey(): string | undefined {
  return process.env.KLING_API_KEY?.trim() || undefined;
}

export function hasKlingKey(): boolean {
  return Boolean(klingApiKey());
}

/**
 * 可灵 REST root，**不带** `/v1`：接口路径本身就是 `/text-to-video/<model>`、`/tasks`，
 * 补 `/v1` 会 404。只去掉尾部斜杠，其余原样。
 */
export function klingBase(): string {
  const raw = process.env.KLING_BASE_URL?.trim().replace(/\/+$/, "");
  return raw || OFFICIAL_KLING_BASE;
}

/**
 * 没有任何显式配置时的优先级：只有 xAI。
 *
 * 换供应商是一次显式选择，不是「配了 key 就自动生效」的副作用——把可灵放进默认次序，
 * 一个为了别的用途（对账、试跑一次）配上的 `KLING_API_KEY` 就会静默改变全站视频的落点、
 * 时长档位与成片质感，而运维那边什么都没改。要走可灵，写 `VIDEO_PROVIDER_ORDER`
 * （或旧的 `VIDEO_PROVIDER=kling`）说出来。
 */
const DEFAULT_VIDEO_PROVIDER_ORDER: readonly string[] = ["grok"];

/**
 * `*_PROVIDER_ORDER` 的原始解析：小写、去空、去重，**不做合法性校验**——合法值由
 * `providers/registry.ts` 的运行时注册表决定（env 不能 import 注册表，会绕成
 * 「provider 实现 → env → 注册表 → provider 实现」的循环）。env 只负责把字符串
 * 解析出来；认不出的 id 由 `providers/router.ts` 的 `effective*ProviderOrder`
 * 过滤并 warn。没设或解析后为空时返回 null，回落由调用方决定。
 */
function parseProviderOrder(raw: string | undefined): string[] | null {
  const value = raw?.trim();
  if (!value) return null;
  const deduped = [...new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return deduped.length ? deduped : null;
}

export function videoProviderOrderRaw(): string[] | null {
  return parseProviderOrder(process.env.VIDEO_PROVIDER_ORDER);
}

export function imageProviderOrderRaw(): string[] | null {
  return parseProviderOrder(process.env.IMAGE_PROVIDER_ORDER);
}

/**
 * 没有显式 `VIDEO_PROVIDER_ORDER` 时的次序：兼容旧的单一开关 `VIDEO_PROVIDER`——
 * `=kling` 视为 `kling,grok`，`=grok`（以及任何非法值）视为只有 `grok`——旧配置的
 * 语义就是「除非点名，否则别让可灵抢路由」，默认次序（`grok`）现在与它同一个语义。
 */
export function videoProviderOrderCompat(): string[] {
  const legacy = process.env.VIDEO_PROVIDER?.trim().toLowerCase();
  if (!legacy) return [...DEFAULT_VIDEO_PROVIDER_ORDER];
  return legacy === "kling" ? ["kling", "grok"] : ["grok"];
}

/**
 * 视频路由的优先级列表（方案 §3.4「功能先于供应商」）：显式 ORDER 优先，否则走
 * `videoProviderOrderCompat` 的兼容回落。**返回值可能含未注册的 id**——按注册表
 * 过滤是 `providers/router.ts` 的职责，别直接消费这个函数。
 */
export function videoProviderOrder(): string[] {
  return videoProviderOrderRaw() ?? videoProviderOrderCompat();
}

/** 文生图 ORDER 没显式配置时的默认：`openai,grok`，加 YMan 之前那条硬编码阶梯。 */
const DEFAULT_IMAGE_PROVIDER_ORDER: readonly string[] = ["openai", "grok"];

/** `IMAGE_PROVIDER_ORDER` 未设时的回落（文生图没有旧的单值开关要兼容）。 */
export function imageProviderOrderCompat(): string[] {
  return [...DEFAULT_IMAGE_PROVIDER_ORDER];
}

/**
 * 文生图的优先级列表，默认 `openai,grok`——正是加 YMan 之前那条硬编码的阶梯
 * （有 OPENAI_API_KEY 走 openai，否则 xAI，都没有才 mock），所以旧实例不改配置行为不变。
 *
 * 与 `videoProviderOrder` 同一套规则：只解析、不校验，未注册 id 由 router 过滤。
 */
export function imageProviderOrder(): string[] {
  return imageProviderOrderRaw() ?? imageProviderOrderCompat();
}

/**
 * 一家上游被判定「积分耗尽」后要绕开多久（毫秒），默认 6 小时。
 *
 * 有 TTL 而不是永久拉黑：充值是常事，而我们没有任何主动的「余额恢复了」信号，
 * 到点自动放回去重试一次，比让运维记得手工清状态文件靠谱。0 或非法值回落默认。
 */
export function providerExhaustedTtlMs(): number {
  const n = Number(process.env.PROVIDER_EXHAUSTED_TTL_MS ?? DEFAULT_PROVIDER_EXHAUSTED_TTL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PROVIDER_EXHAUSTED_TTL_MS;
}

/** 可灵视频模型，同时是 URL 路径段（`/text-to-video/kling-2.6`）。 */
export function klingVideoModel(): string {
  return process.env.KLING_VIDEO_MODEL?.trim() || DEFAULT_KLING_VIDEO_MODEL;
}

/** 覆盖 UI 固定发的 720p。有声时会被 rest-map 强制抬到 1080p（上游硬约束）。 */
export function klingVideoResolution(): "720p" | "1080p" {
  return process.env.KLING_VIDEO_RESOLUTION?.trim() === "1080p" ? "1080p" : "720p";
}

/** 有声只在 1080p 出片，且单价 1.0 积分/秒（无声 720p 的 3.3 倍），所以默认关。 */
export function klingVideoAudio(): "off" | "native" {
  return process.env.KLING_VIDEO_AUDIO?.trim().toLowerCase() === "native" ? "native" : "off";
}

/**
 * 积分 → USD 的换算率，只影响账目显示。默认 0.10（$10 = 100 积分的充值比例）。
 * 非法值与负数回落默认，免得把真实扣费记成 0。
 */
export function klingUsdPerUnit(): number {
  const n = Number(process.env.KLING_USD_PER_UNIT ?? DEFAULT_KLING_USD_PER_UNIT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KLING_USD_PER_UNIT;
}

/** 单个可灵任务从提交到出片的总时长上限（毫秒），与 runner 的 15 分钟轮询上限同口径。 */
export function klingTaskTimeoutMs(): number {
  const n = Number(process.env.KLING_TASK_TIMEOUT_MS ?? 900_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 60 * 60_000) : 900_000;
}

/** YMan 中转渠道的 key。缺失时 yman 不参与路由（即便它出现在 VIDEO_PROVIDER_ORDER 里）。 */
export function ymanApiKey(): string | undefined {
  return process.env.YMAN_API_KEY?.trim() || undefined;
}

export function hasYmanKey(): boolean {
  return Boolean(ymanApiKey());
}

/** OpenAI 兼容，路径是 `/videos`，所以 base **带** `/v1`；缺 `/v1` 时补上。 */
export function ymanBase(): string {
  const raw = process.env.YMAN_BASE_URL?.trim();
  if (!raw) return OFFICIAL_YMAN_BASE;
  return normalizeApiBase(raw, OFFICIAL_YMAN_BASE);
}

/** 文生视频的上游模型名。默认 `minimax-h3`（纯文生，不收参考图）。 */
export function ymanT2vModel(): string {
  return process.env.YMAN_T2V_MODEL?.trim() || DEFAULT_YMAN_T2V_MODEL;
}

/** 图生 / 参考生视频的上游模型名。默认 minimax_h3_ref2v（同价档但收参考图）。 */
export function ymanI2vModel(): string {
  return process.env.YMAN_I2V_MODEL?.trim() || DEFAULT_YMAN_I2V_MODEL;
}

/** YMan 生图用的模型名（它兼容 OpenAI Images API）。默认 gpt-image-2。 */
export function ymanImageModel(): string {
  return process.env.YMAN_IMAGE_MODEL?.trim() || DEFAULT_YMAN_IMAGE_MODEL;
}

/**
 * YMan 生图的档位价目表 JSON 原文，与 `OPENAI_IMAGE_PRICE_TABLE` 同款语义（quality × 尺寸档）。
 * 单位是**人民币额度**（上游按人民币扣），解析与坏 JSON 的回落都在 `@/lib/cost`。
 */
export function ymanImagePriceTableRaw(): string | undefined {
  return process.env.YMAN_IMAGE_PRICE_TABLE?.trim() || undefined;
}

/**
 * 覆盖 / 追加模型能力与价目的 JSON 原文。上游随时会上新模型，仓库里的静态表跟不上，
 * 所以留一条不改代码就能加模型的路。解析与坏 JSON 的回落在
 * `@/lib/providers/yman/catalog`，这里只取原文。
 */
export function ymanModelCatalogRaw(): string | undefined {
  return process.env.YMAN_MODEL_CATALOG?.trim() || undefined;
}

/**
 * 目录里没有的模型（用户自己填的模型名）按多少积分估价。绝不为 0——`costUsdEstimate === 0`
 * 会让账目完全看不见这次调用；宁可高估。默认 150 积分（¥1.5），比表里最贵的一档低，
 * 但足够让一次未知调用在账上留下痕迹。
 */
export function ymanUnknownCredits(): number {
  const n = Number(process.env.YMAN_UNKNOWN_CREDITS ?? DEFAULT_YMAN_UNKNOWN_CREDITS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_YMAN_UNKNOWN_CREDITS;
}

/**
 * 单个 YMan 任务从提交到出片的本地等待上限（毫秒），默认 15 分钟，上限 60 分钟。
 *
 * 与 `KLING_TASK_TIMEOUT_MS` 同一个用途（方案 §2 G6）：中转渠道排队时长不可控，超时只是
 * 本地放弃等待——上游任务仍然活着、仍然已经计费，所以这条要留给运维按实测调，而不是让
 * runner 拿一个写死的 15 分钟把慢任务判成失败。
 */
export function ymanTaskTimeoutMs(): number {
  const n = Number(process.env.YMAN_TASK_TIMEOUT_MS ?? 900_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 60 * 60_000) : 900_000;
}

/**
 * 人民币 → 美元的换算率（1 USD = 多少 CNY），只影响账目显示：YMan 按积分（¥1 = 100 积分）
 * 计费，而 `costUsdEstimate` / `costUsdActual` 的口径是美元。非法值与 0 回落默认 7.2
 * （0 会把换算变成除零 → Infinity，比估错更糟）。
 */
export function usdCnyRate(): number {
  const n = Number(process.env.USD_CNY_RATE ?? DEFAULT_USD_CNY_RATE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_CNY_RATE;
}

/**
 * Mock 模式 = 没有任何可用的上游 key。文生图可以只靠 OpenAI key、视频可以只靠可灵 /
 * YMan key 跑真实上游，所以任意一把 key 都足以让实例脱离 mock（其余路径仍各自按 key
 * 回落到 mock）。
 */
export function isMockMode(): boolean {
  return forceMock() || (!hasXaiKey() && !hasOpenaiKey() && !hasKlingKey() && !hasYmanKey());
}

export type GrokUpstreamKind = "xai" | "sub2api";

export function grokUpstreamKind(): GrokUpstreamKind {
  if (xaiBase().includes("api.x.ai")) return "xai";
  return "sub2api";
}

/** REST root including `/v1`, no trailing slash. */
export function xaiBase(): string {
  const raw = process.env.XAI_BASE_URL?.trim();
  if (raw) return normalizeXaiBase(raw);
  if (process.env.SUB2API_API_KEY?.trim() && !process.env.XAI_API_KEY?.trim()) {
    return DEFAULT_SUB2API_BASE;
  }
  return OFFICIAL_XAI_BASE;
}

export function normalizeXaiBase(input: string): string {
  return normalizeApiBase(input, OFFICIAL_XAI_BASE);
}

function normalizeApiBase(input: string, fallback: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) return fallback;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}

export function upstreamTimeoutMs(): number {
  const n = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 5 * 60_000) : 30_000;
}

/**
 * Harness 的 LLM 调用（Director 规划 / 视觉 QC）独立超时：Director 要一次产出整份
 * 长片计划，实测 gpt-5.6-luna 经常超过通用 `UPSTREAM_TIMEOUT_MS` 的 30s 默认值。
 * 默认 120s，上限 5 分钟。
 */
export function harnessLlmTimeoutMs(): number {
  const n = Number(process.env.HARNESS_LLM_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 5 * 60_000) : 120_000;
}

/** M2.4：一致性管线总开关。未开启时 30/45/60 仍由 API 拒绝，orchestrator 恒抛。 */
export function harnessEnabled(): boolean {
  const v = process.env.HARNESS_ENABLED?.trim();
  return v === "1" || v === "true";
}

/** 同一 harness job 内并行生成的 shot 数（默认 2）。 */
export function harnessShotConcurrency(): number {
  const n = Number(process.env.HARNESS_SHOT_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 4) : 2;
}

/**
 * 视觉一致性 QC 阈值（0–1）。未设置即跳过视觉打分——阈值需由
 * evals/runs 对照集校准后固定（design.md §7.2 H2），仓库不预设。
 */
export function harnessQcVisualThreshold(): number | null {
  const raw = process.env.HARNESS_QC_VISUAL_THRESHOLD?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * 视觉 QC 用的视觉模型名；未设时用智能体对话模型（`agentLlmConfig().model`）。
 * 评分模型与对话模型分开配置的场景（如对话走便宜小模型、视觉走带图的大模型）用它覆盖。
 */
export function harnessQcVisualModel(): string | undefined {
  const raw = process.env.HARNESS_QC_VISUAL_MODEL?.trim();
  return raw || undefined;
}

/**
 * 智能体对话的独立凭据（2026-09-07）。
 *
 * 刻意**不复用**生图那几把 key：生产上的 `OPENAI_BASE_URL`（ccgoai）与 `YMAN_API_KEY`
 * 都是只出图的中转，它们的 `/chat/completions` 分别回 503 与 400——按「哪家有 key」
 * 挑提供方，等于每一轮都先扣款、再失败、再退款。对话是另一种能力，就该有自己的一把
 * 钥匙。不设它时只回落到 xAI（Director 已经在用的那把），两者都没有就是「智能体不可用」，
 * 由 API 明说 503，绝不静默落 mock 假装在工作。
 */
export function agentApiKey(): string | undefined {
  return process.env.AGENT_API_KEY?.trim() || undefined;
}

/** 对话端点的 REST root，**带** `/v1`（缺就补）。默认 OpenAI 官方。 */
export function agentBase(): string {
  const raw = process.env.AGENT_BASE_URL?.trim();
  if (!raw) return OFFICIAL_OPENAI_BASE;
  return normalizeApiBase(raw, OFFICIAL_OPENAI_BASE);
}

/**
 * 智能体对话用的文本模型名（2026-09-06）。
 *
 * **不设**才是常态：`src/lib/agent/llm.ts` 用 `AGENT_API_KEY` 时取 `gpt-4o-mini`，
 * 回落 xAI 时取 `grok-4.6`。这条变量是唯一的覆盖口，一处改所有提供方——刻意不做成
 * per-provider 两个变量：模型名是运维偶尔要换的一个值，不是一层配置。
 */
export function agentChatModel(): string | undefined {
  return process.env.AGENT_CHAT_MODEL?.trim() || undefined;
}

export function upstreamRetryBaseMs(): number {
  const n = Number(process.env.UPSTREAM_RETRY_BASE_MS ?? 250);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 10_000) : 250;
}

/**
 * 上游轮询阶梯的**上限**（毫秒），默认 10 秒（方案 §3.3「轮询」）。
 *
 * 阶梯本身写在 `jobs/runner.ts` 的 `pollDelayMs`：前 20 秒 2 秒一次（用户还看着），
 * 20→60 秒线性升到 5 秒，之后就是这条上限。调小它等于回到「一直高频轮询」，调大则更省
 * 上游配额但成片出现得更晚——真相仍然是轮询，SSE 只是加速。下限 500ms，上限 60s。
 */
export function upstreamPollMaxMs(): number {
  const n = Number(process.env.UPSTREAM_POLL_MAX_MS ?? 10_000);
  if (!Number.isFinite(n) || n < 500) return 10_000;
  return Math.min(Math.floor(n), 60_000);
}
