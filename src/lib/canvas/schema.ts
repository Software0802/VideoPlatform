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
