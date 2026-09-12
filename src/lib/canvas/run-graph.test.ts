import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 画布 DAG 运行（D 包）：报价 / 幂等 / sweep 执行器 / 取消 / 崩溃窗口接管；
 * 切片二：run 级预算预留 / 份额转移 / 审批门 / 产物复用 / 强制重跑。
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
let expandRegenerate: typeof import("./graph").expandRegenerate;
let createCanvasRun: typeof import("./dag").createCanvasRun;
let sweepCanvasRun: typeof import("./dag").sweepCanvasRun;
let cancelCanvasRun: typeof import("./dag").cancelCanvasRun;
let decideCanvasRunApproval: typeof import("./dag").decideCanvasRunApproval;
let resolveReuseForQuote: typeof import("./dag").resolveReuseForQuote;
let readCanvasRun: typeof import("./run-store").readCanvasRun;
let updateCanvasRun: typeof import("./run-store").updateCanvasRun;
let writeCanvasRun: typeof import("./run-store").writeCanvasRun;
let newCanvasRunId: typeof import("./run-store").newCanvasRunId;
let listCanvasRuns: typeof import("./run-store").listCanvasRuns;
let canvasRunsUserDir: typeof import("./run-store").canvasRunsUserDir;
let runHeldFunds: typeof import("./run-store").runHeldFunds;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readJob: typeof import("@/lib/jobs/store").readJob;
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let listJobIndex: typeof import("@/lib/jobs/index").listJobIndex;
let loadBalanceUsage: typeof import("@/lib/billing/admission").loadBalanceUsage;
let storeUploadFromBuffer: typeof import("@/lib/jobs/upload").storeUploadFromBuffer;
let readUploadSidecar: typeof import("@/lib/jobs/upload").readUploadSidecar;
let mediaStore: typeof import("@/lib/storage/local-fs").mediaStore;

type CanvasRun = import("./schema").CanvasRun;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-canvasrun-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ createCanvas, patchCanvas, readCanvas } = await import("./store"));
  ({ computeQuote, validateGraph, expandRegenerate } = await import("./graph"));
  ({
    createCanvasRun,
    sweepCanvasRun,
    cancelCanvasRun,
    decideCanvasRunApproval,
    resolveReuseForQuote,
  } = await import("./dag"));
  ({
    readCanvasRun,
    updateCanvasRun,
    writeCanvasRun,
    newCanvasRunId,
    listCanvasRuns,
    canvasRunsUserDir,
    runHeldFunds,
  } = await import("./run-store"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ readJob, writeJob } = await import("@/lib/jobs/store"));
  ({ listJobIndex } = await import("@/lib/jobs/index"));
  ({ loadBalanceUsage } = await import("@/lib/billing/admission"));
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

  it("rejects run creation with 402 when the total exceeds the balance (slice 2: budget hold up front)", async () => {
    const owner = "usr_0000000000000421";
    await seedUser(owner, 0); // 没余额：建 run 时总价冻结就该 402，不再放到执行中途。
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
    await expect(
      createCanvasRun(owner, {
        canvasId: doc.id,
        quoteHash: quote.hash,
        idempotencyKey: "test-run-key-00000004",
      }),
    ).rejects.toMatchObject({ status: 402, code: "insufficient_balance" });
    // 冻结失败不留任何 run 文件。
    expect(await listCanvasRuns(owner)).toHaveLength(0);
  });

  it("still fails closed mid-flight for a legacy run without a reservation", async () => {
    const owner = "usr_0000000000000431";
    await seedUser(owner, 0);
    const doc = await createCanvas(owner, "旧版 run 无预留");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_00220011", kind: "gen_image", x: 0, y: 0, prompt: "第一段" },
        { id: "n_00220012", kind: "gen_video", x: 300, y: 0, prompt: "第二段" },
      ],
      edges: [{ id: "e_00000023", from: "n_00220011", to: "n_00220012" }],
    });
    const quote = await computeQuote(owner, patched!);
    // 手搓一个切片一形状的旧 run：没有 reservation 字段——子任务必须回落
    // 普通 reserveJobFunds，准入闸门不许因 run 无预留被绕过。
    const now = new Date().toISOString();
    const run: CanvasRun = {
      schemaVersion: 1,
      id: newCanvasRunId(),
      ownerId: owner,
      canvasId: doc.id,
      documentRevision: patched!.revision,
      graphSnapshot: { nodes: patched!.nodes, edges: patched!.edges },
      quote,
      status: "running",
      nodeExecutions: [
        { nodeId: "n_00220011", attempt: 1, status: "ready" },
        { nodeId: "n_00220012", attempt: 1, status: "waiting_dependencies" },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await writeCanvasRun(run);

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("failed");
    expect(final.nodeExecutions.find((e) => e.nodeId === "n_00220011")).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
    });
    expect(final.nodeExecutions.find((e) => e.nodeId === "n_00220012")).toMatchObject({
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

/* ---------- D 切片二：run 级预算预留 ---------- */

describe("run 级预算预留", () => {
  it("freezes the quote total on creation and stops counting once the run settles", async () => {
    const owner = "usr_0000000000000510";
    await seedUser(owner);
    const doc = await createCanvas(owner, "冻结");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_05100001", kind: "gen_image", x: 0, y: 0, prompt: "图" }],
    });
    const quote = await computeQuote(owner, patched!);
    const before = await loadBalanceUsage(owner);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000010",
    });

    // 总价冻结在 run 上：余量 = 总额，尚未转移任何份额。
    expect(run.reservation).toMatchObject({
      amountCny: quote.totalCny,
      remainingCny: quote.totalCny,
    });
    const during = await loadBalanceUsage(owner);
    expect(during.reservedCny).toBeCloseTo(before.reservedCny + quote.totalCny, 2);

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("succeeded");
    // 终态释放：job 已结算不再计预留，run 余量也停计——占用归零。
    const after = await loadBalanceUsage(owner);
    expect(after.reservedCny).toBeCloseTo(before.reservedCny, 2);
  }, 30000);

  it("transfers the node share to the child job — one share, counted once", async () => {
    const owner = "usr_0000000000000511";
    await seedUser(owner);
    const doc = await createCanvas(owner, "转移");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_05110001", kind: "gen_image", x: 0, y: 0, prompt: "图" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000011",
    });

    // 等执行位拿到 jobId（kick 的异步 sweep 或手动补一轮都行）。
    let observed = await readCanvasRun(owner, run.id);
    for (let i = 0; i < 40 && !observed?.nodeExecutions[0]?.jobId; i += 1) {
      await sweepCanvasRun(owner, run.id);
      observed = await readCanvasRun(owner, run.id);
    }
    const jobId = observed?.nodeExecutions[0]?.jobId;
    expect(jobId).toBeTruthy();

    const after = await readCanvasRun(owner, run.id);
    const res = after?.reservation;
    const price = quote.items[0]!.priceCny;
    // 份额已从 run 划走：余量归零，台账锚定该子任务。
    expect(res?.remainingCny).toBeCloseTo(0, 2);
    expect(res?.transfers["n_05110001"]).toMatchObject({ amountCny: price, jobId });
    // 子任务拿到的是转移份额，不是二次现押：总额仍只计一次。
    const job = await readJob(jobId!);
    expect(job?.reservation?.amountCny).toBeCloseTo(price, 2);
    const usage = await loadBalanceUsage(owner);
    // job 未终态时：占用 = job.reservation（transfer 因 jobId 存在不再重复计）。
    expect(usage.reservedCny).toBeCloseTo(price, 2);

    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("succeeded");
  }, 30000);

  it("counts an orphan transfer (job file missing) and skips one anchored to a finished job", async () => {
    const owner = "usr_0000000000000512";
    await seedUser(owner);
    const doc = await createCanvas(owner, "孤儿份额");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_05120001", kind: "gen_image", x: 0, y: 0, prompt: "图" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run: run1 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000012",
    });
    const final1 = await runToTerminal(owner, run1.id);
    const doneJobId = final1.nodeExecutions[0]?.jobId;
    expect(doneJobId).toBeTruthy();

    const entries = await listJobIndex({ ownerId: owner });
    const mkRun = async (transferJobId: string) => {
      const now = new Date().toISOString();
      const run: CanvasRun = {
        schemaVersion: 1,
        id: newCanvasRunId(),
        ownerId: owner,
        canvasId: doc.id,
        documentRevision: patched!.revision,
        graphSnapshot: { nodes: patched!.nodes, edges: patched!.edges },
        quote,
        reservation: {
          amountCny: 7,
          memberCny: 0,
          purchasedCny: 7,
          remainingCny: 0,
          remainingMemberCny: 0,
          remainingPurchasedCny: 0,
          transfers: {
            n_05120001: {
              amountCny: 7,
              memberCny: 0,
              purchasedCny: 7,
              jobId: transferJobId,
            },
          },
          createdAt: now,
        },
        status: "running",
        nodeExecutions: [{ nodeId: "n_05120001", attempt: 1, status: "running", jobId: transferJobId }],
        createdAt: now,
        updatedAt: now,
      };
      await writeCanvasRun(run);
      return run;
    };

    // 锚定 job 缺失（转移已写、任务没落盘的崩溃窗口）→ 份额仍计占用。
    const orphanRun = await mkRun("job_0000000000ff");
    const heldOrphan = await runHeldFunds(owner, entries);
    expect(heldOrphan.transferCny).toBeCloseTo(7, 2);
    const usageOrphan = await loadBalanceUsage(owner);
    expect(usageOrphan.reservedCny).toBeCloseTo(7, 2);

    // 锚定 job 存在且已终态 → 该份额已随任务生命周期结算，不再计。
    const anchoredRun = await mkRun(doneJobId!);
    const heldAnchored = await runHeldFunds(owner, entries);
    expect(heldAnchored.transferCny).toBeCloseTo(7, 2); // 只剩孤儿那笔
    void anchoredRun;

    // 孤儿 run 转终态 → 全部停计。
    await updateCanvasRun(owner, orphanRun.id, (r) => ({ ...r, status: "failed" as const }));
    const heldAfter = await runHeldFunds(owner, entries);
    expect(heldAfter.transferCny).toBeCloseTo(0, 2);
    expect(heldAfter.remainingCny).toBeCloseTo(0, 2);
  }, 30000);

  it("fails closed with billing_state_corrupt when a run file is unreadable", async () => {
    const owner = "usr_0000000000000513";
    await seedUser(owner);
    await mkdir(canvasRunsUserDir(owner), { recursive: true });
    await writeFile(
      path.join(canvasRunsUserDir(owner), "crun_ffffffffffff.json"),
      "{ not json",
      "utf8",
    );
    await expect(loadBalanceUsage(owner)).rejects.toMatchObject({
      status: 500,
      code: "billing_state_corrupt",
    });
  });
});

/* ---------- D 切片二：复用 / 强制重跑 / 已清产物 ---------- */

describe("复用与重跑", () => {
  it("expandRegenerate closes over downstream generation nodes", () => {
    const graph = {
      nodes: [
        { id: "n_0000000a", kind: "gen_image" as const, x: 0, y: 0, prompt: "a" },
        { id: "n_0000000b", kind: "gen_video" as const, x: 0, y: 0, prompt: "b" },
        { id: "n_0000000c", kind: "gen_video" as const, x: 0, y: 0, prompt: "c" },
      ],
      edges: [
        { id: "e_0000000a", from: "n_0000000a", to: "n_0000000b" },
        { id: "e_0000000b", from: "n_0000000b", to: "n_0000000c" },
      ],
    };
    expect([...expandRegenerate(graph, ["n_0000000a"])].sort()).toEqual([
      "n_0000000a",
      "n_0000000b",
      "n_0000000c",
    ]);
    expect([...expandRegenerate(graph, ["n_0000000c"])]).toEqual(["n_0000000c"]);
  });

  it("reuses an unchanged prior output at ¥0 — no new job is created", async () => {
    const owner = "usr_0000000000000520";
    await seedUser(owner);
    const doc = await createCanvas(owner, "复用");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_05200001", kind: "gen_image", x: 0, y: 0, prompt: "同样的图" }],
    });
    const quote1 = await computeQuote(owner, patched!);
    const { run: run1 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote1.hash,
      idempotencyKey: "test-run-key-00000020",
    });
    const final1 = await runToTerminal(owner, run1.id);
    const jobIdA = final1.nodeExecutions[0]?.jobId;
    expect(jobIdA).toBeTruthy();
    const jobsBefore = (await listJobIndex({ ownerId: owner })).length;

    // 第二张 run：输入没变 → 报价 ¥0、执行位直接采纳历史产物。
    const doc2 = (await readCanvas(owner, doc.id))!;
    const reuse = await resolveReuseForQuote(owner, doc2, new Set());
    const quote2 = await computeQuote(owner, doc2, { reuse });
    expect(quote2.items[0]).toMatchObject({ reused: true, adoptedJobId: jobIdA, priceCny: 0 });
    expect(quote2.totalCny).toBe(0);
    const { run: run2 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote2.hash,
      idempotencyKey: "test-run-key-00000021",
    });
    // 全复用：创建即终态，不建任务、不冻结预算。
    expect(run2.status).toBe("succeeded");
    expect(run2.reservation).toBeUndefined();
    expect(run2.nodeExecutions[0]).toMatchObject({
      status: "succeeded",
      reused: true,
      jobId: jobIdA,
    });
    expect((await listJobIndex({ ownerId: owner })).length).toBe(jobsBefore);
  }, 30000);

  it("runs a fresh job when the node is explicitly regenerated", async () => {
    const owner = "usr_0000000000000521";
    await seedUser(owner);
    const doc = await createCanvas(owner, "重跑");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_05210001", kind: "gen_image", x: 0, y: 0, prompt: "再跑一次" }],
    });
    const quote1 = await computeQuote(owner, patched!);
    const { run: run1 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote1.hash,
      idempotencyKey: "test-run-key-00000022",
    });
    const final1 = await runToTerminal(owner, run1.id);
    const jobIdA = final1.nodeExecutions[0]?.jobId;

    // 点名重跑：报价按实计价（复用位被 regen 集排除），执行建新任务。
    const doc2 = (await readCanvas(owner, doc.id))!;
    const regen = expandRegenerate(
      { nodes: doc2.nodes, edges: doc2.edges },
      ["n_05210001"],
    );
    const reuse = await resolveReuseForQuote(owner, doc2, regen);
    const quote2 = await computeQuote(owner, doc2, {
      regenerate: ["n_05210001"],
      reuse,
    });
    expect(quote2.items[0]?.reused).toBeUndefined();
    expect(quote2.totalCny).toBeGreaterThan(0);
    const { run: run2 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote2.hash,
      idempotencyKey: "test-run-key-00000023",
      regenerate: ["n_05210001"],
    });
    const final2 = await runToTerminal(owner, run2.id);
    expect(final2.status).toBe("succeeded");
    expect(final2.nodeExecutions[0]?.reused).toBeUndefined();
    expect(final2.nodeExecutions[0]?.jobId).toBeTruthy();
    expect(final2.nodeExecutions[0]?.jobId).not.toBe(jobIdA);
  }, 30000);

  it("blocks output_purged when the matched prior output was cleaned up", async () => {
    const owner = "usr_0000000000000522";
    await seedUser(owner);
    const doc = await createCanvas(owner, "已清产物");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_05220001", kind: "gen_image", x: 0, y: 0, prompt: "被清掉的图" }],
    });
    const quote1 = await computeQuote(owner, patched!);
    const { run: run1 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote1.hash,
      idempotencyKey: "test-run-key-00000024",
    });
    const final1 = await runToTerminal(owner, run1.id);
    const jobIdA = final1.nodeExecutions[0]?.jobId;
    expect(jobIdA).toBeTruthy();

    // 模拟留存清理：产物被清，任务状态不变。
    const jobA = await readJob(jobIdA!);
    await writeJob({ ...jobA!, artifactsPurgedAt: new Date().toISOString() });

    const doc2 = (await readCanvas(owner, doc.id))!;
    const reuse = await resolveReuseForQuote(owner, doc2, new Set());
    const quote2 = await computeQuote(owner, doc2, { reuse });
    expect(quote2.items[0]).toMatchObject({ purged: true, priceCny: 0 });
    const { run: run2 } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote2.hash,
      idempotencyKey: "test-run-key-00000025",
    });
    // 输入没变但产物没了：blocked/output_purged，绝不悄悄重生成。
    expect(run2.status).toBe("failed");
    expect(run2.nodeExecutions[0]).toMatchObject({
      status: "blocked",
      errorCode: "output_purged",
    });
    expect(run2.nodeExecutions[0]?.jobId).toBeUndefined();
  }, 30000);
});

/* ---------- D 切片二：审批门 ---------- */

describe("审批门", () => {
  it("holds a gated node at awaiting_approval; approve submits, reject blocks", async () => {
    const owner = "usr_0000000000000530";
    await seedUser(owner);
    const doc = await createCanvas(owner, "审批");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_05300001", kind: "gen_image", x: 0, y: 0, prompt: "上游图" },
        { id: "n_05300002", kind: "gen_video", x: 300, y: 0, prompt: "动起来" },
      ],
      edges: [{ id: "e_00000053", from: "n_05300001", to: "n_05300002" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000030",
      approvalNodeIds: ["n_05300002"],
    });
    expect(run.gatedNodeIds).toEqual(["n_05300002"]);

    // 上游图先跑完，视频节点到门停住——不提交任务。
    let observed = await readCanvasRun(owner, run.id);
    for (let i = 0; i < 60 && observed?.nodeExecutions[1]?.status !== "awaiting_approval"; i += 1) {
      await sweepCanvasRun(owner, run.id);
      observed = await readCanvasRun(owner, run.id);
      if (observed?.nodeExecutions[1]?.status !== "awaiting_approval") await sleep(250);
    }
    const gated = observed?.nodeExecutions.find((e) => e.nodeId === "n_05300002");
    expect(gated).toMatchObject({ status: "awaiting_approval" });
    expect(gated?.jobId).toBeUndefined();

    // 批准 → 回 ready，下一轮提交。
    const decided = await decideCanvasRunApproval(owner, run.id, {
      nodeId: "n_05300002",
      decision: "approve",
    });
    expect(decided.nodeExecutions[1]).toMatchObject({
      status: "ready",
      approval: { decision: "approved" },
    });
    // 同决策重放幂等交回。
    const replay = await decideCanvasRunApproval(owner, run.id, {
      nodeId: "n_05300002",
      decision: "approve",
    });
    expect(replay.nodeExecutions[1]?.approval?.decision).toBe("approved");

    const final = await runToTerminal(owner, run.id, 45000);
    expect(final.status).toBe("succeeded");
    expect(final.nodeExecutions[1]?.jobId).toBeTruthy();
  }, 60000);

  it("reject blocks the node and propagates downstream", async () => {
    const owner = "usr_0000000000000531";
    await seedUser(owner);
    const doc = await createCanvas(owner, "驳回");
    const patched = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_05310001", kind: "gen_image", x: 0, y: 0, prompt: "甲" },
        { id: "n_05310002", kind: "gen_image", x: 300, y: 0, prompt: "乙（吃甲的图没用，演示传播）" },
      ],
      edges: [{ id: "e_00000054", from: "n_05310001", to: "n_05310002" }],
    });
    const quote = await computeQuote(owner, patched!);
    const { run } = await createCanvasRun(owner, {
      canvasId: doc.id,
      quoteHash: quote.hash,
      idempotencyKey: "test-run-key-00000031",
      approvalNodeIds: ["n_05310001"],
    });

    let observed = await readCanvasRun(owner, run.id);
    for (let i = 0; i < 40 && observed?.nodeExecutions[0]?.status !== "awaiting_approval"; i += 1) {
      await sweepCanvasRun(owner, run.id);
      observed = await readCanvasRun(owner, run.id);
    }
    expect(observed?.nodeExecutions[0]?.status).toBe("awaiting_approval");

    const decided = await decideCanvasRunApproval(owner, run.id, {
      nodeId: "n_05310001",
      decision: "reject",
    });
    expect(decided.nodeExecutions[0]).toMatchObject({
      status: "blocked",
      errorCode: "approval_rejected",
      approval: { decision: "rejected" },
    });
    const final = await runToTerminal(owner, run.id);
    expect(final.status).toBe("failed");
    expect(final.nodeExecutions.find((e) => e.nodeId === "n_05310002")).toMatchObject({
      status: "blocked",
      errorCode: "upstream_failed",
    });
  }, 30000);
});
