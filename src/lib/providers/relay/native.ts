import { readFile } from "node:fs/promises";
import { makeOpenaiImageProvider } from "@/lib/providers/openai-image/native";
import { relayGet, relayPost } from "@/lib/providers/relay/client";
import { relayVideoModes, type RelayView } from "@/lib/providers/relay/live";
import {
  mapRelayTask,
  mapToRelayRequest,
  type RelayRestContext,
} from "@/lib/providers/relay/rest-map";
import type {
  MediaRef,
  ProviderGenerateRequest,
  ProviderHandle,
  ProviderPoll,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * 一家 OpenAI 兼容中转 = 一段配置 + 这个工厂。
 *
 * 视频走 `/videos` 三步（建任务 → 轮询 → 取 content），能力全部从目录推导；
 * 生图委托 `makeOpenaiImageProvider`（`/images/generations` + `/images/edits`），
 * 与视频通道共用同一把 key、同一个 base。
 *
 * 从 `providers/yman/native.ts` 提炼：YMan 现在是 `makeRelayProvider(YMAN_RELAY)`。
 */
export function makeRelayProvider(view: RelayView): VideoProvider {
  const imageDelegate = view.image ? makeOpenaiImageProvider(view.image) : null;
  const catalog = view.catalog;
  const rest: RelayRestContext | null = catalog
    ? {
        id: view.id,
        name: view.name,
        base: view.base,
        catalog,
        creditsToUsd: view.creditsToUsd,
      }
    : null;
  return {
    id: view.id,
    hasKey: () => Boolean(view.apiKey()),
    capabilities() {
      return {
        modes: [...relayVideoModes(view), ...(imageDelegate ? (["text_to_image"] as const) : [])],
        // 上游按档计费，maxDurationSec 只是「这条通道宣称能接多长」的上限声明；
        // 真正的时长档由 catalog 的 durations 给。与 yman 时代一致给 30。
        maxDurationSec: catalog ? 30 : 0,
        supportsLastFrameLock: false,
        maxResolution: "1080p",
        // 视频侧的画幅，由当前选中的两个视频模型给出（生图那条走 OpenAI 兼容通道，
        // 七个画幅都出得了，不受这条约束——路由也只在视频路径上看它）。
        aspectRatios: catalog?.videoRatios(),
        // 上游按档计费，芯片上只能出现「会被计费的那个时长」。首页读的是第一顺位
        // provider 的这条，所以按 t2v 模型给。
        durations: catalog
          ? catalog.specFor(catalog.modelFor("text_to_video")).durations
          : undefined,
        // 当前目录里的视频模型都只出 720p；请求 1080p 的任务会被路由跳过而不是悄悄降档。
        resolutions: catalog?.videoResolutions(),
        // 首帧与参考图在上游是同一个 `reference_images`，上限按 i2v/r2v 模型算。
        maxReferenceImages: catalog?.maxReferenceImages(),
        supportsImageReference: view.image?.imageEditsEnabled() ?? false,
        // 本地等待上限（方案 §2 G6）。中转渠道排队时长不可控，所以给一个能调的开关，
        // 而不是让 runner 拿一个写死的 15 分钟去判「本地失败、上游照常计费」。
        taskTimeoutMs: view.videoTaskTimeoutMs(),
      };
    },
    validate(req: ProviderGenerateRequest): void {
      if (req.mode === "text_to_image") imageDelegate?.validate?.(req);
    },
    async submit(req: ProviderGenerateRequest): Promise<ProviderHandle> {
      if (req.mode === "text_to_image") {
        if (!imageDelegate) {
          throw new ProviderHttpError(400, "unsupported_mode", `${view.name} provider 不支持文生图`);
        }
        return imageDelegate.submit(req);
      }
      if (!rest) {
        throw new ProviderHttpError(400, "unsupported_mode", `${view.name} provider 不支持视频模式`);
      }
      const call = mapToRelayRequest(rest, {
        ...req,
        startImage: await toSendable(req.startImage),
        referenceImages: req.referenceImages
          ? await Promise.all(req.referenceImages.map((ref) => toSendable(ref) as Promise<MediaRef>))
          : undefined,
      });
      const data = await relayPost(view, "/videos", call.body);
      const remoteId = typeof data.id === "string" ? data.id.trim() : "";
      if (!remoteId) throw new Error("上游未返回任务 id");
      return { providerId: view.id, remoteId };
    },
    async poll(handle: ProviderHandle): Promise<ProviderPoll> {
      if (!handle.remoteId) {
        return { status: "failed", progress: 0, errorCode: "no_id", errorMessage: "缺少任务 id" };
      }
      let data: Record<string, unknown>;
      try {
        data = await relayGet(view, `/videos/${encodeURIComponent(handle.remoteId)}`);
      } catch (error) {
        // 409 = 「还没就绪」，是进度而不是失败；当成一次 pending 轮询，由 runner 的超时兜底。
        if (error instanceof ProviderHttpError && error.code === "not_ready") {
          return { status: "pending", progress: 40 };
        }
        throw error;
      }
      if (!rest) {
        return { status: "failed", progress: 0, errorCode: "unsupported_mode", errorMessage: "该 provider 不支持视频模式" };
      }
      return mapRelayTask(rest, data);
    },
  };
}

/** 落盘的首帧 / 参考图读成 data URI 再发（上游收 dataURL 字符串）；其余引用形态原样交给 rest-map。 */
async function toSendable(ref?: MediaRef): Promise<MediaRef | undefined> {
  if (!ref || ref.kind !== "path") return ref;
  const buf = await readFile(ref.path);
  const mime = ref.path.endsWith(".png") ? "image/png" : "image/jpeg";
  return { kind: "data_uri", dataUri: `data:${mime};base64,${buf.toString("base64")}` };
}
