export type GateNode = {
  id: string;
  kind: "gate";
  label: string;
};

export type SkillNode = {
  id: string;
  kind: "skill";
  skillId: string;
};

export type WorkflowNode = GateNode | SkillNode;

export type WorkflowEdge = {
  from: string;
  to: string;
};

export type WorkflowGraph = {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};
