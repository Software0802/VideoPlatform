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
export const DEFAULT_YMAN_T2V_MODEL = "minimax-H3 文字";
export const DEFAULT_YMAN_I2V_MODEL = "minimax-h3-933-图文";
/** YMan 也兼容 OpenAI Images API；生图默认走它的 gpt-image-2。 */
export const DEFAULT_YMAN_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_YMAN_UNKNOWN_CREDITS = 150;
const DEFAULT_USD_CNY_RATE = 7.2;
const DEFAULT_PROVIDER_EXHAUSTED_TTL_MS = 6 * 60 * 60_000;

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

export type VideoProviderChoice = "grok" | "kling" | "yman";

/** 能接视频任务的 provider（按能力路由，不含只出图的 openai 与占位的 jimeng）。 */
export const VIDEO_PROVIDER_IDS: readonly VideoProviderChoice[] = ["kling", "yman", "grok"];

/**
 * 没有任何显式配置时的优先级：只有 xAI。
 *
 * 换供应商是一次显式选择，不是「配了 key 就自动生效」的副作用——把可灵放进默认次序，
 * 一个为了别的用途（对账、试跑一次）配上的 `KLING_API_KEY` 就会静默改变全站视频的落点、
 * 时长档位与成片质感，而运维那边什么都没改。要走可灵，写 `VIDEO_PROVIDER_ORDER`
 * （或旧的 `VIDEO_PROVIDER=kling`）说出来。
 */
const DEFAULT_VIDEO_PROVIDER_ORDER: readonly VideoProviderChoice[] = ["grok"];

/**
 * 视频路由的优先级列表（方案 §3.4「功能先于供应商」）。router 按「模式 → 声明支持它且
 * 配了 key 的第一个 provider」路由，所以这条只表达**偏好次序**，不表达能力——某个
 * provider 接不了这个模式时会自动跳到下一个，不需要在这里为每种模式各写一份。
 *
 * 兼容旧的单一开关 `VIDEO_PROVIDER`：`=kling` 视为 `kling,grok`，`=grok`（以及任何
 * 非法值）视为只有 `grok`——旧配置的语义就是「除非点名，否则别让可灵抢路由」，
 * 默认次序（`grok`）现在与它同一个语义。列表里认不出的名字直接丢掉，
 * 全丢光了就当没设过（回到兼容分支），免得一个拼错的名字把视频功能整个关掉。
 */
export function videoProviderOrder(): VideoProviderChoice[] {
  const raw = process.env.VIDEO_PROVIDER_ORDER?.trim();
  if (raw) {
    const parsed = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is VideoProviderChoice =>
        (VIDEO_PROVIDER_IDS as readonly string[]).includes(s),
      );
    const deduped = [...new Set(parsed)];
    if (deduped.length) return deduped;
  }
  const legacy = process.env.VIDEO_PROVIDER?.trim().toLowerCase();
  if (!legacy) return [...DEFAULT_VIDEO_PROVIDER_ORDER];
  return legacy === "kling" ? ["kling", "grok"] : ["grok"];
}

export type ImageProviderChoice = "openai" | "yman" | "grok";

/** 能接文生图的 provider（可灵只做视频，不在其中）。 */
export const IMAGE_PROVIDER_IDS: readonly ImageProviderChoice[] = ["openai", "yman", "grok"];

/**
 * 文生图的优先级列表，默认 `openai,grok`——正是加 YMan 之前那条硬编码的阶梯
 * （有 OPENAI_API_KEY 走 openai，否则 xAI，都没有才 mock），所以旧实例不改配置行为不变。
 *
 * 与 `VIDEO_PROVIDER_ORDER` 同一套规则：只表达偏好次序，能力由各 provider 的
 * `capabilities().modes` 说了算；认不出的名字丢掉，全丢光就回落默认。
 */
export function imageProviderOrder(): ImageProviderChoice[] {
  const raw = process.env.IMAGE_PROVIDER_ORDER?.trim();
  if (raw) {
    const parsed = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ImageProviderChoice =>
        (IMAGE_PROVIDER_IDS as readonly string[]).includes(s),
      );
    const deduped = [...new Set(parsed)];
    if (deduped.length) return deduped;
  }
  return ["openai", "grok"];
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

/** 文生视频的上游模型名。默认 minimax_h3_t2v（纯文生，不收参考图）。 */
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
 * grok-4.6 视觉一致性 QC 阈值（0–1）。未设置即跳过视觉打分——阈值需由
 * evals/runs 对照集校准后固定（design.md §7.2 H2），仓库不预设。
 */
export function harnessQcVisualThreshold(): number | null {
  const raw = process.env.HARNESS_QC_VISUAL_THRESHOLD?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function upstreamRetryBaseMs(): number {
  const n = Number(process.env.UPSTREAM_RETRY_BASE_MS ?? 250);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 10_000) : 250;
}
