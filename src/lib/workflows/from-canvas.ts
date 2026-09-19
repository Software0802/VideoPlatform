import { isGenNode, nodeInputs, nodeMode, topoOrder, type Graph } from "@/lib/canvas/graph";
import type { CanvasDocument } from "@/lib/canvas/schema";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "@/lib/workflows/types";

/**
 * 画布文档 → 工作流图（`types.ts` 的说明是这条投影的契约）。
 *
 * 顺序、依赖与「这一步调用哪条能力」全部复用 `canvas/graph.ts` 的判据
 * （`topoOrder` / `nodeMode`），不在这里另写一份——报的价、跑的顺序和导出的图必须
 * 是同一个图，分叉了就会出现「导出说先跑 A，实际先跑 B」。
 *
 * `gates` 是报价弹层里勾了「执行前需我批准」的节点 id（`POST /api/canvases/:id/runs`
 * 的同名字段）。勾了的那一步前面插一道门，门的入边接管这一步原来的入边。
 */

/** 标签用提示词首句，够认出是哪一步就行；没提示词就空着。 */
const LABEL_MAX = 60;

function labelOf(prompt: string | undefined): string {
  const one = (prompt ?? "").replace(/\s+/g, " ").trim();
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX)}…` : one;
}

export function workflowFromCanvas(
  doc: CanvasDocument,
  options: { gates?: readonly string[] } = {},
): WorkflowGraph {
  const graph: Graph = { nodes: doc.nodes, edges: doc.edges };
  const gated = new Set(options.gates ?? []);
  // 有环时拓扑序为 null（报价同样会拒），退回文档顺序：导出是只读视图，不该因为
  // 一张画坏的图就报错，但也不能假装自己知道该先跑谁。
  const ordered = topoOrder(graph) ?? doc.nodes;
  const steps = ordered.filter(isGenNode);
  const stepIds = new Set(steps.map((n) => n.id));

  const nodes: WorkflowNode[] = [];
  /** 每个步骤的「入口」：有门时是门，没门时是它自己。上游连过来要连到入口。 */
  const entry = new Map<string, string>();
  const edges: WorkflowEdge[] = [];

  for (const node of steps) {
    const label = labelOf(node.prompt);
    const stepId = node.id;
    if (gated.has(stepId)) {
      const gateId = `gate_${stepId}`;
      nodes.push({ id: gateId, kind: "gate", label, step: stepId });
      edges.push({ from: gateId, to: stepId });
      entry.set(stepId, gateId);
    } else {
      entry.set(stepId, stepId);
    }
    nodes.push({
      id: stepId,
      kind: "skill",
      skillId: nodeMode(graph, node),
      label,
      inputs: nodeInputs(graph, stepId).filter((n) => !isGenNode(n)).length,
    });
  }

  for (const edge of doc.edges) {
    // 只有生成节点之间构成执行依赖；静态输入已经计进 `inputs`。
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) continue;
    edges.push({ from: edge.from, to: entry.get(edge.to) ?? edge.to });
  }

  return { id: doc.id, name: doc.title, nodes, edges };
}
