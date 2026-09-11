import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 画布（C 包）：持久化 + revision 乐观并发 + 四类节点的真实生成路径。
 *
 * 「运行」走真实的 `createJob`（`LUMEN_FORCE_MOCK=1`），要验的正是「画布上跑出来的
 * 就是普通任务」——替身会把这一点验没了。
 */

let dataRoot = "";
let readCanvas: typeof import("./store").readCanvas;
let createCanvas: typeof import("./store").createCanvas;
let listCanvases: typeof import("./store").listCanvases;
let patchCanvas: typeof import("./store").patchCanvas;
let deleteCanvas: typeof import("./store").deleteCanvas;
let runCanvasNode: typeof import("./run").runCanvasNode;
let writeUser: typeof import("@/lib/users/store").writeUser;
let writeJob: typeof import("@/lib/jobs/store").writeJob;
let mediaStore: typeof import("@/lib/storage/local-fs").mediaStore;
let storeUploadFromBuffer: typeof import("@/lib/jobs/upload").storeUploadFromBuffer;
let readJobForUser: typeof import("@/lib/jobs/store").readJobForUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-canvas-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ readCanvas, createCanvas, listCanvases, patchCanvas, deleteCanvas } = await import("./store"));
  ({ runCanvasNode } = await import("./run"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ writeJob, readJobForUser } = await import("@/lib/jobs/store"));
  ({ mediaStore } = await import("@/lib/storage/local-fs"));
  ({ storeUploadFromBuffer } = await import("@/lib/jobs/upload"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_FORCE_MOCK;
  // 这些用例真的把任务放进了 runner；等它跑空再删目录，别把产物写进下一个文件的目录。
  const { activeCount } = await import("@/lib/jobs/runner");
  for (let i = 0; i < 60; i += 1) {
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

describe("canvas store", () => {
  it("creates, lists, reads and deletes documents scoped to the owner", async () => {
    const owner = "usr_0000000000000301";
    await seedUser(owner);
    const doc = await createCanvas(owner, "画布一");
    expect(doc.id).toMatch(/^cv_[0-9a-f]{12}$/);
    expect(doc.revision).toBe(0);

    const listed = await listCanvases(owner);
    expect(listed.map((c) => c.id)).toEqual([doc.id]);
    expect(await readCanvas(owner, doc.id)).toMatchObject({ id: doc.id, title: "画布一" });
    // 别人的画布 404，与任务同一条纪律。
    expect(await readCanvas("usr_0000000000000302", doc.id)).toBeNull();

    expect(await deleteCanvas(owner, doc.id)).toBe(true);
    expect(await readCanvas(owner, doc.id)).toBeNull();
  });

  it("rejects a stale expectedRevision with 409 revision_conflict", async () => {
    const owner = "usr_0000000000000303";
    await seedUser(owner);
    const doc = await createCanvas(owner, "两个标签页");

    const first = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_aabbccdd", kind: "text", x: 10, y: 10, text: "A 标签页写的" }],
    });
    expect(first?.revision).toBe(1);

    // 第二个标签页还拿着 revision 0 的底稿——它的写必须被拒，不能静默覆盖。
    await expect(
      patchCanvas(owner, doc.id, {
        expectedRevision: 0,
        nodes: [{ id: "n_11223344", kind: "text", x: 20, y: 20, text: "B 标签页写的" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "revision_conflict" });

    const stored = await readCanvas(owner, doc.id);
    expect(stored?.nodes).toHaveLength(1);
    expect(stored?.nodes[0].text).toBe("A 标签页写的");
  });
});

describe("runCanvasNode", () => {
  it("runs a gen_image node into a real text_to_image job and stamps jobId/runSeq", async () => {
    const owner = "usr_0000000000000310";
    await seedUser(owner);
    const doc = await createCanvas(owner, "文生图");
    const withNode = await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_a1b2c3d4", kind: "gen_image", x: 0, y: 0, prompt: "海边黄昏的海报" }],
    });

    const { canvas, job } = await runCanvasNode(owner, doc.id, "n_a1b2c3d4");
    expect(job.mode).toBe("text_to_image");
    expect(job.id).toMatch(/^job_[0-9a-f]{12}$/);
    const node = canvas.nodes.find((n) => n.id === "n_a1b2c3d4");
    expect(node?.jobId).toBe(job.id);
    expect(node?.runSeq).toBe(1);
    expect(withNode?.nodes[0].jobId).toBeUndefined();
  });

  it("returns the same in-flight job on a repeated run instead of filing a second", async () => {
    const owner = "usr_0000000000000311";
    await seedUser(owner);
    const doc = await createCanvas(owner, "重复运行");
    await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [{ id: "n_b1b2c3d4", kind: "gen_image", x: 0, y: 0, prompt: "一张图" }],
    });

    const first = await runCanvasNode(owner, doc.id, "n_b1b2c3d4");
    const again = await runCanvasNode(owner, doc.id, "n_b1b2c3d4");
    // 任务还没终态：重复点击 / 网络重试交回同一条，不是再建一条、再扣一份。
    expect(again.job.id).toBe(first.job.id);
    expect(again.canvas.nodes.find((n) => n.id === "n_b1b2c3d4")?.runSeq).toBe(1);
  });

  it("runs gen_video as text_to_video without an image input, merging wired text", async () => {
    const owner = "usr_0000000000000312";
    await seedUser(owner);
    const doc = await createCanvas(owner, "文生视频");
    await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_aa000001", kind: "text", x: 0, y: 0, text: "一家人在客厅" },
        { id: "n_bb000001", kind: "gen_video", x: 300, y: 0, prompt: "温暖的暖调" },
      ],
      edges: [{ id: "e_00000001", from: "n_aa000001", to: "n_bb000001" }],
    });

    const { job } = await runCanvasNode(owner, doc.id, "n_bb000001");
    expect(job.mode).toBe("text_to_video");
    // 连入的文本节点内容并进提示词。
    expect(job.prompt).toContain("一家人在客厅");
    expect(job.prompt).toContain("温暖的暖调");
  });

  it("runs gen_video as image_to_video when a wired material node supplies an upload", async () => {
    const owner = "usr_0000000000000313";
    await seedUser(owner);
    const doc = await createCanvas(owner, "图生视频");
    const jpeg = await sharp({
      create: { width: 4, height: 3, channels: 3, background: { r: 40, g: 60, b: 80 } },
    })
      .jpeg()
      .toBuffer();
    const side = await storeUploadFromBuffer(jpeg, "start", owner);
    await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_aa000002", kind: "material", x: 0, y: 0, uploadId: side.uploadId },
        { id: "n_bb000002", kind: "gen_video", x: 300, y: 0, prompt: "让画面动起来" },
      ],
      edges: [{ id: "e_00000002", from: "n_aa000002", to: "n_bb000002" }],
    });

    const { job } = await runCanvasNode(owner, doc.id, "n_bb000002");
    expect(job.mode).toBe("image_to_video");
    // 素材被 createJob 认领：sidecar 已从 tmp 挪走、任务记录里留着引用。
    const rec = await readJobForUser(job.id, owner);
    expect(rec?.mode).toBe("image_to_video");
  });

  it("runs gen_video as image_to_video off an upstream gen_image node's finished output", async () => {
    const owner = "usr_0000000000000314";
    await seedUser(owner);
    const doc = await createCanvas(owner, "图生视频（上游产物）");

    // 上游 gen_image 的产物：手写一条「已完成」的图片任务 + 固定位置的输出文件。
    const now = new Date().toISOString();
    await writeJob({
      schemaVersion: 1,
      id: "job_cv_img01",
      ownerId: owner,
      status: "succeeded",
      progress: 100,
      mode: "text_to_image",
      model: "grok-imagine-image-2.0",
      provider: "mock",
      prompt: "上游出图",
      durationSec: 0,
      aspectRatio: "16:9",
      resolution: null,
      imageResolution: "1k",
      generateAudio: false,
      lastFrameStored: false,
      lastFrameLocksOutput: false,
      harness: { enabled: false },
      priceCny: 0.5,
      costUsdEstimate: 0.02,
      costUsdActual: 0.02,
      error: null,
      output: { kind: "image", imageUrl: "/api/media/job_cv_img01/image.jpg" },
      createdAt: now,
      updatedAt: now,
      bible: null,
      shots: null,
      assets: {},
    });
    const jpeg = await sharp({
      create: { width: 4, height: 3, channels: 3, background: { r: 90, g: 30, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const outDir = path.join(mediaStore.jobDir("job_cv_img01"), "outputs");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "image.jpg"), jpeg);

    await patchCanvas(owner, doc.id, {
      expectedRevision: 0,
      nodes: [
        { id: "n_aa000003", kind: "gen_image", x: 0, y: 0, prompt: "上游图", jobId: "job_cv_img01" },
        { id: "n_bb000003", kind: "gen_video", x: 300, y: 0, prompt: "动起来" },
      ],
      edges: [{ id: "e_00000003", from: "n_aa000003", to: "n_bb000003" }],
    });

    const { job } = await runCanvasNode(owner, doc.id, "n_bb000003");
    expect(job.mode).toBe("image_to_video");
  });
});
