import { readFile } from "node:fs/promises";
import { YMAN_IMAGE_CONFIG } from "@/lib/providers/openai-image/config";
import { makeOpenaiImageProvider } from "@/lib/providers/openai-image/native";
import { ymanGet, ymanPost } from "@/lib/providers/yman/client";
import {
  modelFor,
  ymanCapabilities,
  ymanMaxReferenceImages,
  ymanVideoRatios,
  ymanVideoResolutions,
} from "@/lib/providers/yman/catalog";
import { mapToYmanRequest, mapYmanTask } from "@/lib/providers/yman/rest-map";
import type {
  MediaRef,
  ProviderGenerateRequest,
  ProviderHandle,
  ProviderPoll,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * 生图走的是同一个 base + 同一把 key 的 `/images/generations`，协议与 OpenAI 那条一模一样，
 * 所以直接复用工厂而不是再抄一遍轮询 / 计费 / 取消的逻辑。它自己的 id 是 "yman"。
 */
const ymanImageDelegate = makeOpenaiImageProvider(YMAN_IMAGE_CONFIG);

/**
 * YMan 中转渠道（OpenAI 兼容的 `/videos` 三步：建任务 → 轮询 → 取 content）。
 * 接文生视频 / 图生视频 / 参考生视频，外加同一条 REST 上的文生图；编辑与延长仍留在
 * xAI（依赖它的 Files API），30 / 45 / 60 秒长片仍走一致性管线。路由在 `providers/router.ts`。
 */
export const ymanProvider: VideoProvider = {
  id: "yman",
  capabilities() {
    return {
      modes: ["text_to_video", "image_to_video", "reference_to_video", "text_to_image"],
      maxDurationSec: 30,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
      // 视频侧的画幅，由当前选中的两个视频模型给出（生图那条走 OpenAI 兼容通道，
      // 七个画幅都出得了，不受这条约束——路由也只在视频路径上看它）。
      aspectRatios: ymanVideoRatios(),
      // 上游按档计费，芯片上只能出现「会被计费的那个时长」。首页读的是第一顺位
      // provider 的这条，所以按 t2v 模型给。
      durations: ymanCapabilities(modelFor("text_to_video")).durations,
      // 当前目录里的视频模型都只出 720p；请求 1080p 的任务会被路由跳过而不是悄悄降档。
      resolutions: ymanVideoResolutions(),
      // 首帧与参考图在上游是同一个 `reference_images`，上限按 i2v/r2v 模型算（默认 9）。
      maxReferenceImages: ymanMaxReferenceImages(),
    };
  },
  async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
    if (req.mode === "text_to_image") return ymanImageDelegate.submit(req);
    const call = mapToYmanRequest({
      ...req,
      startImage: await toSendable(req.startImage),
      referenceImages: req.referenceImages
        ? await Promise.all(req.referenceImages.map((ref) => toSendable(ref) as Promise<MediaRef>))
        : undefined,
    });
    const data = await ymanPost("/videos", call.body);
    const remoteId = typeof data.id === "string" ? data.id.trim() : "";
    if (!remoteId) throw new Error("上游未返回任务 id");
    return { providerId: "yman", remoteId };
  },
  async poll(handle: ProviderHandle): Promise<ProviderPoll> {
    if (!handle.remoteId) {
      return { status: "failed", progress: 0, errorCode: "no_id", errorMessage: "缺少任务 id" };
    }
    let data: Record<string, unknown>;
    try {
      data = await ymanGet(`/videos/${encodeURIComponent(handle.remoteId)}`);
    } catch (error) {
      // 409 = 「还没就绪」，是进度而不是失败；当成一次 pending 轮询，由 runner 的超时兜底。
      if (error instanceof ProviderHttpError && error.code === "not_ready") {
        return { status: "pending", progress: 40 };
      }
      throw error;
    }
    return mapYmanTask(data);
  },
};

/** 落盘的首帧 / 参考图读成 data URI 再发（上游收 dataURL 字符串）；其余引用形态原样交给 rest-map。 */
async function toSendable(ref?: MediaRef): Promise<MediaRef | undefined> {
  if (!ref || ref.kind !== "path") return ref;
  const buf = await readFile(ref.path);
  const mime = ref.path.endsWith(".png") ? "image/png" : "image/jpeg";
  return { kind: "data_uri", dataUri: `data:${mime};base64,${buf.toString("base64")}` };
}
