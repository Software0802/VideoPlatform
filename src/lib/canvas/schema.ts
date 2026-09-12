import { z } from "zod";
import { uploadIdSchema } from "@/lib/jobs/schema";

/**
 * 画布文档（C 包）：`data/canvases/<userId>/<canvasId>.json`，一文件一画布。
 *
 * 四类节点（「四条生成路径全上」）：
 * - `text`     纯文本便签；连线进生成节点时它的内容并进提示词。
 * - `material` 素材节点：一份 `uploadId`（走 `/api/uploads` 的既有 sidecar 校验）。
 * - `gen_image` 文生图节点：`run` → `createJob(text_to_image)`。
 * - `gen_video` 视频节点：有图片输入（material / 上游 gen_image 产物）→ `image_to_video`，
 *   否则 → `text_to_video`。
 *
 * 生成节点上的 `jobId` 是「最近一次运行」的指针；`runSeq` 给每次运行一个稳定的
 * 幂等键分量（`canvas:<canvasId>:<nodeId>:<runSeq>`），HTTP 重试不会建第二条。
 */

export const CANVAS_ID_RE = /^cv_[0-9a-f]{12}$/;
export const CANVAS_NODE_ID_RE = /^n_[0-9a-f]{8}$/;
export const CANVAS_EDGE_ID_RE = /^e_[0-9a-f]{8}$/;

const nodeIdSchema = z.string().regex(CANVAS_NODE_ID_RE);

export const canvasNodeKindSchema = z.enum(["text", "material", "gen_image", "gen_video"]);
export type CanvasNodeKind = z.infer<typeof canvasNodeKindSchema>;

export const canvasNodeSchema = z
  .object({
    id: nodeIdSchema,
    kind: canvasNodeKindSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    /** text 节点的内容。 */
    text: z.string().max(5000).optional(),
    /** 生成节点的提示词。 */
    prompt: z.string().max(2000).optional(),
    /** 生成节点点名的产品 id（`GET /api/models`）；缺省服务端路由决定。 */
    product: z.string().max(64).optional(),
    /** material 节点的素材（上传 sidecar id）。 */
    uploadId: uploadIdSchema.optional(),
    /** 生成节点最近一次运行建出的任务。 */
    jobId: z.string().optional(),
    /** 已发起过的运行次数；幂等键分量，重试共享、新运行自增。 */
    runSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CanvasNode = z.infer<typeof canvasNodeSchema>;

/** 连线：`from` 节点的内容 / 产物喂给 `to` 节点。 */
export const canvasEdgeSchema = z
  .object({ id: z.string().regex(CANVAS_EDGE_ID_RE), from: nodeIdSchema, to: nodeIdSchema })
  .strict();
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;

export const canvasDocSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(CANVAS_ID_RE),
  ownerId: z.string(),
  title: z.string().max(80),
  /** 乐观并发戳：PATCH 必须带 `expectedRevision`，对不上 409 `revision_conflict`。 */
  revision: z.number().int().nonnegative(),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CanvasDocument = z.infer<typeof canvasDocSchema>;

export const canvasCreateBodySchema = z
  .object({ title: z.string().trim().min(1).max(80).optional() })
  .strict();

export const canvasPatchBodySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(80).optional(),
    nodes: z.array(canvasNodeSchema).optional(),
    edges: z.array(canvasEdgeSchema).optional(),
  })
  .strict();
export type CanvasPatchBody = z.infer<typeof canvasPatchBodySchema>;

/* ---------- D 包：整张图的一次性运行（CanvasRun） ---------- */

export const CANVAS_RUN_ID_RE = /^crun_[0-9a-f]{12}$/;

/** 请求体里节点 id 数组的上限（与图容量 50 节点同量级）。 */
const CANVAS_MAX_NODE_IDS = 50;

/** 只有生成节点进执行表；text / material 是静态输入，不占执行位。 */
export const canvasNodeExecStatusSchema = z.enum([
  "waiting_dependencies",
  "ready",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "blocked",
]);
export type CanvasNodeExecStatus = z.infer<typeof canvasNodeExecStatusSchema>;

export const canvasRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "partially_failed",
  "failed",
  "canceled",
]);
export type CanvasRunStatus = z.infer<typeof canvasRunStatusSchema>;

export const canvasNodeExecutionSchema = z
  .object({
    nodeId: nodeIdSchema,
    /** 恒 1：重跑一张图 = 新 run，不在原 run 里加 attempt。 */
    attempt: z.number().int().positive(),
    status: canvasNodeExecStatusSchema,
    jobId: z.string().optional(),
    errorCode: z.string().optional(),
    /** `queue_full` 的退避：run 里它是等待信号不是失败，泵到点再试。 */
    nextAttemptAt: z.string().optional(),
    /**
     * 该执行位第一次进入 `awaiting_approval` 的时刻：超过
     * `dag.APPROVAL_TIMEOUT_MS`（24h）由 sweep 收敛成 `blocked`/`approval_timeout`，
     * 之后 `decideCanvasRunApproval` 也拒绝再写决策。旧 run 文件缺这个字段时
     * sweep 先补记 `now`，不当即超时。
     */
    awaitingSince: z.string().optional(),
    /**
     * 第一次撞 `queue_full` 的时刻：超过 `dag.QUEUE_WAIT_TIMEOUT_MS`（1h）
     * 收敛成 `blocked`/`queue_timeout` 并清掉 `nextAttemptAt`；提交成功后删掉。
     */
    queueWaitSince: z.string().optional(),
    /** D 切片二：本执行位复用了上一次 run 的成功产物（不新建任务、不计费）。 */
    reused: z.boolean().optional(),
    /** D 切片二：人工门的决策记录（仅 `awaiting_approval` 之后落上）。 */
    approval: z
      .object({
        decision: z.enum(["approved", "rejected"]),
        decidedAt: z.string(),
      })
      .strict()
      .optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .strict();
export type CanvasNodeExecution = z.infer<typeof canvasNodeExecutionSchema>;

/**
 * 报价条目：`basisHash` 盖住「这次到底买什么」（prompt + 点名产品 + 入边构成），
 * 报价 hash 由全部条目的 basisHash + 归一价 + revision 算出——图或文案变了，
 * 重算就对不上，`quote_stale`。
 */
export const canvasQuoteItemSchema = z
  .object({
    nodeId: nodeIdSchema,
    kind: canvasNodeKindSchema,
    mode: z.enum(["text_to_image", "text_to_video", "image_to_video"]),
    priceCny: z.number().nonnegative(),
    productName: z.string().optional(),
    summary: z.string(),
    basisHash: z.string(),
    /**
     * D 切片二：递归内容寻址的输入哈希——任一上游输入变即变，是复用判定键；
     * inputs 保画布顺序不排序（执行器按同序取首个可用图，顺序本身是语义）。
     * 切片一的旧 run 没有这个字段——缺省 = 不可作为复用判定键。
     */
    inputHash: z.string().optional(),
    /** 复用上一次 run 的成功产物：本次不执行、不计费。 */
    reused: z.boolean().optional(),
    /** 复用时指向被采纳的历史任务。 */
    adoptedJobId: z.string().optional(),
    /** 输入未变但被引用的历史产物已清理：本 run 里会 `blocked`/`output_purged`。 */
    purged: z.boolean().optional(),
  })
  .strict();
export type CanvasQuoteItem = z.infer<typeof canvasQuoteItemSchema>;

export const canvasQuoteSchema = z
  .object({
    hash: z.string(),
    totalCny: z.number().nonnegative(),
    /** 复用节点数（priceCny=0 的条目数），前端展示用；切片一旧 run 没有。 */
    reusedCount: z.number().int().nonnegative().optional(),
    items: z.array(canvasQuoteItemSchema),
  })
  .strict();
export type CanvasQuote = z.infer<typeof canvasQuoteSchema>;

/**
 * Run 级预算预留（D 切片二）：确认报价即冻结总价，余量随节点提交逐份转移给子
 * Job（`transfers` 台账幂等，份额锚定 jobId），run 终态余量自动停计。
 *
 * 会计不变量：一份份额在任意落盘态下恰好计一次——remaining 计未转移部分；
 * transfer 的 jobId 对应 job 文件缺失时该份额仍计占用；job 落盘后由
 * `job.reservation` 计。见 docs/plan-dag-run-slice2-2026-09-12.md §2.1。
 */
export const canvasRunTransferSchema = z
  .object({
    amountCny: z.number().nonnegative(),
    memberCny: z.number().nonnegative(),
    purchasedCny: z.number().nonnegative(),
    /** 份额锚定的子任务 id——job 文件缺失 ⇒ 这份钱仍算占用（不丢不超卖）。 */
    jobId: z.string(),
    subscriptionId: z.string().optional(),
    periodIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CanvasRunTransfer = z.infer<typeof canvasRunTransferSchema>;

export const canvasRunReservationSchema = z
  .object({
    amountCny: z.number().nonnegative(),
    memberCny: z.number().nonnegative(),
    purchasedCny: z.number().nonnegative(),
    remainingCny: z.number().nonnegative(),
    remainingMemberCny: z.number().nonnegative(),
    remainingPurchasedCny: z.number().nonnegative(),
    transfers: z.record(nodeIdSchema, canvasRunTransferSchema),
    subscriptionId: z.string().optional(),
    periodIndex: z.number().int().nonnegative().optional(),
    createdAt: z.string(),
  })
  .strict();
export type CanvasRunReservation = z.infer<typeof canvasRunReservationSchema>;

export const canvasRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(CANVAS_RUN_ID_RE),
    ownerId: z.string(),
    canvasId: z.string().regex(CANVAS_ID_RE),
    /** 冻结时的文档 revision——之后编辑画布不影响本次运行。 */
    documentRevision: z.number().int().nonnegative(),
    graphSnapshot: z
      .object({ nodes: z.array(canvasNodeSchema), edges: z.array(canvasEdgeSchema) })
      .strict(),
    /** 成交快照：执行器提交节点前重算归一价与它比对，不一致即 `price_changed`。 */
    quote: canvasQuoteSchema,
    idempotency: z.object({ key: z.string(), requestHash: z.string() }).strict().optional(),
    /** D 切片二：总价冻结（无 = 全部复用或旧版 run）。 */
    reservation: canvasRunReservationSchema.optional(),
    /** D 切片二：执行前需人工批准的节点（⊆ 生成节点）。 */
    gatedNodeIds: z.array(nodeIdSchema).optional(),
    /** D 切片二：本 run 强制重执行的节点（已展开为 gen 下游闭包）。 */
    regenerate: z.array(nodeIdSchema).optional(),
    status: canvasRunStatusSchema,
    /** 持久化取消意图：落盘后泵不再提交新节点，在途收敛完毕才进 `canceled`。 */
    cancelRequestedAt: z.string().optional(),
    nodeExecutions: z.array(canvasNodeExecutionSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().optional(),
  })
  .strict();
export type CanvasRun = z.infer<typeof canvasRunSchema>;

export const canvasRunCreateBodySchema = z
  .object({
    canvasId: z.string().regex(CANVAS_ID_RE),
    quoteHash: z.string().min(8).max(128),
    idempotencyKey: z.string().trim().min(8).max(128),
    /** 执行前需人工批准的生成节点（不进 quoteHash，进 requestHash）。 */
    approvalNodeIds: z.array(nodeIdSchema).max(CANVAS_MAX_NODE_IDS).optional(),
    /** 强制重跑：与报价时的 regenerate 一致，否则 `quote_stale`。 */
    regenerate: z.array(nodeIdSchema).max(CANVAS_MAX_NODE_IDS).optional(),
  })
  .strict();
export type CanvasRunCreateBody = z.infer<typeof canvasRunCreateBodySchema>;

/** 报价请求体（D 切片二）：`regenerate` 决定哪些节点不复用、按实计价。 */
export const canvasQuoteBodySchema = z
  .object({
    regenerate: z.array(nodeIdSchema).max(CANVAS_MAX_NODE_IDS).optional(),
  })
  .strict();
export type CanvasQuoteBody = z.infer<typeof canvasQuoteBodySchema>;

/** 审批门：`approve` 放行提交，`reject` 该节点 blocked 并传播下游。 */
export const canvasRunApprovalBodySchema = z
  .object({
    nodeId: nodeIdSchema,
    decision: z.enum(["approve", "reject"]),
  })
  .strict();
export type CanvasRunApprovalBody = z.infer<typeof canvasRunApprovalBodySchema>;
