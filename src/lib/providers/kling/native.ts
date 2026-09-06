import { readFile } from "node:fs/promises";
import { klingGet, klingPost } from "@/lib/providers/kling/client";
import { mapKlingTask, mapToKlingRequest } from "@/lib/providers/kling/rest-map";
import type {
  MediaRef,
  ProviderGenerateRequest,
  ProviderHandle,
  ProviderPoll,
  VideoProvider,
} from "@/lib/providers/types";

/**
 * 可灵直连（方案 docs/plan-kling-video.md）。只接文生视频与图生视频；
 * r2v / edit / extend / harness 仍走 xAI，路由在 `providers/router.ts`。
 */
export const klingProvider: VideoProvider = {
  id: "kling",
  capabilities() {
    return {
      modes: ["text_to_video", "image_to_video"],
      maxDurationSec: 10,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    };
  },
  async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
    const call = mapToKlingRequest({ ...req, startImage: await toSendable(req.startImage) });
    const data = await klingPost(call.path, call.body);
    const payload = isRecord(data.data) ? data.data : {};
    const remoteId = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!remoteId) throw new Error("上游未返回任务 id");
    return { providerId: "kling", remoteId };
  },
  async poll(handle: ProviderHandle): Promise<ProviderPoll> {
    if (!handle.remoteId) {
      return { status: "failed", progress: 0, errorCode: "no_id", errorMessage: "缺少任务 id" };
    }
    const data = await klingGet(`/tasks?task_ids=${encodeURIComponent(handle.remoteId)}`);
    const task = (Array.isArray(data.data) ? data.data : []).find(isRecord);
    if (!task) {
      return {
        status: "failed",
        progress: 0,
        errorCode: "not_found",
        errorMessage: "上游查不到该任务",
      };
    }
    return mapKlingTask(task);
  },
  /**
   * `mapToKlingRequest` sends our job id as `external_task_id` precisely so a submit whose
   * outcome we never recorded can be looked up instead of re-paid for. A free GET, so the
   * generic transient retry in `klingGet` applies.
   */
  async lookupByExternalId(externalId: string): Promise<string | null> {
    const data = await klingGet(
      `/tasks?external_task_ids=${encodeURIComponent(externalId)}`,
    );
    const task = (Array.isArray(data.data) ? data.data : []).find(isRecord);
    const remoteId = typeof task?.id === "string" ? task.id.trim() : "";
    return remoteId || null;
  },
};

/** 落盘的首帧读成 data URI 再发（上游接受 base64）；其余引用形态原样交给 rest-map。 */
async function toSendable(ref?: MediaRef): Promise<MediaRef | undefined> {
  if (!ref || ref.kind !== "path") return ref;
  const buf = await readFile(ref.path);
  const mime = ref.path.endsWith(".png") ? "image/png" : "image/jpeg";
  return { kind: "data_uri", dataUri: `data:${mime};base64,${buf.toString("base64")}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
