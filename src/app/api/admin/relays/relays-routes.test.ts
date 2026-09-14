import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * `/api/admin/relays` 路由测试：直接调 handler（与 jobs-routes.test.ts 同一套
 * session cookie 构造），`DATA_DIR` 指临时目录，relays.json 与目录快照都在里面。
 */

const SESSION_SECRET = "relays-routes-test-secret-0123456789";
const KEY_ENV = "LUMEN_TEST_ADMIN_RELAY_KEY";

let dataRoot = "";
let writeUser: typeof import("@/lib/users/store").writeUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;

let GET_LIST: typeof import("./route").GET;
let POST_CREATE: typeof import("./route").POST;
let PATCH_ONE: typeof import("./[id]/route").PATCH;
let DELETE_ONE: typeof import("./[id]/route").DELETE;
let POST_DISCOVER: typeof import("./[id]/discover/route").POST;
let POST_PROBE: typeof import("./[id]/probe/route").POST;

let adminUser: UserRecord;
let normalUser: UserRecord;

/** USER_ID_RE 要求 usr_ + 恰好 16 位小写 hex——把标签 hex 编码后截尾。 */
function userId(tag: string): string {
  return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
}

const ADMIN = userId("relay-admin");
const NORMAL = userId("relay-normal");

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-relays-routes-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  process.env.LUMEN_ADMIN_USER_ID = ADMIN;
  ({ writeUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ GET: GET_LIST, POST: POST_CREATE } = await import("./route"));
  ({ PATCH: PATCH_ONE, DELETE: DELETE_ONE } = await import("./[id]/route"));
  ({ POST: POST_DISCOVER } = await import("./[id]/discover/route"));
  ({ POST: POST_PROBE } = await import("./[id]/probe/route"));
  adminUser = await seedUser(ADMIN);
  normalUser = await seedUser(NORMAL);
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  delete process.env.LUMEN_ADMIN_USER_ID;
  delete process.env[KEY_ENV];
  vi.unstubAllGlobals();
  await rm(dataRoot, { recursive: true, force: true });
});

async function seedUser(id: string): Promise<UserRecord> {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function req(user: UserRecord | null, init: RequestInit = {}, url = "http://t/api/admin/relays") {
  const headers = new Headers(init.headers);
  if (user) headers.set("cookie", `${SESSION_COOKIE}=${issueSessionValue(user)}`);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers });
}

const paramsOf = (id: string) => ({ params: Promise.resolve({ id }) });

function fixtureBody(over: Record<string, unknown> = {}) {
  return {
    id: "fixture-admin",
    name: "Fixture Admin Relay",
    baseUrl: "https://fixture-admin.example/v1",
    keyEnv: KEY_ENV,
    priority: 3,
    video: {
      protocol: "openai-videos",
      defaults: { text_to_video: "fx-t2v", image_to_video: "fx-i2v" },
    },
    catalog: { source: "models-endpoint", models: {} },
    ...over,
  };
}

describe("鉴权", () => {
  it("未登录 401 / 非管理员 404", async () => {
    const normal = normalUser;
    const anon = await GET_LIST(req(null));
    expect(anon.status).toBe(401);
    const denied = await GET_LIST(req(normal));
    expect(denied.status).toBe(404);
  });
});

describe("CRUD", () => {
  it("POST → GET 列表可见（hasKey=false、不回显 key）；PATCH enabled；DELETE", async () => {
    const admin = adminUser;

    const created = await POST_CREATE(
      req(admin, { method: "POST", body: JSON.stringify(fixtureBody()) }),
    );
    expect(created.status).toBe(201);
    const { relay } = (await created.json()) as { relay: { id: string; hasKey: boolean } };
    expect(relay.id).toBe("fixture-admin");
    expect(relay.hasKey).toBe(false);
    // 响应不回显 key 值。
    expect(JSON.stringify(relay)).not.toContain("secret");

    const listed = await GET_LIST(req(admin));
    const { relays } = (await listed.json()) as {
      relays: { id: string; enabled: boolean; registered: boolean; managed: boolean }[];
    };
    const row = relays.find((r) => r.id === "fixture-admin");
    expect(row?.managed).toBe(true);
    expect(row?.enabled).toBe(true);
    expect(row?.registered).toBe(true);
    // env 预设也在列表里。
    expect(relays.some((r) => r.id === "yman")).toBe(true);

    const patched = await PATCH_ONE(
      req(admin, { method: "PATCH", body: JSON.stringify({ enabled: false }) }, "http://t/x"),
      paramsOf("fixture-admin"),
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { relay: { registered: boolean } }).relay.registered).toBe(
      false,
    );

    // env 预设不由接口管理。
    const patchPreset = await PATCH_ONE(
      req(admin, { method: "PATCH", body: JSON.stringify({ enabled: false }) }, "http://t/x"),
      paramsOf("yman"),
    );
    expect(patchPreset.status).toBe(404);

    const removed = await DELETE_ONE(
      req(admin, { method: "DELETE" }, "http://t/x"),
      paramsOf("fixture-admin"),
    );
    expect(removed.status).toBe(204);
    const after = await GET_LIST(req(admin));
    expect(
      ((await after.json()) as { relays: { id: string }[] }).relays.some(
        (r) => r.id === "fixture-admin",
      ),
    ).toBe(false);

    // 注销后历史任务仍可解析（影子表）。
    const { providerForId, isRegisteredProviderId } = await import("@/lib/providers/registry");
    expect(isRegisteredProviderId("fixture-admin")).toBe(false);
    expect(providerForId("fixture-admin").id).toBe("fixture-admin");
  });

  it("PATCH catalog.models 是部分更新：只换给到的键，null 删除该模型的配置覆盖", async () => {
    const admin = adminUser;
    const created = await POST_CREATE(
      req(admin, {
        method: "POST",
        body: JSON.stringify(
          fixtureBody({
            id: "fixture-patch",
            catalog: {
              source: "static",
              models: {
                "m-a": {
                  durations: [5],
                  resolutions: ["720p"],
                  ratios: ["16:9"],
                  maxReferenceImages: 0,
                  price: { video: { "5": 2, "10": 4 } },
                },
                "m-b": {
                  durations: [5],
                  resolutions: ["720p"],
                  ratios: ["16:9"],
                  maxReferenceImages: 0,
                },
                "m-c": { hidden: true },
              },
            },
          }),
        ),
      }),
    );
    expect(created.status).toBe(201);

    const res = await PATCH_ONE(
      req(admin, {
        method: "PATCH",
        body: JSON.stringify({
          catalog: {
            models: {
              // 整键替换：m-a 变成只有 name + price。
              "m-a": { name: "改名档", price: { video: { "5": 6, "10": 9 } } },
              "m-c": null,
            },
          },
        }),
      }, "http://t/x"),
      paramsOf("fixture-patch"),
    );
    expect(res.status).toBe(200);
    const { relay } = (await res.json()) as {
      relay: {
        catalog: {
          source: string;
          models: {
            id: string;
            name?: string;
            price?: { video?: Record<string, number> };
            listed: boolean;
            fromConfig: boolean;
          }[];
        };
      };
    };
    const models = relay.catalog.models;
    const a = models.find((m) => m.id === "m-a");
    expect(a?.name).toBe("改名档");
    expect(a?.price?.video?.["5"]).toBe(6);
    expect(a?.listed).toBe(true); // 5s/10s 都给了 → 上架
    expect(models.some((m) => m.id === "m-b")).toBe(true); // 没给的键原样保留
    expect(models.some((m) => m.id === "m-c")).toBe(false); // null 删掉了唯一来源（配置）

    // 落盘验证：m-c 的覆盖没了，m-b 没被动过。
    const { readRelaysFile } = await import("@/lib/providers/relay/config");
    const file = readRelaysFile().find((r) => r.id === "fixture-patch");
    expect(file?.catalog?.models["m-c"]).toBeUndefined();
    expect(file?.catalog?.models["m-b"]).toBeDefined();
    expect(file?.catalog?.models["m-a"]?.name).toBe("改名档");

    await DELETE_ONE(req(admin, { method: "DELETE" }, "http://t/x"), paramsOf("fixture-patch"));
  });

  it("schema 校验失败 400、重复 id 409", async () => {
    const admin = adminUser;
    const bad = await POST_CREATE(
      req(admin, { method: "POST", body: JSON.stringify(fixtureBody({ id: "BAD!" })) }),
    );
    expect(bad.status).toBe(400);
    const first = await POST_CREATE(
      req(admin, { method: "POST", body: JSON.stringify(fixtureBody({ id: "fixture-dup" })) }),
    );
    expect(first.status).toBe(201);
    const dup = await POST_CREATE(
      req(admin, { method: "POST", body: JSON.stringify(fixtureBody({ id: "fixture-dup" })) }),
    );
    expect(dup.status).toBe(409);
    await DELETE_ONE(req(admin, { method: "DELETE" }, "http://t/x"), paramsOf("fixture-dup"));
  });
});

describe("discover / probe", () => {
  it("discover 拉 /models 写快照并返回 diff", async () => {
    const admin = adminUser;
    process.env[KEY_ENV] = "probe-secret";
    await POST_CREATE(
      req(admin, { method: "POST", body: JSON.stringify(fixtureBody({ id: "fixture-disc" })) }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ id: "fx-t2v" }, { id: "fx-new" }, { id: "fx-other" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const res = await POST_DISCOVER(
      req(admin, { method: "POST" }, "http://t/x"),
      paramsOf("fixture-disc"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: string[];
      diff: { added: string[]; removed: string[] };
      fetchedAt: string;
    };
    expect(body.models).toContain("fx-new");
    expect(body.diff.added).toContain("fx-new");
    expect(body.fetchedAt).toBeTruthy();

    // 快照合并进目录：models-endpoint 的 relay 现在认得 fx-new。
    const { relayViewFor } = await import("@/lib/providers/relay/live");
    const view = relayViewFor("fixture-disc");
    expect(view?.catalog?.isKnownModel("fx-new")).toBe(true);
    expect(view?.catalog?.isKnownModel("fx-t2v")).toBe(true); // 快照 ∪ 配置
  });

  it("probe：生图通道 stub 200 → ok；缺 key → 400", async () => {
    const admin = adminUser;
    // fixture-disc 没配 image，给它一条带 image 的。
    await POST_CREATE(
      req(admin, {
        method: "POST",
        body: JSON.stringify(
          fixtureBody({
            id: "fixture-probe",
            image: { protocol: "openai-images", model: "img-1" },
          }),
        ),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const res = await POST_PROBE(
      req(admin, { method: "POST" }, "http://t/x"),
      paramsOf("fixture-probe"),
    );
    const body = (await res.json()) as { ok: boolean; billed: boolean; kind: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.billed).toBe(false);
    expect(body.kind).toBe("image");

    delete process.env[KEY_ENV];
    const noKey = await POST_PROBE(
      req(admin, { method: "POST" }, "http://t/x"),
      paramsOf("fixture-probe"),
    );
    expect(noKey.status).toBe(400);
  });
});
