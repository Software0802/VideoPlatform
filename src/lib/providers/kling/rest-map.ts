import { klingUnitsToUsd } from "@/lib/cost";
import { klingVideoAudio, klingVideoModel, klingVideoResolution } from "@/lib/env";
import type { MediaRef, ProviderGenerateRequest, ProviderPoll } from "@/lib/providers/types";
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

/**
 * 上游 `duration` 的枚举只有 5 / 10（能力地图写的 3–10s 是营销口径）。
 * 4 秒的请求会被按 5 秒计费，所以归一后的值必须写回 job，账目才如实。
 */
export function normalizeKlingDuration(sec: number | undefined): 5 | 10 {
  if (sec == null || !Number.isFinite(sec)) return 5;
  return sec <= 5 ? 5 : 10;
}

/**
 * 一次可灵调用真正会用的三个参数。音频 = 实例允许有声（`KLING_VIDEO_AUDIO=native`）
 * **且**用户没有选无声（`req.generateAudio !== false`）；实例不允许时用户的选择被忽略，
 * UI 侧对应显示「无声 · 暂不可用」。有声只在 1080p 出片，所以 `native` 会把分辨率抬上去——
 * 静默降级会让成片与账单对不上；用户选无声时分辨率回到实例默认档，不再多收 1080p 的钱。
 */
export function resolveKlingSettings(req: ProviderGenerateRequest): KlingSettings {
  const audio: KlingSettings["audio"] =
    klingVideoAudio() === "native" && req.generateAudio !== false ? "native" : "off";
  const resolution = audio === "native" ? "1080p" : klingVideoResolution();
  return { resolution, audio, durationSec: normalizeKlingDuration(req.durationSec) };
}

export function mapToKlingRequest(req: ProviderGenerateRequest): KlingRestCall {
  const model = klingVideoModel();
  const { resolution, audio, durationSec } = resolveKlingSettings(req);
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
    // 尾帧永不进请求体：last_frame 只落盘，是全项目的硬约束。
    contents.push({ type: "first_frame", url: mediaToKlingUrl(req.startImage) });
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
