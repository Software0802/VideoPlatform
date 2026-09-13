import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "./schema";

/**
 * R06 端到端：submit 的「结果不确定」失败（读超时 / 断连 / 上游 5xx）不能再按
 * 「确定没计费」处理——重发就是把同一条片子再付一次钱。
 *
 * 契约（`runner.ts` 的 `resolveAmbiguousSubmit`）：
 *  - provider 支持 `lookupByExternalId` 且查得回 → 接管成 pending 继续轮询；
 *  - 查不到 / 不支持 / 查询也挂了 → failed + `uncertain_submit`，`retryBlock` 锁死重试；
 *  - 4xx 业务拒绝与内部错误不在此列，照旧走原来的失败路径。
 *
 * 与 `failover.test.ts` 同一套驱动方式：`createJob` 起真 runner，`global.fetch` 打桩。
 */

const TEST_OWNER_PREFIX = "usr_";

let dataRoot = "";
let createJob: typeof import("./create").createJob;
let retryJob: typeof import("./create").retryJob;
let readJob: typeof import("./store").readJob;
let updateJob: typeof import("./store").updateJob;
let retryBlock: typeof import("./retry-guard").retryBlock;

function owner(tag: string): string {
  return `${TEST_OWNER_PREFIX}${tag.padStart(16, "0")}`;
}

async function seedBalance(id: string, balanceCny: number) {
  const { writeUser } = await import("@/lib/users/store");
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

async function waitUntil(
  id: string,
  predicate: (rec: JobRecord) => boolean,
  timeoutMs = 10_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readJob(id);
    if (rec && predicate(rec)) return rec;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const rec = await readJob(id);
  throw new Error(`job ${id} never matched the predicate; last=${JSON.stringify(rec?.status)}/${JSON.stringify(rec?.error)}`);
}

function videoBody() {
  return {
    mode: "text_to_video",
    prompt: "海边栈道，长镜头",
    durationSec: 5,
    aspectRatio: "16:9",
    generateAudio: false,
  } as Parameters<typeof createJob>[0];
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-uncertain-submit-"));
  process.env.DATA_DIR = dataRoot;
  process.env.UPSTREAM_RETRY_BASE_MS = "1";
  ({ createJob, retryJob } = await import("./create"));
  ({ readJob, updateJob } = await import("./store"));
  ({ retryBlock } = await import("./retry-guard"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.VIDEO_PROVIDER_ORDER;
  delete process.env.IMAGE_PROVIDER_ORDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KLING_API_KEY;
  delete process.env.XAI_API_KEY;
  process.env.LUMEN_FORCE_MOCK = "1";
  await rm(path.join(dataRoot, "provider-state.json"), { force: true });
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.UPSTREAM_RETRY_BASE_MS;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

function klingTask(id: string, status = "processing") {
  return new Response(JSON.stringify({ code: 0, data: [{ id, status }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("R06：提交结果不确定的恢复", () => {
  it("断连后 lookupByExternalId 查回任务：接管成 pending 继续轮询，不重发 POST", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    const id = owner("a1");
    await seedBalance(id, 1000);

    let postCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("klingai.com")) {
        if (method === "POST") {
          postCalls += 1;
          // 断在半途的网络错误：请求可能已送达，也可能没有。
          throw new TypeError("fetch failed");
        }
        if (url.includes("external_task_ids=")) return klingTask("kling_remote_9");
        if (url.includes("task_ids=")) return klingTask("kling_remote_9");
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(videoBody(), id);
    expect(job.provider).toBe("kling");

    // 接管成功后任务回到 pending 并带着查回的 remoteId——它会在上游照常出片计费。
    const resumed = await waitUntil(
      job.id,
      (rec) => rec.status === "pending" && rec.remoteId === "kling_remote_9",
    );
    expect(resumed.status).toBe("pending");
    // 关键不变量：创建 POST 只发了一次，重试被 lookup 取代而不是重发。
    expect(postCalls).toBe(1);

    await updateJob(job.id, (r) => {
      r.status = "canceled";
      r.canceled = true;
      r.error = { code: "canceled", message: "test cleanup" };
      return r;
    });
  });

  it("lookup 查不到：failed + uncertain_submit，一键重试被锁死", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    const id = owner("a2");
    await seedBalance(id, 1000);

    let postCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("klingai.com")) {
        if (method === "POST") {
          postCalls += 1;
          throw new TypeError("fetch failed");
        }
        // 上游明确说「没有这个外部单号」。
        return new Response(JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(videoBody(), id);
    const settled = await waitUntil(job.id, (rec) => rec.status === "failed");
    expect(settled.error?.code).toBe("uncertain_submit");
    expect(postCalls).toBe(1);

    // 可能已付费的单子不许一键重试（retry-guard 的既有契约）。
    expect(retryBlock(settled)?.code).toBe("uncertain_submit");
    await expect(retryJob(settled, id)).rejects.toMatchObject({ status: 409 });
  });

  it("上游 5xx 应答同样算不确定（kling internal_error），不是「确定失败」", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    const id = owner("a3");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("klingai.com")) {
        if (method === "POST") {
          // 可灵内部错误码 5000 → ProviderHttpError(500, "internal_error")。
          return new Response(JSON.stringify({ code: 5000, message: "服务内部错误" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(videoBody(), id);
    const settled = await waitUntil(job.id, (rec) => rec.status === "failed");
    expect(settled.error?.code).toBe("uncertain_submit");
    expect(settled.error?.detail).toContain("服务内部错误");
  });

  it("provider 没有 lookup 能力（grok）时直接按 uncertain_submit 结", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "grok";
    process.env.XAI_API_KEY = "xai-test-key";
    const id = owner("a4");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(videoBody(), id);
    const settled = await waitUntil(job.id, (rec) => rec.status === "failed");
    expect(settled.error?.code).toBe("uncertain_submit");
    expect(retryBlock(settled)?.code).toBe("uncertain_submit");
  });

  it("4xx 业务拒绝不在此列：照原错误码失败，重试不被锁", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.VIDEO_PROVIDER_ORDER = "kling";
    process.env.KLING_API_KEY = "kling-test-key";
    const id = owner("a5");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("klingai.com") && method === "POST") {
        // HTTP 200 但业务码非 0 且不在映射表里 → klingError 按 400 记（确定拒绝）。
        return new Response(JSON.stringify({ code: 9999, message: "参数不合法" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(videoBody(), id);
    const settled = await waitUntil(job.id, (rec) => rec.status === "failed");
    expect(settled.error?.code).toBe("kling_9999");
    expect(settled.error?.code).not.toBe("uncertain_submit");
    expect(retryBlock(settled)).toBeNull();
  });

  it("结构化 5xx 应答是确定拒单：普通失败、不锁重试（openai-image 通道）", async () => {
    delete process.env.LUMEN_FORCE_MOCK;
    process.env.IMAGE_PROVIDER_ORDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-busy";
    const id = owner("a6");
    await seedBalance(id, 1000);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("openai.com")) {
        // ccgoai 实测形状：HTTP 503 + 合法 OpenAI 错误信封 = 明确拒单、未计费。
        return new Response(
          JSON.stringify({
            error: { code: "service_busy", type: "api_error", message: "当前服务繁忙 (Ref abc)" },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected upstream call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { job } = await createJob(
      { mode: "text_to_image", prompt: "海报", aspectRatio: "16:9" },
      id,
    );
    const settled = await waitUntil(job.id, (rec) => rec.status === "failed");
    expect(settled.error?.code).toBe("service_busy");
    expect(settled.error?.code).not.toBe("uncertain_submit");
    expect(settled.error?.detail ?? settled.error?.message).toContain("当前服务繁忙");
    expect(retryBlock(settled)).toBeNull();
  });
});
