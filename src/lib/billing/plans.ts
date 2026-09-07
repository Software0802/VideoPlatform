import { priceCny } from "@/lib/billing/prices";
import {
  estimateCostUsd,
  openaiImagePriceTable,
  ymanImagePriceTable,
  type ImagePriceTable,
} from "@/lib/cost";
import {
  imageProviderOrder,
  openaiImageQuality,
  usdCnyRate,
  videoProviderOrder,
} from "@/lib/env";
import { log } from "@/lib/log";
import {
  allProducts,
  defaultResolutionOf,
  modelForProduct,
  type Product,
} from "@/lib/products/catalog";
import { SUBSCRIPTION_PLAN_IDS, type SubscriptionPlanId } from "@/lib/users/schema";

/**
 * 订阅档位与定价（方案 `docs/plan-agent-i18n-subscription-2026-09.md` §3.1）。
 *
 * 用户的要求是「价格数字按实际价格 + 15% 毛利率」，主代理已把口径钉死：
 *
 *  - 「实际价格」= **上游成本**（我们付给 provider 的钱），不是售价表——售价表本身
 *    已经含 60–80% 毛利，再叠 15% 说不通；
 *  - 「加 15% 毛利率」= `price = cost / (1 − 0.15)`（毛利 ÷ 售价的财务定义），
 *    与 `cost × 1.15` 差 2.3%，常量 `GROSS_MARGIN` 一处可改。
 *
 * 于是订阅价 = 「这一档给的积分按现价能买到的东西，值多少上游成本」÷ 0.85。中间那个
 * 「成本 ÷ 售价」的比例就是 `costRatio()`：它随部署环境（用哪家 provider、什么价目表）
 * 变，所以是算出来的，不是写死的数。
 *
 * 服务端专用：这里要读产品目录（→ 路由 → 全部 provider）。浏览器需要的价格由
 * `GET /api/subscription` 下发，不要从客户端组件 import 本文件。
 */

/** 毛利率。价格 = 成本 ÷ (1 − 这个数)。 */
export const GROSS_MARGIN = 0.15;

/** 每档每天赠送的积分（原型的功能行，四档相同）。 */
export const DAILY_CREDITS = 60;

/** 一期 = 30 天。月付 1 期，年付 12 期。 */
export const PERIOD_DAYS = 30;

/** ¥1 = 100 积分（AGENTS.md 的口径，只用于面值换算）。 */
export const CREDITS_PER_CNY = 100;

/**
 * 成本基准算不出来时的回落值（成本约等于售价的一半）。真回落到这里说明这台实例
 * 的产品目录或价目表配得不对，所以同时记一条 warn——价格照样能出，但要有人看见。
 */
export const FALLBACK_COST_RATIO = 0.5;

/** 成本基准取样用的视频时长（秒）：所有产品的最短档都是 5 秒。 */
const SAMPLE_VIDEO_SECONDS = 5;
/** 成本基准取样用的图片尺寸：1K 档的代表尺寸。 */
const SAMPLE_IMAGE_SIZE = "1024x1024";

export type PlanId = SubscriptionPlanId;
export const PLAN_IDS = SUBSCRIPTION_PLAN_IDS;

export type PlanDef = {
  id: PlanId;
  /** 中文档位名。界面实际显示的是 i18n 的 `subscription.plan<Id>`，这个是兜底。 */
  name: string;
  /** 每 30 天重置的积分。 */
  credits: number;
  popular?: boolean;
};

/** 四档（方案 §3.1）。积分数是产品决定，价格由 `costRatio()` 算出来。 */
export const PLAN_DEFS: readonly PlanDef[] = [
  { id: "standard", name: "标准版", credits: 1200 },
  { id: "pro", name: "专业版", credits: 6000 },
  { id: "premium", name: "尊享版", credits: 15000 },
  { id: "ultimate", name: "至尊版", credits: 25000, popular: true },
];

/**
 * 功能行。四档共用同一组键，数字由前端用 `credits` / `dailyCredits` 填进占位符——
 * 服务端不翻译（多语言的事实源是 `src/lib/i18n/messages/`），所以这里下发的是**键名**。
 * 每一条都必须是真的：并发数、水印、4K、错峰这些原型文案后端根本没有对应实现。
 */
export const PLAN_FEATURE_KEYS = [
  "subscription.featureCredits",
  "subscription.featureDaily",
  "subscription.featureMemberFirst",
  "subscription.featureAllProducts",
] as const;

export type PlanPublic = {
  id: PlanId;
  name: string;
  credits: number;
  dailyCredits: number;
  monthlyCny: number;
  yearlyCny: number;
  popular?: boolean;
  /** i18n 键名，由前端翻译。 */
  features: string[];
};

export function planById(id: string | undefined | null): PlanDef | undefined {
  if (!id) return undefined;
  return PLAN_DEFS.find((plan) => plan.id === id);
}

/**
 * 一档的价格。
 *
 *   月费 = ceil1( (月积分 + 30 × 日积分) / 100 × costRatio / (1 − 毛利率) )
 *   年费 = 12 × 月费
 *
 * 年费**不打折**：毛利率是固定的，打折就等于把毛利让掉一块，原型上那个「立减 40%」
 * 的徽标因此删掉了（方案 §3.1）。月费向上取到 0.1 元——取整方向朝上，免得四舍五入
 * 把毛利抹掉一点点。
 */
export function planPrices(plan: PlanDef, ratio: number = costRatio()): {
  monthlyCny: number;
  yearlyCny: number;
} {
  const faceCny = (plan.credits + PERIOD_DAYS * DAILY_CREDITS) / CREDITS_PER_CNY;
  const monthlyCny = ceil1((faceCny * ratio) / (1 - GROSS_MARGIN));
  // 月费 ≥ 面值 = 「订阅比直接充值同样多的积分还贵」，没人会买，而且它一定是配置错了
  // （成本基准算歪、价目表单位串了）。价格照出——拒绝出价只会让整页空着——但要有人看见。
  if (monthlyCny >= faceCny) {
    log("warn", "订阅月费已达到或超过积分面值，成本基准可能配错了", {
      planId: plan.id,
      monthlyCny,
      faceCny: round2(faceCny),
      ratio,
    });
  }
  return { monthlyCny, yearlyCny: round2(monthlyCny * 12) };
}

/** 四档的完整对外形状。`ratio` 只算一次，四档共用（也保证四档口径一致）。 */
export function listPlans(ratio: number = costRatio()): PlanPublic[] {
  return PLAN_DEFS.map((plan) => ({
    id: plan.id,
    name: plan.name,
    credits: plan.credits,
    dailyCredits: DAILY_CREDITS,
    ...planPrices(plan, ratio),
    ...(plan.popular ? { popular: true } : {}),
    features: [...PLAN_FEATURE_KEYS],
  }));
}

/**
 * 成本基准：「默认视频产品 5 秒默认档」与「默认图片产品 1K」两个成本 ÷ 售价里**更高**的那个。
 *
 * 取 max 而不是均值，是因为订阅积分是通用的：用户会把它全花在成本比最高的那个产品上
 * （逆向选择）。按均值定价等于假设用户按我们希望的比例混用两类产品——他没有义务这么做，
 * 而只要他全买贵的那一类，「毛利率 15%」就变成了负毛利。max 是这条产品线上真实的成本
 * 上界，用它定价，任何花法都还在毛利里。
 *
 * 「默认产品」= 产品目录里、provider 排在 `VIDEO_PROVIDER_ORDER` / `IMAGE_PROVIDER_ORDER`
 * 首位的第一个产品：那正是路由在没指定产品时的第一落点。用 `allProducts()` 而不是
 * `availableProducts()`，是为了让基准跟着**部署配置**走，不跟着「某家临时被判定积分
 * 耗尽」抖动——订阅价不该因为上游今天欠费就变一个数。
 *
 * 任何一半算不出来（目录里没有那家的产品、售价为 0、成本表缺档）就整体回落
 * `FALLBACK_COST_RATIO` 并记 warn：半个基准比一个明确的兜底更容易骗人——尤其在 max
 * 口径下，算不出来的那一半正好可能是更贵的那一半。
 */
export function costRatio(): number {
  const video = videoCostRatio();
  const image = imageCostRatio();
  if (video == null || image == null || !(video > 0) || !(image > 0)) {
    log("warn", "订阅定价的成本基准算不出，回落固定比例", {
      video,
      image,
      fallback: FALLBACK_COST_RATIO,
    });
    return FALLBACK_COST_RATIO;
  }
  const ratio = round4(Math.max(video, image));
  if (!Number.isFinite(ratio) || ratio <= 0) return FALLBACK_COST_RATIO;
  return ratio;
}

/** 这条通道（视频 / 图片各一份）的第一落点产品。 */
function defaultProductOf(kind: "video" | "image"): Product | undefined {
  const first = (kind === "image" ? imageProviderOrder() : videoProviderOrder())[0];
  if (!first) return undefined;
  return allProducts().find((product) => product.kind === kind && product.provider === first);
}

/** 默认视频产品：5 秒 + 产品默认分辨率 + 它自己的音轨档，成本 ÷ 售价。 */
function videoCostRatio(): number | null {
  const product = defaultProductOf("video");
  if (!product) return null;
  const mode = product.modes.includes("text_to_video") ? "text_to_video" : product.modes[0];
  if (!mode) return null;
  const resolution = defaultResolutionOf(product) ?? null;
  // 与 `samplePriceCny` 同一口径：`uncontrolled` 的产品不收有声加价，也就不按有声估成本。
  const audio = product.audio === "native" ? "native" : "off";
  const price = priceCny({
    mode,
    durationSec: SAMPLE_VIDEO_SECONDS,
    resolution,
    generateAudio: audio === "native",
  });
  if (!(price > 0)) return null;
  const costUsd = estimateCostUsd(modelForProduct(product, mode), SAMPLE_VIDEO_SECONDS, undefined, {
    resolution: resolution ?? "720p",
    audio,
    provider: product.provider,
  });
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return (costUsd * usdCnyRate()) / price;
}

/** 默认图片产品：1K 一张，成本 ÷ 售价。 */
function imageCostRatio(): number | null {
  const product = defaultProductOf("image");
  if (!product) return null;
  const price = priceCny({ mode: "text_to_image", imageResolution: "1k" });
  if (!(price > 0)) return null;
  const cost = imageCostCny(product);
  if (cost == null || !(cost > 0)) return null;
  return cost / price;
}

/**
 * 一张 1K 图的上游成本，人民币。
 *
 * ⚠️ 单位陷阱：中转站的价目表（`OPENAI_IMAGE_PRICE_TABLE` / `YMAN_IMAGE_PRICE_TABLE`）
 * 扣的是**人民币额度**，不是美元（见 `cost.ts` 那条告警），命中档表的值绝不能再乘汇率。
 * 两张表都没配时才走 `estimateCostUsd` 的美元口径：只要有一张配了，`estimateCostUsd`
 * 内部按 provider 选表的分支就可能回来一个人民币数字，而调用点分不出来——分不出来的
 * 时候宁可回落固定比例，也不要把 ¥0.2 当成 $0.2 记成 7.2 倍。
 */
function imageCostCny(product: Product): number | null {
  const quality = openaiImageQuality();
  const openaiTable = openaiImagePriceTable();
  const ymanTable = ymanImagePriceTable();
  const own =
    product.provider === "yman" ? ymanTable : product.provider === "openai" ? openaiTable : null;
  if (own) {
    const tiered = tier1kPriceCny(own, quality);
    if (tiered != null) return tiered;
  }
  if (openaiTable || ymanTable) return null;
  const usd = estimateCostUsd(modelForProduct(product, "text_to_image"), 0, {
    size: SAMPLE_IMAGE_SIZE,
    quality,
    provider: product.provider,
  });
  return Number.isFinite(usd) && usd > 0 ? usd * usdCnyRate() : null;
}

/**
 * 档表里 1K 这一档的价（人民币）。判据与 `cost.ts` 的 `priceFromTable` 一致：
 * 画质名对不上就取同尺寸档里最贵的一条，整张表都没有 1K 才返回 null。
 */
function tier1kPriceCny(table: ImagePriceTable, quality: string): number | null {
  const direct = table[String(quality ?? "").trim().toLowerCase()]?.["1K"];
  if (direct != null) return direct;
  const candidates = Object.values(table)
    .map((row) => row["1K"])
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : null;
}

/** 向上取到 0.1 元。先抹掉浮点毛刺，否则 16.6 会被 `Math.ceil` 抬成 16.7。 */
function ceil1(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(Number((n * 10).toFixed(6))) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
