import { describe, expect, it } from "vitest";
import type { CanvasDocument, CanvasNode } from "@/lib/canvas/schema";
import { workflowFromCanvas } from "@/lib/workflows/from-canvas";

function doc(nodes: CanvasNode[], edges: { id: string; from: string; to: string }[]): CanvasDocument {
  return {
    schemaVersion: 1,
    id: "cv_0123456789ab",
    ownerId: "u_1",
    title: "一条广告",
    revision: 3,
    nodes,
    edges,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

const text = (id: string, t: string): CanvasNode => ({ id, kind: "text", x: 0, y: 0, text: t });
const material = (id: string): CanvasNode => ({
  id,
  kind: "material",
  x: 0,
  y: 0,
  uploadId: "up_0123456789abcdef",
});
const gen = (id: string, kind: "gen_image" | "gen_video", prompt?: string): CanvasNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...(prompt ? { prompt } : {}),
});

describe("workflowFromCanvas", () => {
  it("只有生成节点成为步骤；静态输入计进 inputs", () => {
    const wf = workflowFromCanvas(
      doc(
        [text("n_00000001", "海边"), material("n_00000002"), gen("n_00000003", "gen_video", "镜头缓慢推近")],
        [
          { id: "e_00000001", from: "n_00000001", to: "n_00000003" },
          { id: "e_00000002", from: "n_00000002", to: "n_00000003" },
        ],
      ),
    );
    expect(wf).toEqual({
      id: "cv_0123456789ab",
      name: "一条广告",
      nodes: [
        {
          id: "n_00000003",
          kind: "skill",
          // 有图片输入 → image_to_video，与 `nodeMode` 同一判据
          skillId: "image_to_video",
          label: "镜头缓慢推近",
          inputs: 2,
        },
      ],
      edges: [],
    });
  });

  it("gen_image → gen_video 是执行依赖；顺序按拓扑序而不是文档顺序", () => {
    const wf = workflowFromCanvas(
      doc(
        [gen("n_0000000b", "gen_video", "成片"), gen("n_0000000a", "gen_image", "首帧")],
        [{ id: "e_00000001", from: "n_0000000a", to: "n_0000000b" }],
      ),
    );
    expect(wf.nodes.map((n) => n.id)).toEqual(["n_0000000a", "n_0000000b"]);
    expect(wf.nodes[0]).toMatchObject({ skillId: "text_to_image" });
    expect(wf.nodes[1]).toMatchObject({ skillId: "image_to_video" });
    expect(wf.edges).toEqual([{ from: "n_0000000a", to: "n_0000000b" }]);
  });

  it("勾了批准的那一步前面插一道门，上游改连到门上", () => {
    const wf = workflowFromCanvas(
      doc(
        [gen("n_0000000a", "gen_image", "首帧"), gen("n_0000000b", "gen_video", "成片")],
        [{ id: "e_00000001", from: "n_0000000a", to: "n_0000000b" }],
      ),
      { gates: ["n_0000000b", "n_unknown0"] },
    );
    expect(wf.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["n_0000000a", "skill"],
      ["gate_n_0000000b", "gate"],
      ["n_0000000b", "skill"],
    ]);
    expect(wf.edges).toEqual([
      { from: "gate_n_0000000b", to: "n_0000000b" },
      { from: "n_0000000a", to: "gate_n_0000000b" },
    ]);
  });

  it("长提示词截断成标签；有环时退回文档顺序而不是抛", () => {
    const long = "镜".repeat(80);
    const wf = workflowFromCanvas(
      doc(
        [gen("n_0000000a", "gen_video", long), gen("n_0000000b", "gen_video", "乙")],
        [
          { id: "e_00000001", from: "n_0000000a", to: "n_0000000b" },
          { id: "e_00000002", from: "n_0000000b", to: "n_0000000a" },
        ],
      ),
    );
    expect(wf.nodes[0]?.label).toBe(`${"镜".repeat(60)}…`);
    expect(wf.nodes.map((n) => n.id)).toEqual(["n_0000000a", "n_0000000b"]);
  });
});
