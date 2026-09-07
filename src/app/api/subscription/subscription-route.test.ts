import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * `GET/POST /api/subscription`（方案 §3.1、§3.3）。写法照抄
 * `src/app/api/jobs/jobs-routes.test.ts`：直接调 handler，不走真实 HTTP，
 * 会话用同一套签名 Cookie 构造。
 */

const SESSION_SECRET = "subscription-route-test-secret-0123";

let dataRoot = "";
let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-subscription-route-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  // 价格随部署环境变（`costRatio`）；钉成生产那台的配置，标准档月费才是确定的 ¥19.1。
  process.env.VIDEO_PROVIDER_ORDER = "kling,yman,grok";
  process.env.IMAGE_PROVIDER_ORDER = "openai,yman";
  process.env.OPENAI_IMAGE_PRICE_TABLE = JSON.stringify({ high: { "1K": 0.2, "2K": 0.4 } });
  process.env.OPENAI_IMAGE_QUALITY = "high";
  ({ GET, POST } = await import("./route"));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
});

afterAll(async () => {
  for (const key of [
    "DATA_DIR",
    "LUMEN_SESSION_SECRET",
    "VIDEO_PROVIDER_ORDER",
    "IMAGE_PROVIDER_ORDER",
    "OPENAI_IMAGE_PRICE_TABLE",
    "OPENAI_IMAGE_QUALITY",
  ]) {
    delete process.env[key];
  }
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
}

async function seedUser(id: string, balanceCny: number): Promise<UserRecord> {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function cookieFor(user: UserRecord): string {
  return `${SESSION_COOKIE}=${issueSessionValue(user)}`;
}

function getRequest(user?: UserRecord): Request {
  return new Request("http://localhost/api/subscription", {
    headers: user ? { cookie: cookieFor(user) } : {},
  });
}

let keySeq = 0;
/** 一次购买一个幂等键（服务端必填）。要验重放的用例自己传同一个 key。 */
function purchaseBody(planId: string, cycle: string, key?: string) {
  keySeq += 1;
  return { planId, cycle, idempotencyKey: key ?? `route-key-${keySeq}` };
}

function postRequest(user: UserRecord, body: unknown): Request {
  return new Request("http://localhost/api/subscription", {
    method: "POST",
    headers: { cookie: cookieFor(user), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/subscription", () => {
  it("没有会话就是 401", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it("下发四档与「我的订阅」（未订阅时为 null），但不下发成本比例", async () => {
    const user = await seedUser(userId("g1"), 100);
    const res = await GET(getRequest(user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plans: Array<{ id: string; monthlyCny: number; yearlyCny: number; features: string[] }>;
      mine: unknown;
    };
    expect(body.plans.map((p) => p.id)).toEqual(["standard", "pro", "premium", "ultimate"]);
    expect(body.plans[0]!.monthlyCny).toBe(19.1);
    expect(body.plans[0]!.yearlyCny).toBe(229.2);
    // 功能行是 i18n 键名，服务端不翻译。
    expect(body.plans[0]!.features[0]).toBe("subscription.featureCredits");
    // 成本比例与毛利率是我们的进货价与加价幅度，绝不下发到浏览器。
    expect(body).not.toHaveProperty("basis");
    expect(JSON.stringify(body)).not.toContain("costRatio");
    expect(body.mine).toBeNull();
  });
});

describe("POST /api/subscription", () => {
  it("strict 校验：认不出的档位、多余的键、缺幂等键都是 400", async () => {
    const user = await seedUser(userId("p1"), 100);
    expect((await POST(postRequest(user, purchaseBody("gold", "monthly")))).status).toBe(400);
    expect((await POST(postRequest(user, purchaseBody("standard", "weekly")))).status).toBe(400);
    expect(
      (await POST(postRequest(user, { ...purchaseBody("standard", "monthly"), coupon: "x" }))).status,
    ).toBe(400);
    // 幂等键是必填的：这条路上重复提交多出来的是一笔订阅费，不是一条任务。
    expect((await POST(postRequest(user, { planId: "standard", cycle: "monthly" }))).status).toBe(400);
    expect(
      (await POST(postRequest(user, { ...purchaseBody("standard", "monthly"), idempotencyKey: "" })))
        .status,
    ).toBe(400);
    expect((await readUser(user.id))?.subscription).toBeUndefined();
  });

  it("买下标准档：200，回执带我的订阅与两个池的余额", async () => {
    const user = await seedUser(userId("p2"), 100);
    const res = await POST(postRequest(user, purchaseBody("standard", "monthly")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mine: { planId: string; cycle: string; memberCreditsCny: number };
      balance: { balanceCny: number; memberCreditsCny: number; availableCny: number };
      paidCny: number;
      replay: boolean;
    };
    expect(body.paidCny).toBe(19.1);
    expect(body.replay).toBe(false);
    expect(body.mine.planId).toBe("standard");
    expect(body.mine.cycle).toBe("monthly");
    // 会员积分 ¥12 = 1200 积分；已购池扣掉月费。
    expect(body.balance.balanceCny).toBe(80.9);
    expect(body.balance.memberCreditsCny).toBe(12);
    expect(body.balance.availableCny).toBe(92.9);
  });

  it("同一个幂等键重放：200 拿回同一份订阅，不是 409，也不扣第二笔", async () => {
    const user = await seedUser(userId("p6"), 100);
    const body = purchaseBody("standard", "monthly", "route-replay");
    const first = (await (await POST(postRequest(user, body))).json()) as { mine: { id: string } };
    const res = await POST(postRequest(user, body));
    expect(res.status).toBe(200);
    const again = (await res.json()) as { mine: { id: string }; replay: boolean };
    expect(again.replay).toBe(true);
    expect(again.mine.id).toBe(first.mine.id);
    expect((await readUser(user.id))?.balanceCny).toBe(80.9);
  });

  it("再买一次是 409", async () => {
    const user = await seedUser(userId("p3"), 100);
    expect((await POST(postRequest(user, purchaseBody("standard", "monthly")))).status).toBe(200);
    const res = await POST(postRequest(user, purchaseBody("pro", "monthly")));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("subscription_active");
  });

  it("已购余额不够是 402，载荷在标准信封之外多带 needCny / purchasableCny", async () => {
    const user = await seedUser(userId("p4"), 5);
    const res = await POST(postRequest(user, purchaseBody("standard", "monthly")));
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error: { code: string; message: string };
      needCny: number;
      purchasableCny: number;
    };
    // 信封不变，`@/lib/client/http` 的 ApiError.code 才拿得到码。
    expect(body.error.code).toBe("insufficient_balance");
    expect(body.needCny).toBe(19.1);
    expect(body.purchasableCny).toBe(5);
  });

  it("买完之后 GET 能读到我的订阅，且当天的日积分只发一次", async () => {
    const user = await seedUser(userId("p5"), 100);
    await POST(postRequest(user, purchaseBody("standard", "monthly")));
    for (let i = 0; i < 3; i += 1) await GET(getRequest(user));
    const res = await GET(getRequest(user));
    const body = (await res.json()) as {
      mine: { planId: string; memberCreditsCny: number; dailyGrantedToday: boolean };
    };
    // 12 元本期额度 + 0.6 元当日赠送，无论 GET 了几次。
    expect(body.mine.memberCreditsCny).toBe(12.6);
    expect(body.mine.dailyGrantedToday).toBe(true);
  });
});
