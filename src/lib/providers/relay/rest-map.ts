import { normalizeUpResolution, resolutionRank } from "@/lib/providers/resolution";
import type { RelayCatalog, RelayResolution } from "@/lib/providers/relay/catalog";
import type {
  AspectRatio,
  MediaRef,
  ProviderGenerateRequest,
  ProviderPoll,
} from "@/lib/providers/types";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * OpenAI `/videos` 三步协议的请求/轮询映射——从 `providers/yman/rest-map.ts` 提炼。
 * 与具体上游解耦的部分：模型目录（档位、画幅、参考图上限、价目）由 `RelayCatalog`
 * 注入；计费折算由 `creditsToUsd` 注入；provider 名只进错误文案。
 */

export type RelayRestCall = {
  body: Record<string, unknown>;
};

export type RelaySettings = {
  model: string;
  durationSec: number;
  resolution: RelayResolution;
  ratio: AspectRatio;
};

/** rest-map 需要的最小视图：目录 + 成片 URL 的 base + 积分折算 + 文案名。 */
export type RelayRestContext = {
  /** provider id——失败任务的兜底 errorCode 用它命名（`<id>_failed`）。 */
  id: string;
  name: string;
  base(): string;
  catalog: RelayCatalog;
  creditsToUsd(credits: number): number;
};

/**
 * 一次调用真正会用的四个参数。
 *
 * 时长与分辨率**归一**到该模型接得下的档位：上游按档计费，用户选 4 秒拿到 5 秒的片、
 * 付 5 秒的钱，只要 `create.ts` 把归一后的值写回 job，界面与账单就仍然一致；报错则是
 * 把一个能做的任务做不成。
 *
 * 画幅**不归一**：16:9 与 9:16 是两个不同的东西，把用户选的竖屏悄悄换成横屏不是「归一」，
 * 是交付了另一个东西。接不下这个画幅的路由结果由 `providers/router.ts` 挡在前面（换一家
 * 接得下的），真走到这里还是接不下就 400 —— 见 `mapToRelayRequest`。
 * `model` 一律归一成 `/v1/models` 的展示名（`resolveModel`），发给上游的就是这一串。
 */
export function resolveRelaySettings(
  rt: RelayRestContext,
  req: ProviderGenerateRequest,
  defaults?: { resolution?: RelayResolution },
): RelaySettings {
  const model = req.model?.trim() ? rt.catalog.resolveModel(req.model) : rt.catalog.modelFor(req.mode);
  const caps = rt.catalog.specFor(model);
  // 用户选的档优先，向上归一到这个模型出得了的最近一档（480p → 720p）。一档都不够高时
  // 落到该模型最高的一档：这种请求本该被路由（`capabilities().resolutions`）或产品校验
  // 挡在前面 400，走到这里说明是别处配错了，宁可出片也不炸——但绝不悄悄涨价，
  // `create.ts` 用同一个函数定价。
  const supported = caps.resolutions.length ? caps.resolutions : (["720p"] as RelayResolution[]);
  const asked = req.resolution ?? defaults?.resolution;
  const byRank = [...supported].sort((a, b) => resolutionRank(a) - resolutionRank(b));
  const resolution =
    (normalizeUpResolution(asked, supported) as RelayResolution | undefined) ??
    // 没选就用最低档（便宜的那个），选了却一档都不够高就用最高档。
    (asked ? byRank[byRank.length - 1] : byRank[0]);
  return {
    model,
    durationSec: rt.catalog.normalizeDuration(model, req.durationSec),
    resolution,
    ratio: req.aspectRatio ?? caps.ratios[0] ?? "16:9",
  };
}

/**
 * 上游只看短边判档（<1080 → 720p，≥1080 → 1080p），比例由宽高比决定：
 * 16:9 → 1280x720、9:16 → 720x1280、1:1 → 720x720。这里按同一条规则算，
 * 所以将来目录里加了别的比例也不用改这段。
 */
export function relaySize(ratio: AspectRatio, resolution: RelayResolution): string {
  const short = resolution === "1080p" ? 1080 : 720;
  const [w, h] = ratio.split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return `${Math.round((short * 16) / 9)}x${short}`;
  }
  return w >= h
    ? `${Math.round((short * w) / h)}x${short}`
    : `${short}x${Math.round((short * h) / w)}`;
}

export function mapToRelayRequest(rt: RelayRestContext, req: ProviderGenerateRequest): RelayRestCall {
  const { model, durationSec, resolution, ratio } = resolveRelaySettings(rt, req);
  const caps = rt.catalog.specFor(model);

  if (req.mode !== "text_to_video" && req.mode !== "image_to_video" && req.mode !== "reference_to_video") {
    throw new ProviderHttpError(400, "unsupported_mode", `${rt.name} provider 不支持 ${req.mode}`);
  }
  if (!req.prompt.trim() && req.mode === "text_to_video") {
    throw new ProviderHttpError(400, "invalid_argument", "文生视频需要提示词");
  }
  // 兜底：路由本该按 `capabilities().aspectRatios` 把这种请求交给别家，走到这里说明
  // 两个视频模型混搭出了并集里有、这个模型没有的画幅。宁可 400 也不改写用户选的画幅。
  if (!caps.ratios.includes(ratio)) {
    throw new ProviderHttpError(
      400,
      "invalid_argument",
      `模型 ${model} 不支持 ${ratio} 画幅，请换画幅或换模型`,
    );
  }

  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    // 上游两种都收，字符串是文档里的写法。
    seconds: String(durationSec),
    size: relaySize(ratio, resolution),
  };

  // 尾帧永不进请求体——全项目硬约束，`last_frame` 只落盘。
  const references = referenceUris(req);
  if (references.length) {
    if (caps.maxReferenceImages <= 0) {
      throw new ProviderHttpError(
        400,
        "invalid_argument",
        `模型 ${model} 不接受参考图，请改用支持参考图的模型`,
      );
    }
    // 上游 413 是「参考过大」，超量则是 400；本地先截断到该模型的上限，
    // 免得把一次会被拒的请求发出去（被受理的请求就已经预扣积分了）。
    body.reference_images = references.slice(0, caps.maxReferenceImages);
  } else if (req.mode !== "text_to_video") {
    throw new ProviderHttpError(400, "invalid_argument", "图生视频需要首帧图或参考图");
  }

  return { body };
}

/**
 * i2v 只发首帧一张；r2v 发参考图组。上游的 `reference_images` 收
 * `{b64_json}` / `{url}` / dataURL 字符串三种，dataURL 字符串最省事，
 * `native` 层已经把落盘文件读成 data URI 了。
 */
function referenceUris(req: ProviderGenerateRequest): string[] {
  if (req.mode === "image_to_video") {
    return req.startImage ? [mediaToRelayUri(req.startImage)] : [];
  }
  if (req.mode === "reference_to_video") {
    const refs = req.referenceImages ?? [];
    const uris = refs.map(mediaToRelayUri);
    // 首帧在 r2v 里也是一张参考图，放最前面。
    return req.startImage ? [mediaToRelayUri(req.startImage), ...uris] : uris;
  }
  return [];
}

function mediaToRelayUri(ref: MediaRef): string {
  if (ref.kind === "data_uri") return ref.dataUri;
  if (ref.kind === "url") return ref.url;
  throw new ProviderHttpError(400, "invalid_argument", "参考图必须先转成 data URI 或公网 URL");
}

/**
 * `GET /videos/{id}` → 统一的轮询结果。
 *
 * `remoteUrl` 是 `<base>/videos/<id>/content`，**需要 Bearer**（见
 * `@/lib/media/download-headers`），不是可以匿名拉的 CDN 直链。
 */
export function mapRelayTask(rt: RelayRestContext, task: Record<string, unknown>): ProviderPoll {
  const status = typeof task.status === "string" ? task.status : "";
  const id = typeof task.id === "string" ? task.id.trim() : "";
  const usage = relayUsage(rt, task);

  if (status === "completed") {
    return {
      status: "done",
      progress: 100,
      remoteUrl: id ? `${rt.base()}/videos/${encodeURIComponent(id)}/content` : undefined,
      usage,
    };
  }

  if (status === "failed") {
    const error = isRecord(task.error) ? task.error : undefined;
    return {
      status: "failed",
      progress: 0,
      errorCode: typeof error?.code === "string" && error.code ? error.code : `${rt.id}_failed`,
      errorMessage:
        typeof error?.message === "string" && error.message ? error.message : "生成失败",
      usage,
    };
  }

  // queued / in_progress / 上游将来加的新状态：一律当作还在跑，由 runner 的超时兜底。
  return { status: "pending", progress: status === "in_progress" ? 40 : 5, usage };
}

/**
 * 本地**估算**的这次调用花费，不是上游回传的账单——中转的任务响应不带扣费明细，
 * 只在积分流水里能看到。按目录价（积分 = 分辨率价 + 时长价）折成美元；
 * 认不出模型时按 unknownCredits 记。响应里连模型名都没有就干脆不写，
 * 让提交时的 `costUsdEstimate` 留着，而不是用一个更糟的数覆盖它。
 */
function relayUsage(rt: RelayRestContext, task: Record<string, unknown>): ProviderPoll["usage"] {
  const model = typeof task.model === "string" ? task.model.trim() : "";
  if (!model) return undefined;
  const seconds = Number(task.seconds);
  const durationSec = rt.catalog.normalizeDuration(model, Number.isFinite(seconds) ? seconds : undefined);
  const credits = rt.catalog.creditsFor(model, durationSec, resolutionOfSize(task.size));
  return { costUsdActual: rt.creditsToUsd(credits), raw: task };
}

/** 上游只按短边判档：<1080 → 720p，≥1080 → 1080p。认不出的 size 按 720p 记。 */
function resolutionOfSize(size: unknown): RelayResolution {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size ?? "").trim());
  if (!m) return "720p";
  const short = Math.min(Number(m[1]), Number(m[2]));
  return Number.isFinite(short) && short >= 1080 ? "1080p" : "720p";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
