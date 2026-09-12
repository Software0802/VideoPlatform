import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 画布 DAG 运行（D 包）：报价 / 幂等 / sweep 执行器 / 取消 / 崩溃窗口接管。
 *
 * 与 `canvas.test.ts` 同口径：跑真实 `createJob`（`LUMEN_FORCE_MOCK=1`），
 * 因为「run 里的节点就是普通任务」正是要验的东西。mock 图片同步完成，
 * 视频 ~3.5s 轮询 + ffmpeg——链式用例的等待上限给足。
 */

let dataRoot = "";
let createCanvas: typeof import("./store").createCanvas;
let patchCanvas: typeof import("./store").patchCanvas;
let readCanvas: typeof import("./store").readCanvas;
let computeQuote: typeof import("./graph").computeQuote;
let validateGraph: typeof import("./graph").validateGraph;
let createCanvasRun: typeof import("./dag").createCanvasRun;
let sweepCanvasRun: typeof import("./dag").sweepCanvasRun;
let cancelCanvasRun: typeof import("./dag").cancelCanvasRun;
let readCanvasRun: typeof import("./run-store").readCanvasRun;
let updateCanvasRun: typeof import("./run-store").updateCanvasRun;
let writeCanvasRun: typeof import("./run-store").writeCanvasRun;
let newCanvasRunId: typeof import("./run-store").newCanvasRunId;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readJob: typeof import("@/lib/jobs/store").readJob;
let storeUploadFromBuffer: typeof import("@/lib/jobs/upload").storeUploadFromBuffer;
let readUploadSidecar: typeof import("@/lib/jobs/upload").readUploadSidecar;
let mediaStore: typeof import("@/lib/storage/local-fs").mediaStore;

type CanvasRun = import("./schema").CanvasRun;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-canvasrun-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createCanvas, patchCanvas, readCanvas } = await import("./store"));
  ({ computeQuote, validateGraph } = await import("./graph"));
  ({ createCanvasRun, sweepCanvasRun, cancelCanvasRun } = await import("./dag"));
  ({ readCanvasRun, updateCanvasRun, writeCanvasRun, newCanvasRunId } = await import("./run-store"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ readJob } = await import("@/lib/jobs/store"));
  ({ storeUploadFromBuffer, readUploadSidecar } = await import("@/lib/jobs/upload"));
  ({ mediaStore } = await import("@/lib/storage/local-fs"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  const { activeCount } = await import("@/lib/jobs/runner");
  for (let i = 0; i < 90; i += 1) {
    if ((await activeCount()) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(dataRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
});

async function seedUser(id: string, balanceCny = 100) {
  const now = new Date().toISOString();
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "scrypt$16384$8$1$00$00",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedJpeg(owner: string) {
  const jpeg = await sharp({
    create: { width: 4, height: 3, channels: 3, background: { r: 40, g: 60, b: 80 } },
  })
    .jpeg()
    .toBuffer();
  return storeUploadFromBuffer(jpeg, "start", owner);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 泵是自己调的（测试里不起定时器）：每轮 sweep 一次再读，直到 run 终态或超时。 */
async function runToTerminal(owner: string, runId: string, timeoutMs = 30000): Promise<CanvasRun> {
  const deadline = Date.now() + timeoutMs;
  let run = await readCanvasRun(owner, runId);
  while (run && run.status === "running" && Date.now() < deadline) {
    await sweepCanvasRun(owner, runId);
    run = await readCanvasRun(owner, runId);
    if (run?.status === "running") await sleep(250);
  }
  if (!run) throw new Error("run disappeared");
  return run;
}

describe("validateGraph / computeQuote", () => {
  it("rejects a cycle before any paid submission", async () => {
    const owner = "usr_0000000000000401";
    await seedUser(owner);
    await expect(
      validateGraph(
        {
          nodes: [
            { id: "n_aaaa0001", kind: "gen_video", x: 0, y: 0, prompt: "a" },
            { id: "n_bbbb0001", kind: "gen_video", x: 0, y: 0, prompt: "b" },
          ],
          edges: [
            { id: "e_00000001", from: "n_aaaa0001", to: "n_bbbb0001" },
            { id: "e_00000002", from: "n_bbbb0001", to: "n_aaaa0001" },
          ],
        },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects canvases over the node capacity", async () => {
    const owner = "usr_0000000000000402";
    await seedUser(owner);
    const nodes = Array.from({ length: 51 }, (_, i) => ({
      id: `n_${String(i).padStart(8, "0")}`,
      kind: "text" as const,
      x: 0,
      y: 0,
      text: "t",
    }));
    await expect(validateGraph({ nodes, edges: [] }, owner)).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
    });
  });

  it("rejects a generation node with no prompt source", async () => {
    const owner = "usr_0000000000000403";
    await seedUser(owner);
    await expect(
      validateGraph(
        { nodes: [{ id: "n_cccc0001", kind: "gen_image", x: 0, y: 0 }], edges: [] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("rejects material nodes without an upload or owned by someone else", async () => {
    const owner = "usr_0000000000000404";
    const other = "usr_0000000000000405";
    await seedUser(owner);
    await seedUser(other);
    const foreign = await seedJpeg(other);

    await expect(
      validateGraph(
        { nodes: [{ id: "n_dddd0001", kind: "material", x: 0, y: 0 }], edges: [] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });

    await expect(
      validateGraph(
        {
          nodes: [
            { id: "n_dddd0002", kind: "material", x: 0, y: 0, uploadId: foreign.uploadId },
            { id: "n_dddd0003", kind: "gen_video", x: 0, y: 0, prompt: "动" },
          ],
          edges: [{ id: "e_00000003", from: "n_dddd0002", to: "n_dddd0003" }],
        },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("quotes every generation node deterministically (same doc → same hash)", async () => {
    const owner = "usr_0000000000000406";
    await seedUser(owner);
    const doc = await createCanvas(owner, "报价");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_eeee0001", kind: "text", x: 0, y: 0, text: "提示词来源" },
        { id: "n_eeee0002", kind: "gen_image", x: 0, y: 0, prompt: "出图" },
        { id: "n_eeee0003", kind: "gen_video", x: 0, y: 0, prompt: "动起来" },
      ],
      edges: [
        { id: "e_00000004", from: "n_eeee0001", to: "n_eeee0003" },
        { id: "e_00000005", from: "n_eeee0002", to: "n_eeee0003" },
      ],
    });
    const q1 = await computeQuote(owner, patched!);
    const q2 = await computeQuote(owner, patched!);
    expect(q1.hash).toBe(q2.hash);
    expect(q1.items).toHaveLength(2);
    expect(q1.items.find((i) => i.nodeId === "n_eeee0003")?.mode).toBe("image_to_video");
    expect(q1.totalCny).toBeCloseTo(q1.items.reduce((s, i) => s + i.priceCny, 0), 2);
  });
});

describe("createCanvasRun", () => {
  it("replays the same idempotency key with identical params, conflicts on different ones", async () => {
    const owner = "usr_0000000000000410";
    await seedUser(owner);
    const doc = await createCanvas(owner, "幂等");
    await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_ff000001", kind: "gen_image", x: 0, y: 0, prompt: "图" }],
    });
    const quote = await computeQuote(owner, (await readCanvas(owner, doc.id))!);
    const key = "test-run-key-00000001";

    const first = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: key,
    });
    const again = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: key,
    });
    expect(again.replay).toBe(true);
    expect(again.run.id).toBe(first.run.id);

    const other = await createCanvas(owner, "幂等-另一张");
    await patchCanvas(owner, other.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_ff000002", kind: "gen_image", x: 0, y: 0, prompt: "图" }],
    });
    await expect(
      createCanvasRun(owner, {
        canvasId: other.id,
        quoteHash: quote.hash,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("rejects a stale quoteHash with 409 quote_stale after the canvas changed", async () => {
    const owner = "usr_0000000000000411";
    await seedUser(owner);
    const doc = await createCanvas(owner, "过期报价");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_ff000010", kind: "gen_image", x: 0, y: 0, prompt: "报价前" }],
    });
    const quote = await computeQuote(owner, patched!);
    // 报价后改图（revision 前进）→ 重算对不上。
    await patchCanvas(owner, doc.id, {
      expectedRevision: patched!.revision,
      nodes: [{ id: "n_ff000010", kind: "gen_image", x: 0, y: 0, prompt: "报价后改了提示词" }],
    });
    await expect(
      createCanvasRun(owner, {
        canvasId: doc.id,
        quoteHash: quote.hash,
        idempotencyKey: "test-run-key-00000002",
      }),
    ).rejects.toMatchObject({ status: 409, code: "quote_stale" });
  });
});

describe("sweep 执行器", () => {
  it("runs gen_image → gen_video in one run; the video consumes this run's output", async () => {
    const owner = "usr_0000000000000420";
    await seedUser(owner);
    const doc = await createCanvas(owner, "图到视频链");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_00110001", kind: "gen_image", x: 0, y: 0, prompt: "链路上游图" },
        { id: "n_00110002", kind: "gen_video", x: 300, y: 0, prompt: "让它动起来" },
      ],
      edges: [{ id: "e_00000011", from: "n_00110001", to: "n_00110002" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000003",
    });

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("succeeded");
    const img = final.nodeExecutions.find((e) => e.nodeId === "n_00110001");
    const vid = final.nodeExecutions.find((e) => e.nodeId === "n_00110002");
    expect(img?.status).toBe("succeeded");
    expect(vid?.status).toBe("succeeded");
    const vidJob = vid?.jobId ? await readJob(vid.jobId) : null;
    expect(vidJob?.mode).toBe("image_to_video");
    // run 不回写画布文档：节点上的 jobId 仍是空的，产物只活在执行位里。
    const after = await readCanvas(owner, doc.id);
    expect(after?.nodes.find((n) => n.id === "n_00110002")?.jobId).toBeUndefined();
  }, 45000);

  it("marks the node failed and propagates blocked downstream on insufficient balance", async () => {
    const owner = "usr_0000000000000421";
    await seedUser(owner, 0); // 没余额：准入拒绝必须落失败态，不是无限重试。
    const doc = await createCanvas(owner, "余额不足链");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_00220001", kind: "gen_video", x: 0, y: 0, prompt: "第一段" },
        { id: "n_00220002", kind: "gen_video", x: 300, y: 0, prompt: "第二段" },
      ],
      edges: [{ id: "e_00000022", from: "n_00220001", to: "n_00220002" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000004",
    });

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("failed");
    expect(final.nodeExecutions.find((e) => e.nodeId === "n_00220001")).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
    });
    expect(final.nodeExecutions.find((e) => e.nodeId === "n_00220002")).toMatchObject({
      status: "blocked",
      errorCode: "upstream_failed",
    });
  }, 30000);

  it("persists cancel intent: no new nodes are submitted, run settles canceled", async () => {
    const owner = "usr_0000000000000422";
    await seedUser(owner);
    const doc = await createCanvas(owner, "取消链");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_00330001", kind: "gen_image", x: 0, y: 0, prompt: "第一段" },
        { id: "n_00330002", kind: "gen_video", x: 300, y: 0, prompt: "第二段" },
      ],
      edges: [{ id: "e_00000033", from: "n_00330001", to: "n_00330002" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000005",
    });
    const canceled = await cancelCanvasRun(owner, run.id);
    expect(canceled.cancelRequestedAt).toBeTruthy();

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("canceled");
    // 下游节点绝不该拿到 jobId——取消意图落盘后泵不再提交新节点。
    const downstream = final.nodeExecutions.find((e) => e.nodeId === "n_00330002");
    expect(downstream?.jobId).toBeUndefined();
    expect(downstream?.status).toBe("blocked");
  }, 30000);

  it("adopts the existing job via idempotency key when the jobId write-back was lost", async () => {
    const owner = "usr_0000000000000423";
    await seedUser(owner);
    const doc = await createCanvas(owner, "崩溃窗口");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_00440001", kind: "gen_image", x: 0, y: 0, prompt: "接管测试" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000006",
    });

    // 等执行位拿到 jobId（建任务的异步 kick 落地）。
    let observed = await readCanvasRun(owner, run.id);
    for (let i = 0; i < 40 && !observed?.nodeExecutions[0]?.jobId; i += 1) {
      await sleep(200);
      observed = await readCanvasRun(owner, run.id);
    }
    const jobId = observed?.nodeExecutions[0]?.jobId;
    expect(jobId).toBeTruthy();

    // 模拟「建了任务没写回 jobId」的崩溃窗口：抹掉执行位的 jobId。
    await updateCanvasRun(owner, run.id, (r) => ({
      ...r,
      nodeExecutions: r.nodeExecutions.map((e) => ({ ...e, jobId: undefined, status: "ready" as const })),
    }));

    await sweepCanvasRun(owner, run.id);
    const adopted = await readCanvasRun(owner, run.id);
    // 幂等键查回同一条任务：不会建第二条、也不会撞 idempotency_conflict。
    expect(adopted?.nodeExecutions[0]?.jobId).toBe(jobId);

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("succeeded");
  }, 30000);

  it("feeds one material node into two video nodes without consuming the upload", async () => {
    const owner = "usr_0000000000000424";
    await seedUser(owner);
    const side = await seedJpeg(owner);
    const doc = await createCanvas(owner, "一素材两视频");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_00550001", kind: "material", x: 0, y: 0, uploadId: side.uploadId },
        { id: "n_00550002", kind: "gen_video", x: 300, y: 0, prompt: "甲" },
        { id: "n_00550003", kind: "gen_video", x: 300, y: 200, prompt: "乙" },
      ],
      edges: [
        { id: "e_00000055", from: "n_00550001", to: "n_00550002" },
        { id: "e_00000056", from: "n_00550001", to: "n_00550003" },
      ],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000007",
    });

    const final = await runToTerminal(owner, run.id, 45000);
    expect(final.status).toBe("succeeded");
    for (const nodeId of ["n_00550002", "n_00550003"]) {
      const exec = final.nodeExecutions.find((e) => e.nodeId === nodeId);
      const job = exec?.jobId ? await readJob(exec.jobId) : null;
      expect(job?.mode).toBe("image_to_video");
    }
    // 原始上传没有被 createJob 的 claim() 消耗：sidecar 与文件都还在。
    await expect(readUploadSidecar(side.uploadId, "start", owner)).resolves.toMatchObject({
      uploadId: side.uploadId,
    });
    expect(mediaStore).toBeTruthy();
  }, 60000);

  it("refuses to charge a price different from the confirmed quote (price_changed)", async () => {
    const owner = "usr_0000000000000425";
    await seedUser(owner);
    const doc = await createCanvas(owner, "价变拦截");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_00660001", kind: "gen_image", x: 0, y: 0, prompt: "图" }],
    });
    const quote = await computeQuote(owner, patched!);

    // 模拟「报价确认后价目变了」：run 里存的是另一份价。执行器提交前重算，
    // 对不上就必须停这条节点，而不是按新价静默扣款。
    const now = new Date().toISOString();
    const run: CanvasRun = {
      schemaVersion: 1,
      id: newCanvasRunId(),
      ownerId: owner,
      canvasId: doc.id,
      documentRevision: patched!.revision,
      graphSnapshot: { nodes: patched!.nodes, edges: patched!.edges },
      quote: {
        ...quote,
        items: quote.items.map((i) => ({ ...i, priceCny: i.priceCny + 100 })),
      },
      status: "running",
      nodeExecutions: [{ nodeId: "n_00660001", attempt: 1, status: "ready" }],
      createdAt: now,
      updatedAt: now,
    };
    await writeCanvasRun(run);
    await sweepCanvasRun(owner, run.id);

    const after = await readCanvasRun(owner, run.id);
    expect(after?.status).toBe("failed");
    expect(after?.nodeExecutions[0]).toMatchObject({ status: "failed", errorCode: "price_changed" });
  });
});
