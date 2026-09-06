import path from "node:path";

export const OFFICIAL_XAI_BASE = "https://api.x.ai/v1";
export const DEFAULT_SUB2API_BASE = "http://127.0.0.1:8080/v1";
export const OFFICIAL_OPENAI_BASE = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
/** 可灵新系统域名。路径不带 `/v1`，所以这里也不补。 */
export const OFFICIAL_KLING_BASE = "https://api-beijing.klingai.com";
export const DEFAULT_KLING_VIDEO_MODEL = "kling-2.6";
const DEFAULT_KLING_USD_PER_UNIT = 0.1;

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

export type VideoProviderChoice = "grok" | "kling";

/**
 * 视频路由的显式开关（方案 §3）。xAI key 会一直存在（r2v / edit / extend / harness 靠它），
 * 所以可灵不能凭「有没有 key」抢路由，必须由这条环境变量点名。非法值回落 grok。
 */
export function videoProvider(): VideoProviderChoice {
  return process.env.VIDEO_PROVIDER?.trim().toLowerCase() === "kling" ? "kling" : "grok";
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

/**
 * Mock 模式 = 没有任何可用的上游 key。文生图可以只靠 OpenAI key、视频可以只靠可灵 key
 * 跑真实上游，所以任意一把 key 都足以让实例脱离 mock（其余路径仍各自按 key 回落到 mock）。
 */
export function isMockMode(): boolean {
  return forceMock() || (!hasXaiKey() && !hasOpenaiKey() && !hasKlingKey());
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
