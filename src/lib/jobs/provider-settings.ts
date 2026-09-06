import type { VideoPricingHint } from "@/lib/cost";
import { klingVideoModel, openaiImageModel, ymanImageModel } from "@/lib/env";
import { modelForMode } from "@/lib/providers/grok/mode-matrix";
import { resolveKlingSettings } from "@/lib/providers/kling/rest-map";
import { modelFor as ymanModelFor } from "@/lib/providers/yman/catalog";
import { resolveYmanSettings } from "@/lib/providers/yman/rest-map";
import type { AspectRatio, NativeMode, ProviderId } from "@/lib/providers/types";
import type { CreateJobBody } from "@/lib/jobs/schema";

/**
 * 「选定 provider 后，这次调用的参数该长什么样」。
 *
 * 从 `create.ts` 提出来，是为了让 runner 在「某家积分耗尽、任务改走另一家」时能用同一套
 * 归一逻辑重算 model / 时长 / 分辨率 / 估价——runner 不能 import `create.ts`（那边有队列
 * 准入、配额、素材认领这些只属于建任务的副作用）。
 */

/**
 * Model名与 provider 必须同源：OpenAI 生图用 OPENAI_IMAGE_MODEL、可灵视频用 KLING_VIDEO_MODEL、
 * YMan 视频用它的展示名目录、YMan 生图用 YMAN_IMAGE_MODEL，其余仍按 mode 走 Grok 矩阵。
 * 对既有的 grok / mock 任务，本函数与 `modelForMode` 结果完全一致。
 */
export function modelForProvider(provider: ProviderId, mode: NativeMode): string {
  if (provider === "openai") return openaiImageModel();
  if (provider === "kling") return klingVideoModel();
  if (provider === "yman") return mode === "text_to_image" ? ymanImageModel() : ymanModelFor(mode);
  return modelForMode(mode);
}

/**
 * 一次视频调用**归一到上游档位后**的参数，与 provider 无关的那部分。
 * `null` 表示这个 provider 不需要归一（grok / mock 按请求原样发）。
 */
export type ProviderSettings = {
  durationSec: number;
  resolution: "720p" | "1080p";
  audio: "off" | "native";
  ratio?: AspectRatio;
};

/**
 * 选中的 provider 接得下这个任务时给出归一后的参数，否则 null（调用方按原逻辑走）。
 * 只有 provider 真的被选中、且是它声明支持的视频模式时才归一——别家的记录不能被
 * 这家的枚举改写。
 */
export function providerSettingsFor(
  provider: ProviderId,
  mode: NativeMode,
  durationSec: number | undefined,
  body: Pick<CreateJobBody, "prompt" | "aspectRatio" | "resolution" | "generateAudio">,
  model: string,
): ProviderSettings | null {
  const req = {
    jobId: "preview",
    mode,
    prompt: body.prompt,
    model,
    durationSec,
    aspectRatio: body.aspectRatio,
    resolution: body.resolution,
    generateAudio: body.generateAudio ?? true,
  };
  if (provider === "kling") {
    if (mode !== "text_to_video" && mode !== "image_to_video") return null;
    const kling = resolveKlingSettings(req);
    return { durationSec: kling.durationSec, resolution: kling.resolution, audio: kling.audio };
  }
  if (provider === "yman") {
    if (mode !== "text_to_video" && mode !== "image_to_video" && mode !== "reference_to_video") {
      return null;
    }
    const yman = resolveYmanSettings(req);
    // YMan 的建任务接口没有音频开关（出不出声由模型决定），所以记录一律记无声：
    // 记成有声就是拿一个我们控制不了的东西向用户收有声的加价。
    return {
      durationSec: yman.durationSec,
      resolution: yman.resolution,
      audio: "off",
      ratio: yman.ratio,
    };
  }
  return null;
}

export function videoPricingOf(
  settings: ProviderSettings | null,
  provider: ProviderId,
): VideoPricingHint | undefined {
  return settings
    ? { resolution: settings.resolution, audio: settings.audio, provider }
    : undefined;
}
