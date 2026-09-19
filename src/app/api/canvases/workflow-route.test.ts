import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * `GET /api/canvases/:id/workflow`：只读投影，说清「这次要跑哪几步、哪几步前面有门」。
 *
 * 两条硬约束跟画布详情同口径，所以在这里各钉一条：非本人与不存在同 404（不可探测），
 * 以及 `gates` 里认不出的 id 不会凭空造出一道门。
 */
const SESSION_SECRET = "workflow-route-test-secret-0123456789";

let dataRoot = "";
let writeUser: typeof import("@/lib/users/store").writeUser;
let createCanvas: typeof import("@/lib/canvas/store").createCanvas;
let updateCanvas: typeof import("@/lib/canvas/store").updateCanvas;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;
let GET: typeof import("./[id]/workflow/route").GET;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-workflow-route-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  ({ writeUser } = await import("@/lib/users/store"));
  ({ createCanvas, updateCanvas } = await import("@/lib/canvas/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ GET } = await import("./[id]/workflow/route"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

async function seedUser(tag: string): Promise<UserRecord> {
  const id = `usr_${tag.padStart(16, "0")}`;
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

function requestFor(canvasId: string, user: UserRecord, query = ""): Request {
  return new Request(`http://localhost/api/canvases/${canvasId}/workflow${query}`, {
    headers: { cookie: `${SESSION_COOKIE}=${issueSessionValue(user)}` },
  });
}

async function seedCanvas(ownerId: string) {
  const doc = await createCanvas(ownerId, "一条广告");
  return updateCanvas(ownerId, doc.id, (current) => ({
    ...current,
    nodes: [
      { id: "n_0000000a", kind: "text", x: 0, y: 0, text: "海边黄昏" },
      { id: "n_0000000b", kind: "gen_image", x: 0, y: 0, prompt: "首帧" },
      { id: "n_0000000c", kind: "gen_video", x: 0, y: 0, prompt: "成片" },
    ],
    edges: [
      { id: "e_0000000a", from: "n_0000000a", to: "n_0000000b" },
      { id: "e_0000000b", from: "n_0000000b", to: "n_0000000c" },
    ],
  }));
}

describe("GET /api/canvases/:id/workflow", () => {
  it("按拓扑序列出生成步骤；文本节点只计进 inputs", async () => {
    const owner = await seedUser("1");
    const doc = await seedCanvas(owner.id);

    const res = await GET(requestFor(doc!.id, owner), { params: Promise.resolve({ id: doc!.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflow: WorkflowGraph };
    expect(body.workflow.name).toBe("一条广告");
    expect(body.workflow.nodes.map((n) => n.id)).toEqual(["n_0000000b", "n_0000000c"]);
    expect(body.workflow.nodes[0]).toMatchObject({ kind: "skill", skillId: "text_to_image", inputs: 1 });
    expect(body.workflow.edges).toEqual([{ from: "n_0000000b", to: "n_0000000c" }]);
  });

  it("gates 里勾中的那一步前面插门；认不出的 id 不造门", async () => {
    const owner = await seedUser("2");
    const doc = await seedCanvas(owner.id);

    const res = await GET(requestFor(doc!.id, owner, "?gates=n_0000000c,n_ffffffff"), {
      params: Promise.resolve({ id: doc!.id }),
    });
    const body = (await res.json()) as { workflow: WorkflowGraph };
    const gates = body.workflow.nodes.filter((n) => n.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ id: "gate_n_0000000c", step: "n_0000000c" });
    expect(body.workflow.edges).toContainEqual({ from: "n_0000000b", to: "gate_n_0000000c" });
  });

  it("非本人与不存在同 404", async () => {
    const owner = await seedUser("3");
    const other = await seedUser("4");
    const doc = await seedCanvas(owner.id);

    const stolen = await GET(requestFor(doc!.id, other), { params: Promise.resolve({ id: doc!.id }) });
    expect(stolen.status).toBe(404);
    const missing = await GET(requestFor("cv_ffffffffffff", owner), {
      params: Promise.resolve({ id: "cv_ffffffffffff" }),
    });
    expect(missing.status).toBe(404);
  });
});
