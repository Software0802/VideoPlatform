import { readFile } from "node:fs/promises";
import { ticksToUsd } from "@/lib/cost";
import { grokGet, grokPost } from "@/lib/providers/grok/client";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import { mapPoll, mapToGrokRest } from "@/lib/providers/grok/rest-map";
import type {
  MediaRef,
  ProviderGenerateRequest,
  ProviderHandle,
  ProviderPoll,
  VideoProvider,
} from "@/lib/providers/types";

export const grokNativeProvider: VideoProvider = {
  id: "grok",
  capabilities() {
    return {
      modes: [
        "text_to_image",
        "text_to_video",
        "image_to_video",
        "reference_to_video",
        "edit_video",
        "extend_video",
      ],
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    };
  },
  async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
    const hydrated = await hydratePaths(req);
    const call = mapToGrokRest(hydrated);
    const data = await grokPost(call.path, call.body);
    if (isImageMode(req.mode)) {
      return parseImageHandle(data);
    }
    const remoteId = String(data.request_id ?? data.id ?? "");
    if (!remoteId) throw new Error("上游未返回 request_id");
    return { providerId: "grok", remoteId };
  },
  async poll(handle: ProviderHandle): Promise<ProviderPoll> {
    if (!handle.remoteId) {
      return { status: "failed", progress: 0, errorCode: "no_id", errorMessage: "missing request_id" };
    }
    const data = await grokGet(`/videos/${handle.remoteId}`);
    return mapPoll(data);
  },
};

async function hydratePaths(req: ProviderGenerateRequest): Promise<ProviderGenerateRequest> {
  return {
    ...req,
    startImage: await toSendable(req.startImage),
    referenceImages: req.referenceImages
      ? ((await Promise.all(req.referenceImages.map(toSendable))).filter(
          Boolean,
        ) as NonNullable<ProviderGenerateRequest["referenceImages"]>)
      : undefined,
    sourceVideo: await toSendableVideo(req.sourceVideo),
  };
}

function parseImageHandle(data: Record<string, unknown>): ProviderHandle {
  const list = Array.isArray(data.data) ? data.data : [];
  const first = (list[0] ?? {}) as Record<string, unknown>;
  const url = typeof first.url === "string" ? first.url : undefined;
  const b64 = typeof first.b64_json === "string" ? first.b64_json : undefined;
  if (!url && !b64) throw new Error("上游未返回图片");
  const fileOutput = (first.file_output ?? {}) as Record<string, unknown>;
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const ticks = typeof usage.cost_in_usd_ticks === "number" ? usage.cost_in_usd_ticks : undefined;
  return {
    providerId: "grok",
    remoteUrl: url ?? `data:image/jpeg;base64,${b64}`,
    fileOutputId: typeof fileOutput.file_id === "string" ? fileOutput.file_id : undefined,
    costUsdActual: ticks != null ? ticksToUsd(ticks) : undefined,
    respectModeration:
      typeof first.respect_moderation === "boolean" ? first.respect_moderation : true,
  };
}

async function toSendable(ref?: MediaRef): Promise<MediaRef | undefined> {
  if (!ref) return undefined;
  if (ref.kind !== "path") return ref;
  const buf = await readFile(ref.path);
  const mime = ref.path.endsWith(".png") ? "image/png" : "image/jpeg";
  return { kind: "data_uri", dataUri: `data:${mime};base64,${buf.toString("base64")}` };
}

async function toSendableVideo(ref?: MediaRef): Promise<MediaRef | undefined> {
  if (!ref) return undefined;
  if (ref.kind === "file_id") return ref;
  throw new Error("源视频必须先经 Files API 上传，禁止 data URI");
}
