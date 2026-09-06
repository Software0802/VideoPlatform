import { klingUnitsToUsd } from "@/lib/cost";
import { klingVideoAudio, klingVideoModel, klingVideoResolution } from "@/lib/env";
import { normalizeUpResolution } from "@/lib/providers/resolution";
import type { MediaRef, ProviderGenerateRequest, ProviderPoll, Resolution } from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

export type KlingRestCall = {
  /** 拼在 `klingBase()` 后面，模型名是路径段的一部分。 */
  path: string;
  body: Record<string, unknown>;
};

export type KlingSettings = {
  resolution: "720p" | "1080p";
  audio: "off" | "native";
  durationSec: 5 | 10;
};

/** 可灵 t2v 只收这三种画幅；UI 恰好也只有这三种。i2v 不发画幅，随首帧。 */
const KLING_ASPECT_RATIOS: readonly string[] = ["16:9", "9:16", "1:1"];

/** 上游出得了的两档。480p 的请求向上归一到 720p（`normalizeUpResolution`）。 */
export const KLING_RESOLUTIONS: readonly Extract<Resolution, "720p" | "1080p">[] = ["720p", "1080p"];

/**
 * 产品目录给这次调用定的默认档（`jobs/provider-settings.ts` 传入）。
 * 省略时回落到 `KLING_VIDEO_RESOLUTION` / `KLING_VIDEO_AUDIO` —— 那两个变量从
 * 「覆盖用户选择」降级成「产品没说话时的默认」。
 */
export type KlingDefaults = {
  resolution?: KlingSettings["resolution"];
  audio?: KlingSettings["audio"];
};

/**
 * 上游 `duration` 的枚举只有 5 / 10（能力地图写的 3–10s 是营销口径）。
 * 4 秒的请求会被按 5 秒计费，所以归一后的值必须写回 job，账目才如实。
 */
export function normalizeKlingDuration(sec: number | undefined): 5 | 10 {
  if (sec == null || !Number.isFinite(sec)) return 5;
  return sec <= 5 ? 5 : 10;
}

/**
 * 一次可灵调用真正会用的三个参数。
 *
 * 音频 = 这次调用允许有声（产品声明 `native`，或实例 `KLING_VIDEO_AUDIO=native`）**且**
 * 用户没有选无声（`req.generateAudio !== false`）；不允许时用户的选择被忽略，UI 侧对应
 * 显示「无声 · 暂不可用」。
 *
 * 分辨率**先看用户**（`req.resolution`，向上归一到上游出得了的档：480p → 720p），用户没选
 * 才用产品默认 / 实例默认。两个例外会把它抬到 1080p 并**写回记录**（`create.ts` 用同一个
 * 函数定价，所以账单与成片始终同档）：有声只在 1080p 出片；带尾帧的图生视频上游同样只在
 * 1080p 接受。静默降级则一律不做——那是交付了另一个东西。
 */
export function resolveKlingSettings(
  req: ProviderGenerateRequest,
  defaults?: KlingDefaults,
): KlingSettings {
  const allowsAudio = (defaults?.audio ?? klingVideoAudio()) === "native";
  const audio: KlingSettings["audio"] =
    allowsAudio && req.generateAudio !== false ? "native" : "off";
  const asked = normalizeUpResolution(req.resolution, KLING_RESOLUTIONS) as
    | KlingSettings["resolution"]
    | undefined;
  const base = asked ?? defaults?.resolution ?? klingVideoResolution();
  const resolution = audio === "native" || hasLastFrame(req) ? "1080p" : base;
  return { resolution, audio, durationSec: normalizeKlingDuration(req.durationSec) };
}

/**
 * 尾帧只在图生视频里有意义（首帧 + 尾帧 = 一段被两头锁住的运动）。文生视频带着尾帧
 * 既发不出去也不该把分辨率抬到 1080p——那是让用户为一个用不上的东西多付 50%。
 */
function hasLastFrame(req: ProviderGenerateRequest): boolean {
  return req.mode === "image_to_video" && Boolean(req.lastImage);
}

export function mapToKlingRequest(
  req: ProviderGenerateRequest,
  defaults?: KlingDefaults,
): KlingRestCall {
  const model = req.model?.trim() || klingVideoModel();
  const { resolution, audio, durationSec } = resolveKlingSettings(req, defaults);
  // external_task_id 让「POST 超时但上游已建任务」可以按 jobId 找回，避免二次计费；
  // 不发 callback_url——轮询是真相。
  const options = {
    external_task_id: req.jobId,
    watermark_info: { enabled: false },
  };

  if (req.mode === "text_to_video") {
    if (!req.prompt.trim()) {
      throw new ProviderHttpError(400, "invalid_argument", "文生视频需要提示词");
    }
    const aspectRatio = req.aspectRatio ?? "16:9";
    if (!KLING_ASPECT_RATIOS.includes(aspectRatio)) {
      throw new ProviderHttpError(400, "invalid_argument", "可灵只支持 16:9 / 9:16 / 1:1 画幅");
    }
    return {
      path: `/text-to-video/${model}`,
      body: {
        prompt: req.prompt,
        settings: { audio, resolution, aspect_ratio: aspectRatio, duration: durationSec },
        options,
      },
    };
  }

  if (req.mode === "image_to_video") {
    if (!req.startImage) {
      throw new ProviderHttpError(400, "invalid_argument", "图生视频需要首帧图");
    }
    const contents: Record<string, unknown>[] = [];
    // 提示词对 i2v 可选；空串发上去会被上游按非法参数拒掉，所以有内容才带。
    if (req.prompt.trim()) contents.push({ type: "prompt", text: req.prompt });
    contents.push({ type: "first_frame", url: mediaToKlingUrl(req.startImage) });
    // 尾帧：可灵是唯一收它的通道（`supportsLastFrameLock`），且上游只在 1080p 接受——
    // 上面的 `resolveKlingSettings` 已经把 resolution 抬到 1080p，`create.ts` 用同一个
    // 函数定价，所以这里不会出现「发了 1080p、按 720p 收钱」。grok 那条通道仍然永不
    // 发送尾帧（`grok/rest-map.ts` 的 golden test 保障）。
    if (req.lastImage) {
      contents.push({ type: "last_frame", url: mediaToKlingUrl(req.lastImage) });
    }
    return {
      path: `/image-to-video/${model}`,
      body: {
        contents,
        settings: { audio, resolution, duration: durationSec },
        options,
      },
    };
  }

  throw new ProviderHttpError(400, "unsupported_mode", `可灵 provider 不支持 ${req.mode}`);
}

/** 上游接受公网 URL 或 base64（data URI）。`path` 由 native 层先读成 data URI。 */
function mediaToKlingUrl(ref: MediaRef): string {
  if (ref.kind === "data_uri") return ref.dataUri;
  if (ref.kind === "url") return ref.url;
  throw new ProviderHttpError(400, "invalid_argument", "首帧必须先转成 data URI 或公网 URL");
}

/**
 * `GET /tasks` 里的一条任务 → 统一的轮询结果。
 *
 * 可灵是三家 provider 里唯一在响应里给出真实扣费的（`billing`），所以 `costUsdActual`
 * 来自它而不是本地估价；只有换算得出的口径才写，人民币额度不换算。
 */
export function mapKlingTask(task: Record<string, unknown>): ProviderPoll {
  const status = typeof task.status === "string" ? task.status : "";
  const usage = klingUsage(task.billing);

  if (status === "succeeded") {
    const outputs = Array.isArray(task.outputs) ? task.outputs : [];
    const video = outputs.find(
      (o): o is Record<string, unknown> => isRecord(o) && o.type === "video",
    );
    const duration = Number(video?.duration);
    return {
      status: "done",
      progress: 100,
      remoteUrl: typeof video?.url === "string" ? video.url : undefined,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      usage,
    };
  }

  if (status === "failed") {
    return {
      status: "failed",
      progress: 0,
      errorCode: "kling_failed",
      errorMessage: typeof task.message === "string" && task.message ? task.message : "生成失败",
      usage,
    };
  }

  // submitted / processing / 上游将来加的新状态：一律当作还在跑，由 runner 的超时兜底。
  return { status: "pending", progress: status === "processing" ? 40 : 5, usage };
}

/**
 * `billing` 的真实扣费。资源包场景是 `charge_type: "unit"`（积分），现金场景是 `"cash"`。
 * 现金只认 USD——上游也可能以人民币额度结算，混进 `costUsdActual` 就是两种货币记在同一个
 * 字段里，那比没有数字更糟；这种情况只留 `raw` 供人工对账。
 */
function klingUsage(raw: unknown): ProviderPoll["usage"] {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  let units = 0;
  let unitSeen = false;
  let cashUsd = 0;
  let cashUsdSeen = false;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount)) continue;
    if (entry.charge_type === "unit") {
      units += amount;
      unitSeen = true;
    } else if (entry.charge_type === "cash" && entry.currency === "USD") {
      cashUsd += amount;
      cashUsdSeen = true;
    }
  }
  const costUsdActual = unitSeen
    ? klingUnitsToUsd(units)
    : cashUsdSeen
      ? Math.round(cashUsd * 1e6) / 1e6
      : undefined;
  return { costUsdActual, raw };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
