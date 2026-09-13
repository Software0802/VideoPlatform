import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `providers/health.ts` 分级冷却（方案 §4c）：
 *  - 窗口样本 / `quota_exhausted` 6h / `rate_limited` 的 Retry-After 与指数翻倍；
 *  - 连续 3 次 5xx 类 → 5 分钟冷却 + `relay_unhealthy` 告警一次；
 *  - 冷却到期半开、单探路名额、探路成功恢复 / 失败翻倍再冷却；
 *  - 冷却落盘 `data/provider-health.json`，「重启」后延续。
 */
let dataRoot = "";
let health: typeof import("./health");

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-health-test-"));
  process.env.DATA_DIR = dataRoot;
  health = await import("./health");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete process.env.ALERT_WEBHOOK_URL;
});

beforeEach(() => health.__resetHealthForTests());

afterAll(async () => {
  await health.__flushHealthForTests();
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

const ID = "fixture-health";

describe("recordOutcome / 窗口与冷却", () => {
  it("正常成功不进冷却；isAvailable 恒真", () => {
    health.recordOutcome(ID, "video", true, 120);
    expect(health.isAvailable(ID, "video")).toBe(true);
  });

  it("quota_exhausted → 6h 冷却（PROVIDER_EXHAUSTED_TTL_MS）", () => {
    vi.stubEnv("PROVIDER_EXHAUSTED_TTL_MS", "3600000");
    health.recordOutcome(ID, "video", false, 50, "quota_exhausted");
    expect(health.isAvailable(ID, "video")).toBe(false);
    const entry = health
      .healthList()
      .find((h) => h.providerId === ID && h.kind === "video");
    expect(entry?.state).toBe("cooldown");
    // 图片通道不受连坐。
    expect(health.isAvailable(ID, "image")).toBe(true);
  });

  it("rate_limited 优先吃响应的 Retry-After；没有就 60s 起、连击翻倍、封顶 15m", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    // Retry-After 90s 直接生效。
    health.recordOutcome(ID, "video", false, 50, "rate_limited", { retryAfterMs: 90_000 });
    let until = health.healthList().find((h) => h.providerId === ID)!;
    expect(until.until).toBe("2026-03-01T00:01:30.000Z");

    // 到期后再次限流且没给 Retry-After：连续命中翻倍（第一档 60s 已被上次占用 → 120s）。
    vi.setSystemTime(new Date("2026-03-01T00:01:31.000Z"));
    expect(health.isAvailable(ID, "video")).toBe(true); // 半开
    health.recordOutcome(ID, "video", false, 50, "rate_limited");
    until = health.healthList().find((h) => h.providerId === ID)!;
    expect(until.until).toBe("2026-03-01T00:03:31.000Z");

    // 成功一次归零：下一次限流回到 60s 而不是继续翻。
    vi.setSystemTime(new Date("2026-03-01T00:03:32.000Z"));
    health.claimProbe(ID, "video");
    health.recordOutcome(ID, "video", true, 80);
    health.recordOutcome(ID, "video", false, 50, "rate_limited");
    until = health.healthList().find((h) => h.providerId === ID)!;
    expect(until.until).toBe("2026-03-01T00:04:32.000Z");
  });

  it("连续 3 次 5xx 触发 5 分钟冷却 + relay_unhealthy 告警一次", async () => {
    const webhookCalls: Record<string, unknown>[] = [];
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://alerts.example/hook");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    const { resetAlertDedupe } = await import("@/lib/alerts");
    resetAlertDedupe();

    for (let i = 0; i < 2; i += 1) {
      health.recordOutcome(ID, "video", false, 50, "service_unavailable");
    }
    expect(health.isAvailable(ID, "video")).toBe(true); // 2 次还不触发

    health.recordOutcome(ID, "video", false, 50, "service_unavailable");
    expect(health.isAvailable(ID, "video")).toBe(false);
    const entry = health.healthList().find((h) => h.providerId === ID)!;
    expect(entry.state).toBe("cooldown");
    expect(entry.reason).toBe("service_unavailable");

    // 第 4 次失败不再重复告警（dedupe provider:kind）。
    health.recordOutcome(ID, "video", false, 50, "service_unavailable");
    await Promise.resolve();
    for (const call of fetchMock.mock.calls) {
      webhookCalls.push(JSON.parse(String((call[1] as { body?: unknown }).body)));
    }
    const alerts = webhookCalls.filter((b) => b.event === "relay_unhealthy");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ provider: ID, kind: "video", cooldownMs: 300_000 });
    vi.unstubAllGlobals();
  });

  it("upstream_timeout / upstream_unavailable / upstream_http_5xx 都算 transient；4xx 业务拒绝不算", () => {
    for (const code of ["upstream_timeout", "upstream_unavailable", "upstream_http_502"]) {
      health.__resetHealthForTests();
      health.recordOutcome(ID, "video", false, 50, code);
      health.recordOutcome(ID, "video", false, 50, code);
      health.recordOutcome(ID, "video", false, 50, code);
      expect(health.isAvailable(ID, "video"), code).toBe(false);
    }
    health.__resetHealthForTests();
    for (let i = 0; i < 5; i += 1) {
      health.recordOutcome(ID, "video", false, 50, "invalid_argument");
    }
    expect(health.isAvailable(ID, "video")).toBe(true);
  });
});

describe("半开恢复", () => {
  it("冷却到期半开：探路名额一次一个，探路成功清零、失败翻倍再冷却", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));

    // 进入冷却。
    for (let i = 0; i < 3; i += 1) {
      health.recordOutcome(ID, "video", false, 50, "service_unavailable");
    }
    expect(health.isAvailable(ID, "video")).toBe(false);

    // 到期 → 半开：第一个候选可用，认领后第二个就被挡。
    vi.setSystemTime(new Date("2026-04-01T00:05:01.000Z"));
    expect(health.isAvailable(ID, "video")).toBe(true);
    health.claimProbe(ID, "video");
    expect(health.isAvailable(ID, "video")).toBe(false); // 在途探路中

    // 探路失败 → 再冷却（翻倍：5m→10m）。
    health.recordOutcome(ID, "video", false, 50, "service_unavailable");
    expect(health.isAvailable(ID, "video")).toBe(false);
    const until = health.healthList().find((h) => h.providerId === ID)!;
    expect(until.until).toBe("2026-04-01T00:15:01.000Z");

    // 再次到期 → 半开，探路成功 → 清零恢复。
    vi.setSystemTime(new Date("2026-04-01T00:15:02.000Z"));
    expect(health.isAvailable(ID, "video")).toBe(true);
    health.claimProbe(ID, "video");
    health.recordOutcome(ID, "video", true, 90);
    expect(health.isAvailable(ID, "video")).toBe(true);
    expect(health.healthList().find((h) => h.providerId === ID)?.state ?? "ok").toBe("ok");
  });
});

describe("落盘延续", () => {
  it("冷却写进 data/provider-health.json，清内存后仍能挡住（重启语义）", async () => {
    vi.stubEnv("PROVIDER_EXHAUSTED_TTL_MS", "3600000");
    health.recordOutcome(ID, "video", false, 50, "quota_exhausted");
    await health.__flushHealthForTests(); // persist 是异步串行队列，等它排空而不是靶时间
    // 模拟重启：内存清零，只留盘。
    health.__resetHealthForTests();
    expect(health.isAvailable(ID, "video")).toBe(false);
    const entry = health.exhaustedList().find((e) => e.providerId === ID);
    expect(entry?.reason).toBe("quota_exhausted");
  });
});
