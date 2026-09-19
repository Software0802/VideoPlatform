/**
 * 工作流图：一次运行的**步骤 + 人审门**，与执行引擎无关的纯描述
 * （`docs/architecture.md` §15「skills/workflows 是文件，不是 if/else」）。
 *
 * 当前唯一的生产者是画布：一张画布跑一次就是一张工作流图——生成节点是要花钱的
 * 步骤，报价弹层里勾了「执行前需我批准」的那些在自己前面多一道门（对应运行时的
 * `awaiting_approval`）。投影见 `from-canvas.ts`，出口是
 * `GET /api/canvases/:id/workflow`。
 *
 * 文本 / 素材节点不进图：它们不占执行位，也不会被批准或跳过，只是所连步骤的输入
 * （计入该步骤的 `inputs`）。
 */

/** 一道人审门：它守着 `step` 那一步，批准前那一步不提交、不花钱。 */
export type GateNode = {
  id: string;
  kind: "gate";
  label: string;
  /** 被守住的步骤 id。 */
  step: string;
};

/** 一步真正会建任务的生成。`skillId` 是这一步调用的能力（画布上就是节点类型）。 */
export type SkillNode = {
  id: string;
  kind: "skill";
  skillId: string;
  label: string;
  /** 静态输入（文本 / 素材节点）的条数。 */
  inputs: number;
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
