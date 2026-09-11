import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobRecord, JobStatus } from "./schema";

/**
 * 恢复中心（A 包）：`uncertain_submit` 的任务由用户手工核验推进。
 *
 * 契约：
 *  - `recoveryFor`：只有 `failed + uncertain_submit` 且供应商能按外部单号查询的
 *    任务给 `reconcile`；非终态任务给 `resume`；带 remoteId 的过期任务也给 `resume`。
 *  - `reconcileJob`：查到远端单 → 接管成 pending 入队；上游确认无此单 → 标记降级
 *    为普通失败、一键重试解锁；查询本身失败 → 409 且标记保留。
 *  - `resumeJob`：非终态重新入队；expired + remoteId → 转回 pending 续轮询。
 */

let dataRoot = "";
let recoveryFor: typeof import("./recovery").recoveryFor;
let reconcileJob: typeof import("./recovery").reconcileJob;
let resumeJob: typeof import("./recovery").resumeJob;
let readJob: typeof import("./store").readJob;
let writeJob: typeof import("./store").writeJob;
let retryBlock: typeof import("./retry-guard").retryBlock;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-recovery-"));
  process.env.DATA_DIR = dataRoot;
  process.env.VIDEO_PROVIDER_ORDER = "kling";
  process.env.KLING_API_KEY = "kling-test-key";
  ({ recoveryFor, reconcileJob, resumeJob } = await import("./recovery"));
  ({ readJob, writeJob } = await import("./store"));
  ({ retryBlock } = await import("./retry-guard"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.VIDEO_PROVIDER_ORDER;
  delete process.env.KLING_API_KEY;
  await rm(dataRoot, { recursive: true, force: true });
});

const OWNER = "usr_00000000000000ff";

function job(status: JobStatus, patch: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `job_${randomBytes(6).toString("hex")}`,
    ownerId: OWNER,
    status,
    progress: 0,
    mode: "text_to_video",
    model: "kling-2.6",
    provider: "kling",
    prompt: "恢复中心测试",
    durationSec: 5,
    aspectRatio: "16:9",
    resolution: "720p",
    imageResolution: null,
    generateAudio: false,
    lastFrameStored: false,
    lastFrameLocksOutput: false,
    harness: { enabled: false },
    priceCny: 3,
    costUsdEstimate: 0.16,
    costUsdActual: null,
    error: null,
    output: null,
    createdAt: now,
    updatedAt: now,
    bible: null,
    shots: null,
    assets: {},
    ...patch,
  };
}

const UNCERTAIN = {
  code: "uncertain_submit",
  message: "任务中断在提交后、远端 id 落盘前，上游可能已接单，为避免重复计费不再自动重试",
};

describe("recoveryFor", () => {
  it("failed + uncertain_submit + 可灵 → 允许 reconcile", async () => {
    const rec = job("failed", { error: { ...UNCERTAIN } });
    expect(recoveryFor(rec).actions).toEqual(["reconcile"]);
  });

  it("uncertain_submit 但供应商不能查（mock）→ 只给原因、不给动作", async () => {
    const rec = job("failed", { provider: "mock", model: "mock", error: { ...UNCERTAIN } });
    const r = recoveryFor(rec);
    expect(r.actions).toEqual([]);
    expect(r.reason).toContain("人工核对");
  });

  it("非终态 → resume；普通失败 → 空", () => {
    expect(recoveryFor(job("pending")).actions).toEqual(["resume"]);
    expect(recoveryFor(job("queued")).actions).toEqual(["resume"]);
    expect(recoveryFor(job("failed", { error: { code: "kling_9999", message: "x" } })).actions).toEqual([]);
    expect(recoveryFor(job("succeeded")).actions).toEqual([]);
  });

  it("expired 且带 remoteId → resume（还能把放弃的轮询续上）", () => {
    expect(recoveryFor(job("expired", { remoteId: "kling_remote_1" })).actions).toEqual(["resume"]);
    expect(recoveryFor(job("expired")).actions).toEqual([]);
  });
});

describe("reconcileJob", () => {
  it("上游认领外部单号 → 接管成 pending 并入队", async () => {
    const rec = job("failed", { error: { ...UNCERTAIN } });
    await writeJob(rec);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("external_task_ids=")) {
        return new Response(JSON.stringify({ code: 0, data: [{ id: "kling_remote_9", status: "processing" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call: ${url}`);
    }));

    const { job: next, outcome } = await reconcileJob(rec.id);
    expect(outcome).toBe("resumed");
    expect(next.status).toBe("pending");
    const stored = await readJob(rec.id);
    expect(stored?.remoteId).toBe("kling_remote_9");
    expect(stored?.error).toBeNull();

    // 收尾：别让后台 pump 的轮询继续打桩跑下去。
    await import("./store").then(({ updateJob }) =>
      updateJob(rec.id, (r) => {
        r.status = "canceled";
        r.canceled = true;
        r.error = { code: "canceled", message: "test cleanup" };
        return r;
      }),
    );
  });

  it("上游确认无此单 → 降级为普通失败，一键重试解锁", async () => {
    const rec = job("failed", { error: { ...UNCERTAIN } });
    await writeJob(rec);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("external_task_ids=")) {
        return new Response(JSON.stringify({ code: 0, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call: ${url}`);
    }));

    const { job: next, outcome } = await reconcileJob(rec.id);
    expect(outcome).toBe("not_found");
    expect(next.status).toBe("failed");
    const stored = await readJob(rec.id);
    expect(stored?.error?.code).toBe("submit_not_accepted");
    // 上游证明单子没建出来 → 重试出来的新任务不会重复计费，锁解除。
    expect(retryBlock(stored!)).toBeNull();
  });

  it("查询本身挂了 → 409 reconcile_failed，标记原样保留", async () => {
    const rec = job("failed", { error: { ...UNCERTAIN } });
    await writeJob(rec);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    await expect(reconcileJob(rec.id)).rejects.toMatchObject({ status: 409, code: "reconcile_failed" });
    expect((await readJob(rec.id))?.error?.code).toBe("uncertain_submit");
  });

  it("状态不对 / 供应商不能查 → 409", async () => {
    const pending = job("pending");
    await writeJob(pending);
    await expect(reconcileJob(pending.id)).rejects.toMatchObject({ status: 409, code: "conflict" });

    const mockUncertain = job("failed", { provider: "mock", model: "mock", error: { ...UNCERTAIN } });
    await writeJob(mockUncertain);
    await expect(reconcileJob(mockUncertain.id)).rejects.toMatchObject({ status: 409, code: "not_supported" });
  });
});

describe("resumeJob", () => {
  it("非终态任务重新入队；expired + remoteId 转回 pending", async () => {
    // 两个用例都会把任务重新入队、后台 pump 跟着开始轮询——桩全程答「还在跑」。
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("task_ids=")) {
        return new Response(JSON.stringify({ code: 0, data: [{ id: "kling_remote_x", status: "processing" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream call: ${url}`);
    }));

    const pending = job("pending", { remoteId: "kling_remote_2" });
    await writeJob(pending);
    const back = await resumeJob(pending.id);
    expect(back.status).toBe("pending");

    const expired = job("expired", { remoteId: "kling_remote_3" });
    await writeJob(expired);
    const resumed = await resumeJob(expired.id);
    expect(resumed.status).toBe("pending");

    const { updateJob } = await import("./store");
    for (const id of [pending.id, expired.id]) {
      await updateJob(id, (r) => {
        r.status = "canceled";
        r.canceled = true;
        r.error = { code: "canceled", message: "test cleanup" };
        return r;
      });
    }
  });

  it("终态其余情况 409：成功 / 取消 / 无 remoteId 的过期", async () => {
    for (const rec of [job("succeeded"), job("canceled"), job("expired")]) {
      await writeJob(rec);
      await expect(resumeJob(rec.id)).rejects.toMatchObject({ status: 409, code: "conflict" });
    }
  });
});
