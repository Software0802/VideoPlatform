import { createJob } from "@/lib/jobs/create";
import type { CreateJobBody } from "@/lib/jobs/schema";
import { isTerminalStatus } from "@/lib/jobs/schema";
import { lookupIdempotency } from "@/lib/jobs/idempotency";
import { readJobForUser, toPublic } from "@/lib/jobs/store";
import { copyUpload, storeUploadFromBuffer } from "@/lib/jobs/upload";
import { ProviderHttpError } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { updateCanvas, readCanvas } from "@/lib/canvas/store";
import type { CanvasDocument, CanvasNode } from "@/lib/canvas/schema";
import type { JobPublic } from "@/lib/jobs/schema";

/**
 * 画布节点的「运行」（C 包）：把一条 gen_* 节点变成一次真实的 `createJob`——
 * 走的是与 `POST /api/jobs` 完全相同的准入、计价、预留与幂等路径，不另起炉灶。
 *
 * 提示词 = 连线进来的 text 节点内容（按画布顺序拼接）+ 节点自己的 prompt。
 * 图片输入解析顺序：material 节点的 `uploadId` > 上游 gen_image 节点的产物
 * （读它的 `outputs/image.jpg` 复制成一份 `start` 上传——与 `/api/uploads/from-job`
 * 同一条链路，复制而不是引用，原任务被清理也不会带走输入）。
 *
 * D 包修订的三件事：
 * - **素材不消耗**：`createJob` 的 `claim()` 会 move 文件并删 sidecar，直接把
 *   material 的 `uploadId` 传进去等于让它变成一次性素材（第二个消费它的节点、
 *   同一节点的第二次运行都会 400）。这里一律 `copyUpload` 复制后再交出去。
 * - **崩溃窗口**：提交前先按幂等键 `canvas:<canvasId>:<nodeId>:<runSeq>` 查回
 *   既有任务接管——「建了任务没写回 jobId」之间崩溃时，重试会复制出一份新的
 *   uploadId，同 key 异参只会撞 `idempotency_conflict`；查回接管则不会。
 * - **输入失效不静默降级**：图上接了图片来源却一份都解析不出来时报
 *   `input_missing`，而不是悄悄退成文生视频交一个不相干的产物。
 *
 * 幂等：节点已有未终态任务时直接交回（重复点击 / 网络重试不会再建一条）；
 * runSeq 在任务写回后才自增。
 */

const OUTPUT_IMAGE_REL = "outputs/image.jpg";

function inputsOf(doc: CanvasDocument, nodeId: string): CanvasNode[] {
  const from = new Set(doc.edges.filter((e) => e.to === nodeId).map((e) => e.from));
  return doc.nodes.filter((n) => from.has(n.id));
}

async function resolveImageInput(
  doc: CanvasDocument,
  node: CanvasNode,
  ownerId: string,
): Promise<string | undefined> {
  const inputs = inputsOf(doc, node.id);
  const imageCapable = inputs.some((n) => n.kind === "material" || n.kind === "gen_image");
  for (const input of inputs) {
    if (input.kind === "material" && input.uploadId) {
      try {
        const side = await copyUpload(input.uploadId, "start", ownerId);
        return side.uploadId;
      } catch {
        continue; // 素材不在了：试下一个候选，全不行才判失败。
      }
    }
    if (input.kind === "gen_image" && input.jobId) {
      const job = await readJobForUser(input.jobId, ownerId);
      if (!job || job.status !== "succeeded" || job.output?.kind !== "image" || job.artifactsPurgedAt) {
        continue;
      }
      try {
        const bytes = await mediaStore.readJobFile(job.id, OUTPUT_IMAGE_REL);
        const side = await storeUploadFromBuffer(bytes, "start", ownerId);
        return side.uploadId;
      } catch {
        continue; // 产物文件不在盘上了：当作没有这份输入，不伪造引用。
      }
    }
  }
  if (imageCapable) {
    throw new ProviderHttpError(400, "input_missing", "连入的图片素材不可用，请重新上传或重跑上游节点");
  }
  return undefined;
}

export async function runCanvasNode(
  ownerId: string,
  canvasId: string,
  nodeId: string,
): Promise<{ canvas: CanvasDocument; job: JobPublic }> {
  const doc = await readCanvas(ownerId, canvasId);
  if (!doc) throw new ProviderHttpError(404, "not_found", "画布不存在");
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new ProviderHttpError(404, "not_found", "节点不存在");
  if (node.kind !== "gen_image" && node.kind !== "gen_video") {
    throw new ProviderHttpError(400, "invalid_argument", "只有生成节点可以运行");
  }

  // 已有未终态任务 = 这次运行还没结算：交回同一个，不再建。
  if (node.jobId) {
    const running = await readJobForUser(node.jobId, ownerId);
    if (running && !isTerminalStatus(running.status)) {
      return { canvas: doc, job: toPublic(running) };
    }
  }

  const idempotencyKey = `canvas:${canvasId}:${nodeId}:${node.runSeq ?? 0}`;

  // 崩溃窗口：上次可能已把任务建出来而没写回 jobId。先按幂等键查回接管——
  // 重新解析输入会复制出新的 uploadId，同 key 异参只会撞 409。
  const priorJobId = await lookupIdempotency(ownerId, idempotencyKey);
  if (priorJobId && priorJobId !== node.jobId) {
    const prior = await readJobForUser(priorJobId, ownerId);
    if (prior) {
      const adopted = await updateCanvas(ownerId, canvasId, (d) => {
        const target = d.nodes.find((n) => n.id === nodeId);
        if (!target || target.jobId === prior.id) return undefined;
        return {
          ...d,
          nodes: d.nodes.map((n) =>
            n.id === nodeId ? { ...n, jobId: prior.id, runSeq: (n.runSeq ?? 0) + 1 } : n,
          ),
        };
      });
      if (!adopted) throw new ProviderHttpError(404, "not_found", "画布不存在");
      return { canvas: adopted, job: toPublic(prior) };
    }
  }

  const parts = [
    ...inputsOf(doc, node.id)
      .filter((n) => n.kind === "text" && n.text?.trim())
      .map((n) => n.text!.trim()),
    node.prompt?.trim() ?? "",
  ].filter(Boolean);
  if (!parts.length) {
    throw new ProviderHttpError(400, "invalid_argument", "生成节点需要提示词（节点自身或连入的文本节点）");
  }
  const prompt = parts.join("\n");

  const startUploadId = node.kind === "gen_video" ? await resolveImageInput(doc, node, ownerId) : undefined;

  const body: CreateJobBody = {
    mode: node.kind === "gen_image" ? "text_to_image" : startUploadId ? "image_to_video" : "text_to_video",
    prompt,
    ...(node.product ? { model: node.product } : {}),
    ...(startUploadId ? { startUploadId } : {}),
    idempotencyKey,
  };

  const { job } = await createJob(body, ownerId);
  const next = await updateCanvas(ownerId, canvasId, (d) => {
    const target = d.nodes.find((n) => n.id === nodeId);
    if (!target || target.jobId === job.id) return undefined;
    return {
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === nodeId ? { ...n, jobId: job.id, runSeq: (n.runSeq ?? 0) + 1 } : n,
      ),
    };
  });
  if (!next) throw new ProviderHttpError(404, "not_found", "画布不存在");
  return { canvas: next, job };
}
