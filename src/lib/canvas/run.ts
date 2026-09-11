import { createJob } from "@/lib/jobs/create";
import type { CreateJobBody } from "@/lib/jobs/schema";
import { isTerminalStatus } from "@/lib/jobs/schema";
import { readJobForUser, toPublic } from "@/lib/jobs/store";
import { storeUploadFromBuffer } from "@/lib/jobs/upload";
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
 * 幂等：节点已有未终态任务时直接交回（重复点击 / 网络重试不会再建一条）；
 * 幂等键 `canvas:<canvasId>:<nodeId>:<runSeq>`，runSeq 在任务写回后才自增——
 * 崩溃在「建了任务、没写回」之间时，重试按同 seq 命中映射而不是再建一条。
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
  for (const input of inputsOf(doc, node.id)) {
    if (input.kind === "material" && input.uploadId) return input.uploadId;
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
    idempotencyKey: `canvas:${canvasId}:${nodeId}:${node.runSeq ?? 0}`,
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
