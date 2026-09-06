import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `markExhausted` / `isExhausted` / `exhaustedList` (契约见 AGENTS.md 高风险区域
 * `src/lib/providers/` 与本次任务书):
 *  - `markExhausted(id, kind, reason)` 写 `data/provider-state.json`；
 *  - `isExhausted(id, kind)` 在 TTL 内为 true，过期为 false；
 *  - `exhaustedList()` 只列当前仍生效的记录；
 *  - 并发标记不同 (id, kind) 的调用全部保留（`exhaustion.ts` 内的 `withLock` 序列化
 *    读-改-写，否则后写的会整份覆盖先写的——纯内存对象拼接 + 异步写盘的经典丢失更新）。
 *
 * 独立的临时 DATA_DIR：绝不能让这个文件的标记写进仓库真实的 `data/provider-state.json`。
 */
let dataRoot = "";
let markExhausted: typeof import("./exhaustion").markExhausted;
let isExhausted: typeof import("./exhaustion").isExhausted;
let exhaustedList: typeof import("./exhaustion").exhaustedList;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-exhaustion-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ markExhausted, isExhausted, exhaustedList } = await import("./exhaustion"));
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PROVIDER_EXHAUSTED_TTL_MS;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("isExhausted before anything is marked", () => {
  it("reports false for a provider/kind pair nobody has touched", () => {
    expect(isExhausted("grok", "video")).toBe(false);
  });
});

describe("markExhausted / isExhausted TTL window", () => {
  it("reports exhausted immediately after marking, and still exhausted just under the TTL", async () => {
    process.env.PROVIDER_EXHAUSTED_TTL_MS = "60000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await markExhausted("kling", "video", "积分不足");
    expect(isExhausted("kling", "video")).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:00:59.999Z"));
    expect(isExhausted("kling", "video")).toBe(true);
  });

  it("stops reporting exhausted the instant the TTL elapses", async () => {
    process.env.PROVIDER_EXHAUSTED_TTL_MS = "1000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));

    await markExhausted("yman", "image", "余额不足");
    expect(isExhausted("yman", "image")).toBe(true);

    vi.setSystemTime(new Date("2026-01-02T00:00:01.001Z"));
    expect(isExhausted("yman", "image")).toBe(false);
  });

  it("keeps the video and image channels of the same provider independent", async () => {
    process.env.PROVIDER_EXHAUSTED_TTL_MS = "60000";
    await markExhausted("yman", "video", "视频额度耗尽");

    expect(isExhausted("yman", "video")).toBe(true);
    // Marking the video channel must never bleed into the image channel of the same provider.
    expect(isExhausted("yman", "image")).toBe(false);
  });
});

describe("exhaustedList", () => {
  it("reports an active entry with its reason and computed expiry", async () => {
    process.env.PROVIDER_EXHAUSTED_TTL_MS = "60000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    await markExhausted("kling", "video", "测试原因 A");

    const entry = exhaustedList().find((e) => e.providerId === "kling" && e.kind === "video");
    expect(entry).toMatchObject({ providerId: "kling", kind: "video", reason: "测试原因 A" });
    expect(entry?.until).toBe("2026-02-01T00:01:00.000Z");
  });

  it("omits an entry once its TTL has elapsed, with no need for a fresh call to clean it up", async () => {
    process.env.PROVIDER_EXHAUSTED_TTL_MS = "500";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-02T00:00:00.000Z"));

    await markExhausted("grok", "video", "临时");
    expect(exhaustedList().some((e) => e.providerId === "grok" && e.kind === "video")).toBe(true);

    vi.setSystemTime(new Date("2026-02-02T00:00:00.600Z"));
    expect(exhaustedList().some((e) => e.providerId === "grok" && e.kind === "video")).toBe(false);
    // isExhausted must agree with exhaustedList on the same boundary.
    expect(isExhausted("grok", "video")).toBe(false);
  });
});

describe("concurrent markExhausted calls", () => {
  it("keeps all ten distinct (providerId, kind) entries when marked concurrently, none lost to a race", async () => {
    process.env.PROVIDER_EXHAUSTED_TTL_MS = "60000";
    const providers = ["grok", "mock", "kling", "yman", "openai"] as const;
    const kinds = ["video", "image"] as const;
    const pairs = providers.flatMap((p) => kinds.map((k) => [p, k] as const));
    expect(pairs).toHaveLength(10);

    // All fired together (no sequential awaiting) — this is exactly the race a naive
    // read-modify-write would lose: each call's `readState()` runs synchronously, so
    // without an internal lock every one of them would see the same empty snapshot and
    // the last write to land would stomp the other nine.
    await Promise.all(pairs.map(([p, k], i) => markExhausted(p, k, `原因-${i}`)));

    for (const [p, k] of pairs) {
      expect(isExhausted(p, k)).toBe(true);
    }
    const list = exhaustedList();
    expect(list).toHaveLength(10);
    for (const [p, k] of pairs) {
      expect(list.find((e) => e.providerId === p && e.kind === k)).toBeDefined();
    }
  });
});
