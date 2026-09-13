import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * relay 配置源 + 装配 + 注册表影子语义的测试。
 *
 * `DATA_DIR` 指到本文件的临时目录：relays.json 的读写都在里面，不碰仓库真实 data/。
 * 注册表是进程级的，用过的测试 id（`fixture-*`）注销后进影子表仍能被 `providerForId`
 * 解析——这正是要测的行为，不是泄漏。
 */

const dataRoot = mkdtempSync(path.join(tmpdir(), "lumen-relay-test-"));
const KEY_ENV = "LUMEN_TEST_FIXTURE_RELAY_KEY";

beforeAll(() => {
  process.env.DATA_DIR = dataRoot;
  delete process.env.LUMEN_RELAYS;
});

afterAll(() => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_RELAYS;
  delete process.env[KEY_ENV];
  rmSync(dataRoot, { recursive: true, force: true });
});

function fixtureCfg(overrides: Record<string, unknown> = {}) {
  return {
    id: "fixture-relay",
    name: "Fixture Relay",
    baseUrl: "https://fixture-relay.example/v1",
    keyEnv: KEY_ENV,
    enabled: true,
    priority: 5,
    creditsPerCny: 100,
    video: {
      protocol: "openai-videos",
      defaults: {
        text_to_video: "fixture-t2v",
        image_to_video: "fixture-i2v",
        reference_to_video: "fixture-i2v",
      },
    },
    catalog: {
      source: "static",
      models: {
        "fixture-t2v": {
          durations: [5, 10],
          resolutions: ["720p"],
          ratios: ["16:9", "9:16"],
          maxReferenceImages: 0,
          credits: { resolution: { "720p": 10 }, duration: { "5": 40, "10": 90 } },
        },
        "fixture-i2v": {
          durations: [5, 10],
          resolutions: ["720p"],
          ratios: ["16:9", "9:16"],
          maxReferenceImages: 9,
          credits: { resolution: { "720p": 10 }, duration: { "5": 40, "10": 90 } },
        },
      },
    },
    ...overrides,
  };
}

function writeRelaysFile(relays: unknown[]): void {
  writeFileSync(
    path.join(dataRoot, "relays.json"),
    JSON.stringify({ schemaVersion: 1, relays }, null, 2),
    "utf8",
  );
}

describe("relayConfigSchema", () => {
  it("接受合法配置并补默认值", async () => {
    const { relayConfigSchema } = await import("./config");
    const parsed = relayConfigSchema.parse(fixtureCfg());
    expect(parsed.id).toBe("fixture-relay");
    expect(parsed.enabled).toBe(true);
    expect(parsed.priority).toBe(5);
    expect(parsed.video?.defaults.text_to_video).toBe("fixture-t2v");
  });

  it("拒绝非法 id / 内建 id / 缺 keyEnv", async () => {
    const { relayConfigSchema } = await import("./config");
    expect(relayConfigSchema.safeParse(fixtureCfg({ id: "Bad_Id" })).success).toBe(false);
    expect(relayConfigSchema.safeParse(fixtureCfg({ id: "kling" })).success).toBe(false);
    expect(relayConfigSchema.safeParse(fixtureCfg({ id: "grok" })).success).toBe(false);
    expect(relayConfigSchema.safeParse(fixtureCfg({ id: "mock" })).success).toBe(false);
    const noKey = fixtureCfg();
    delete (noKey as Record<string, unknown>).keyEnv;
    expect(relayConfigSchema.safeParse(noKey).success).toBe(false);
    // yman / openai 是合法的 relay id（预设就由折算产生）。
    expect(relayConfigSchema.safeParse(fixtureCfg({ id: "yman" })).success).toBe(true);
    expect(relayConfigSchema.safeParse(fixtureCfg({ id: "openai" })).success).toBe(true);
  });
});

describe("loadRelaysDetailed", () => {
  it("没有文件也没有 LUMEN_RELAYS 时回落老 env 折算（yman + openai 预设）", async () => {
    const { loadRelaysDetailed, relaysFileExists } = await import("./config");
    expect(relaysFileExists()).toBe(false);
    const { relays, source } = loadRelaysDetailed();
    expect(source).toBe("legacy");
    expect(relays.map((r) => r.id).sort()).toEqual(["openai", "yman"]);
    // 折算结果不写文件。
    expect(relaysFileExists()).toBe(false);
  });

  it("LUMEN_RELAYS 作种子写入文件，之后以文件为准", async () => {
    const { loadRelaysDetailed, relaysFileExists } = await import("./config");
    process.env.LUMEN_RELAYS = JSON.stringify([fixtureCfg({ id: "fixture-seed" })]);
    const seeded = loadRelaysDetailed();
    expect(seeded.source).toBe("env-seed");
    expect(seeded.relays.map((r) => r.id)).toContain("fixture-seed");
    expect(relaysFileExists()).toBe(true);
    // 文件已存在：env 再换内容也不再生效。
    process.env.LUMEN_RELAYS = JSON.stringify([fixtureCfg({ id: "fixture-ignored" })]);
    const again = loadRelaysDetailed();
    expect(again.source).toBe("file");
    expect(again.relays.map((r) => r.id)).toContain("fixture-seed");
    expect(again.relays.map((r) => r.id)).not.toContain("fixture-ignored");
    delete process.env.LUMEN_RELAYS;
  });
});

describe("reconcileRelays / 注册表影子语义", () => {
  it("写文件 → 注册；删配置 → 路由不可见但 providerForId 仍可解析", async () => {
    const { reconcileRelays } = await import("./assemble");
    const { isRegisteredProviderId, providerForId, hasProviderKey } = await import(
      "@/lib/providers/registry"
    );
    const { downloadHeadersFor } = await import("@/lib/media/download-headers");

    // 一：文件里有 fixture-relay → reconcile 后注册。
    writeRelaysFile([fixtureCfg()]);
    reconcileRelays();
    expect(isRegisteredProviderId("fixture-relay")).toBe(true);
    const provider = providerForId("fixture-relay");
    expect(provider.capabilities().modes).toEqual([
      "text_to_video",
      "image_to_video",
      "reference_to_video",
    ]);

    // 二：keyEnv 指向的变量没配 → hasKey false，不参与路由。
    expect(hasProviderKey("fixture-relay")).toBe(false);

    // 三：配上 key → hasKey true；下载头只发给它自己的 origin。
    process.env[KEY_ENV] = "fixture-secret";
    expect(hasProviderKey("fixture-relay")).toBe(true);
    expect(
      downloadHeadersFor("https://fixture-relay.example/videos/x/content", "fixture-relay"),
    ).toEqual({ Authorization: "Bearer fixture-secret" });
    // 别的 origin 不给它的 key；别的 provider 的任务也不给它。
    expect(
      downloadHeadersFor("https://evil.example/videos/x/content", "fixture-relay"),
    ).toEqual({});
    expect(downloadHeadersFor("https://fixture-relay.example/videos/x/content", "kling")).toEqual(
      {},
    );

    // 四：从文件里删掉 → 注销：新路由不可见，老任务仍可解析。
    writeRelaysFile([]);
    reconcileRelays();
    expect(isRegisteredProviderId("fixture-relay")).toBe(false);
    expect(providerForId("fixture-relay")).toBe(provider); // 影子表：同一个对象
  });

  it("enabled=false 的 relay 不注册（路由不可见），改动配置会替换对象", async () => {
    const { reconcileRelays } = await import("./assemble");
    const { isRegisteredProviderId, providerForId } = await import("@/lib/providers/registry");

    writeRelaysFile([fixtureCfg({ id: "fixture-toggle" })]);
    reconcileRelays();
    expect(isRegisteredProviderId("fixture-toggle")).toBe(true);
    const first = providerForId("fixture-toggle");

    writeRelaysFile([fixtureCfg({ id: "fixture-toggle", enabled: false })]);
    reconcileRelays();
    expect(isRegisteredProviderId("fixture-toggle")).toBe(false);
    expect(providerForId("fixture-toggle")).toBe(first); // 影子表解析老对象

    writeRelaysFile([fixtureCfg({ id: "fixture-toggle", priority: 9 })]);
    reconcileRelays();
    expect(isRegisteredProviderId("fixture-toggle")).toBe(true);
    expect(providerForId("fixture-toggle")).not.toBe(first); // 配置变了 → 新对象
  });
});

describe("隐式 ORDER（无显式 VIDEO_PROVIDER_ORDER 时）", () => {
  it("启用的 relay 按 priority 降序排在内置默认之后", async () => {
    const { reconcileRelays } = await import("./assemble");
    const { effectiveVideoProviderOrder } = await import("@/lib/providers/router");

    delete process.env.VIDEO_PROVIDER_ORDER;
    delete process.env.VIDEO_PROVIDER;
    writeRelaysFile([
      fixtureCfg({ id: "fixture-low", priority: 1 }),
      fixtureCfg({ id: "fixture-high", priority: 50 }),
      fixtureCfg({ id: "fixture-off", enabled: false, priority: 99 }),
    ]);
    reconcileRelays();
    const order = effectiveVideoProviderOrder();
    // 内置默认（grok）在前，relay 按 priority 降序在后，disabled 的不进次序。
    expect(order[0]).toBe("grok");
    expect(order.indexOf("fixture-high")).toBeLessThan(order.indexOf("fixture-low"));
    expect(order).not.toContain("fixture-off");
    // env 折算的 yman / openai 预设不进隐式次序。
    expect(order).not.toContain("yman");

    // 显式 ORDER 时 relay 不自动追加（生产就是这条路径）。
    process.env.VIDEO_PROVIDER_ORDER = "kling,fixture-low";
    expect(effectiveVideoProviderOrder()).toEqual(["kling", "fixture-low"]);
    delete process.env.VIDEO_PROVIDER_ORDER;
  });
});
