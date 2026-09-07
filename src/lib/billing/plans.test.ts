import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAILY_CREDITS,
  FALLBACK_COST_RATIO,
  GROSS_MARGIN,
  PLAN_DEFS,
  costRatio,
  listPlans,
  planById,
  planPrices,
} from "./plans";

/**
 * 订阅定价（方案 §3.1）。三件事要钉死：
 *
 *  1. `costRatio()` 真的按「默认产品的上游成本 ÷ 售价」算，且随 `*_PROVIDER_ORDER`
 *     变——它是价格里唯一会随部署环境变的那个数，算错了四档一起错；
 *  2. 视频与图片两个比例取 **max** 而不是均值：订阅积分是通用的，用户会把它全花在成本比
 *     最高的那个产品上（逆向选择），按均值定价等于假设他按我们希望的比例混用；
 *  3. `月费 = 面值 × ratio ÷ (1 − 毛利率)` 向上取到 0.1 元、`年费 = 12 × 月费` 不打折。
 *
 * 成本表本身（可灵积分 / 生图档表）由 `cost.ts` 负责，这里只验「取哪张表、除哪个数」。
 */

const ENV_KEYS = [
  "VIDEO_PROVIDER_ORDER",
  "IMAGE_PROVIDER_ORDER",
  "OPENAI_IMAGE_PRICE_TABLE",
  "YMAN_IMAGE_PRICE_TABLE",
  "OPENAI_IMAGE_QUALITY",
  "KLING_VIDEO_MODEL",
  "USD_CNY_RATE",
  "KLING_USD_PER_UNIT",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

/** 生产那台实例的配置：可灵接视频、openai 接图（中转档表按人民币计价）。 */
function useProductionLikeEnv(): void {
  process.env.VIDEO_PROVIDER_ORDER = "kling,yman,grok";
  process.env.IMAGE_PROVIDER_ORDER = "openai,yman";
  process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({ high: { "1K": 0.2, "2K": 0.4 } });
  process.env.OPENAI_IMAGE_QUALITY = "high";
}

describe("costRatio", () => {
  it("取默认视频产品 5 秒与默认图片产品 1K 两个成本比里**更高**的那个", () => {
    useProductionLikeEnv();
    // 视频：可灵「标准」720p 无声，0.3 积分/秒 × 5 × $0.10 × 7.2 = ¥1.08，售价 ¥2 → 0.54
    // 图片：openai 档表 1K = ¥0.2（已是人民币，不再乘汇率），售价 ¥0.5 → 0.4
    // 取 max = 0.54（均值 0.47 会低估：把积分全花在视频上的人正好落在毛利之外）。
    expect(costRatio()).toBe(0.54);
  });

  it("图片那半更贵时就跟着图片走（max 是对称的，不偏袒视频）", () => {
    useProductionLikeEnv();
    // 生图档表抬到 ¥0.35 / 张、售价 ¥0.5 → 0.7 > 视频的 0.54。
    process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({ high: { "1K": 0.35, "2K": 0.7 } });
    expect(costRatio()).toBe(0.7);
  });

  it("跟着 ORDER 首位走：换成 xAI 接视频，基准立刻变成 grok 的每秒单价", () => {
    useProductionLikeEnv();
    const withKling = costRatio();
    process.env.VIDEO_PROVIDER_ORDER = "grok";
    const withGrok = costRatio();
    // grok 「Grok」产品自带音轨（售价含 ¥1 加价），单价也高得多，比例必然不同。
    expect(withGrok).not.toBeCloseTo(withKling, 4);
    expect(withGrok).toBeGreaterThan(0);
  });

  it("人民币档表里没有 1K 这一档时整体回落固定比例，而不是拿美元数硬凑", () => {
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.IMAGE_PROVIDER_ORDER = "openai";
    // 表能解析、但只有 2K：图片那一半算不出来 → 回落（半个基准比一个明确兜底更骗人）。
    process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({ high: { "2K": 0.4 } });
    expect(costRatio()).toBe(FALLBACK_COST_RATIO);
  });

  it("两张生图档表都没配时走美元口径，并乘上汇率", () => {
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.IMAGE_PROVIDER_ORDER = "openai";
    process.env.USD_CNY_RATE = "7.2";
    // gpt-image-1 的提交口径 $0.011 → ¥0.0792，售价 ¥0.5 → 0.1584；视频那半仍是 0.54，
    // 取 max 之后是视频说了算。
    expect(costRatio()).toBeCloseTo(0.54, 3);
  });

  it("永远返回一个正数（回落值本身也是正的）", () => {
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.IMAGE_PROVIDER_ORDER = "openai";
    expect(costRatio()).toBeGreaterThan(0);
  });
});

describe("planPrices", () => {
  const standard = PLAN_DEFS[0]!;

  it("月费 = (月积分 + 30 × 日积分) / 100 × ratio ÷ (1 − 毛利率)，向上取到 0.1 元", () => {
    // 标准档面值 = (1200 + 30 × 60) / 100 = ¥30；30 × 0.47 / 0.85 = 16.588 → 16.6
    expect(planPrices(standard, 0.47).monthlyCny).toBe(16.6);
    // 30 × 0.5 / 0.85 = 17.647 → 17.7
    expect(planPrices(standard, 0.5).monthlyCny).toBe(17.7);
  });

  it("年费恒等于 12 × 月费（毛利率固定就没有打折空间）", () => {
    for (const plan of PLAN_DEFS) {
      const { monthlyCny, yearlyCny } = planPrices(plan, 0.47);
      expect(yearlyCny).toBeCloseTo(monthlyCny * 12, 6);
    }
  });

  it("取整只朝上：正好落在 0.1 的整数倍上时不会被再抬一档", () => {
    // ratio 选成让结果恰好是 17 元：17 × 0.85 / 30 = 0.481666…
    const exact = (17 * (1 - GROSS_MARGIN)) / 30;
    expect(planPrices(standard, exact).monthlyCny).toBe(17);
  });

  it("四档价格随积分单调递增", () => {
    const prices = PLAN_DEFS.map((plan) => planPrices(plan, 0.47).monthlyCny);
    for (let i = 1; i < prices.length; i += 1) {
      expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
    }
  });

  it("生产那台配置下的四档（ratio 0.54）就是页面上会看到的数", () => {
    useProductionLikeEnv();
    const ratio = costRatio();
    expect(PLAN_DEFS.map((plan) => planPrices(plan, ratio).monthlyCny)).toEqual([
      19.1, 49.6, 106.8, 170.3,
    ]);
    expect(PLAN_DEFS.map((plan) => planPrices(plan, ratio).yearlyCny)).toEqual([
      229.2, 595.2, 1281.6, 2043.6,
    ]);
  });

  it("月费涨到面值以上时记一条 warn（价格照出，但那一定是配置错了）", () => {
    const warned: unknown[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warned.push(args);
    });
    try {
      // ratio 0.9 → 30 × 0.9 / 0.85 = 31.8 > 面值 30。
      expect(planPrices(standard, 0.9).monthlyCny).toBe(31.8);
      expect(warned.length).toBeGreaterThan(0);
      warned.length = 0;
      // 正常区间不吵。
      planPrices(standard, 0.47);
      expect(warned).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listPlans", () => {
  it("四档齐全，每档都带日积分与四条真实的功能行键名", () => {
    const plans = listPlans(0.47);
    expect(plans.map((p) => p.id)).toEqual(["standard", "pro", "premium", "ultimate"]);
    for (const plan of plans) {
      expect(plan.dailyCredits).toBe(DAILY_CREDITS);
      expect(plan.monthlyCny).toBeGreaterThan(0);
      expect(plan.yearlyCny).toBeGreaterThan(plan.monthlyCny);
      // 功能行下发的是 i18n 键名（服务端不翻译），前端拿 credits / dailyCredits 填占位符。
      expect(plan.features).toEqual([
        "subscription.featureCredits",
        "subscription.featureDaily",
        "subscription.featureMemberFirst",
        "subscription.featureAllProducts",
      ]);
    }
  });

  it("只有至尊档带 popular 标记", () => {
    const marked = listPlans(0.47).filter((p) => p.popular);
    expect(marked.map((p) => p.id)).toEqual(["ultimate"]);
  });
});

describe("planById", () => {
  it("认得四个档位 id，认不出的返回 undefined", () => {
    expect(planById("standard")?.credits).toBe(1200);
    expect(planById("ultimate")?.credits).toBe(25000);
    expect(planById("gold")).toBeUndefined();
    expect(planById(undefined)).toBeUndefined();
  });
});
