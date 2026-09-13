import {
  forceMock,
  hasXaiKey,
  imageProviderOrderCompat,
  imageProviderOrderRaw,
  klingVideoAudio,
  videoProviderOrderCompat,
  videoProviderOrderRaw,
} from "@/lib/env";
import { log } from "@/lib/log";
import { isExhausted, type ExhaustionKind } from "@/lib/providers/exhaustion";
import { RESOLUTION_TIERS, resolutionRank, servesResolution } from "@/lib/providers/resolution";
import { grokNativeProvider } from "@/lib/providers/grok/native";
import { ASPECT_RATIOS } from "@/lib/providers/grok/mode-matrix";
import { isHarnessDuration } from "@/lib/harness/durations";
import { mockProvider } from "@/lib/providers/mock";
import { ProviderHttpError } from "@/lib/providers/types";
import "@/lib/providers/builtin";
import { liveRelayViews } from "@/lib/providers/relay/live";
import {
  hasProviderKey as registryHasProviderKey,
  isRegisteredProviderId,
  providerForId as registryProviderForId,
  registeredProviderIds,
} from "@/lib/providers/registry";
import type {
  AspectRatio,
  NativeMode,
  ProviderGenerateRequest,
  ProviderId,
  Resolution,
  VideoProvider,
} from "@/lib/providers/types";

/**
 * 一个 provider 有没有可用的 key。路由第一关问的就是它——没有 key 的 provider
 * 无论排在多前面都不参与。判据在 `registry.ts`（provider 自己的 `hasKey` 优先，
 * 内置各家回落既有 env 判据）。
 */
export function hasProviderKey(id: ProviderId): boolean {
  return registryHasProviderKey(id);
}

/**
 * ORDER 里出现未注册 id 时只 warn 一次（每个 id 每进程一次）：ORDER 是运维写错的
 * 重灾区，每次调用都刷日志会把真正的告警淹掉。
 */
const warnedUnknownProviderIds = new Set<string>();

function knownProviderId(envName: string, id: string): id is ProviderId {
  if (isRegisteredProviderId(id)) return true;
  if (!warnedUnknownProviderIds.has(id)) {
    warnedUnknownProviderIds.add(id);
    log("warn", `${envName} 含未注册的 provider，已忽略`, { provider: id });
  }
  return false;
}

/**
 * 视频路由实际使用的 ORDER：显式 `VIDEO_PROVIDER_ORDER` 按注册表过滤（未注册 id
 * 忽略 + warn 一次），过滤后为空或没设时回落 `VIDEO_PROVIDER` 兼容层 / 默认
 * `grok`——与字面量校验时代逐字同义，只是「合法值」改由注册表回答。
 */
export function effectiveVideoProviderOrder(): ProviderId[] {
  const raw = videoProviderOrderRaw();
  if (raw) {
    const known = raw.filter((id) => knownProviderId("VIDEO_PROVIDER_ORDER", id));
    if (known.length) return known;
  }
  return [...videoProviderOrderCompat(), ...implicitRelayIds("video")];
}

/** 同上，`IMAGE_PROVIDER_ORDER`；默认 `openai,grok`。 */
export function effectiveImageProviderOrder(): ProviderId[] {
  const raw = imageProviderOrderRaw();
  if (raw) {
    const known = raw.filter((id) => knownProviderId("IMAGE_PROVIDER_ORDER", id));
    if (known.length) return known;
  }
  return [...imageProviderOrderCompat(), ...implicitRelayIds("image")];
}

/**
 * 没显式配 ORDER 时自动进次序的 relay：启用中、声明 `implicitOrder`（即配置里
 * 带了对应通道）、按 `priority` 降序排在内置默认之后。老 env 折算的
 * yman / openai 预设 `implicitOrder=false`——今天的默认次序一个字都不能动；
 * 生产显式写了 ORDER 时这段根本不会被走到。
 */
function implicitRelayIds(kind: "video" | "image"): ProviderId[] {
  return liveRelayViews()
    .filter(
      (view) =>
        view.enabled &&
        view.implicitOrder &&
        isRegisteredProviderId(view.id) &&
        (kind === "video" ? Boolean(view.catalog) : Boolean(view.image)),
    )
    .sort((a, b) => b.priority - a.priority)
    .map((view) => view.id);
}

/** 这个 provider 接不接得下这个画幅。没声明 `aspectRatios` = 不限（xAI / mock）。 */
function servesRatio(provider: VideoProvider, aspectRatio?: AspectRatio): boolean {
  if (!aspectRatio) return true;
  const ratios = provider.capabilities().aspectRatios;
  return !ratios || ratios.includes(aspectRatio);
}

/**
 * 这个 provider 出不出得了这个分辨率。没声明 `resolutions` = 按 `maxResolution` 判断
 * （xAI / mock 都是 1080p，也就是全收）。
 *
 * 只挡「不够高」，不挡「更高」：480p 的请求交给只有 720p 的一家是向上归一，用户拿到的
 * 只多不少；1080p 的请求交给只有 720p 的一家则是悄悄降档，那正是这次要杜绝的事。
 */
function servesResolutionCap(provider: VideoProvider, resolution?: Resolution): boolean {
  if (!resolution) return true;
  const caps = provider.capabilities();
  return servesResolution(resolution, caps.resolutions ?? [caps.maxResolution]);
}

/** 尾帧只有声明 `supportsLastFrameLock` 的 provider 发得出去（当前只有可灵）。 */
function servesLastFrame(provider: VideoProvider, needsLastFrame?: boolean): boolean {
  return !needsLastFrame || provider.capabilities().supportsLastFrameLock;
}

/** 视频路由的硬条件。三条都是「用户点的东西」，一条都不能靠静默改写来满足。 */
export type VideoRouteConstraints = {
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  needsLastFrame?: boolean;
  /**
   * 除主模式外还必须声明的原生 mode。长片管线把一条任务拆成 t2v + i2v 两类 shot，
   * 选中的那家必须两条都接得住，缺一条就按 ORDER 继续找下一家。
   */
  requireModes?: NativeMode[];
};

const NO_PROVIDER_FOR_RATIO = "当前画幅暂无可用的生成服务";
const NO_PROVIDER_FOR_RESOLUTION = "当前分辨率暂无可用的生成服务";
const NO_PROVIDER_FOR_LAST_FRAME = "当前模型不支持首尾帧";
const NO_PROVIDER_AVAILABLE = "所有生成服务暂时不可用，请稍后再试";

/** 这台实例有没有配任何一把真实上游 key。只要有一把，mock 就不再是合法的落点。 */
/**
 * 这台实例有没有为**这一类**任务配过真上游。按 kind 分开看：只配了 OPENAI_API_KEY 的
 * 纯生图实例，从没打算接视频单，请求视频时落 mock 是它的正常形态，不该 503。
 */
function hasAnyRealKey(kind: ExhaustionKind): boolean {
  // 注册表里任何一家「有 key 且声明了这一类 mode」的都算真上游——relay 配了 key
  // 却不在判据里的话，路由落空时会错误地落进 mock。
  for (const id of registeredProviderIds()) {
    if (id === "mock" || !hasProviderKey(id)) continue;
    const modes = registryProviderForId(id).capabilities().modes;
    const hit =
      kind === "image"
        ? modes.includes("text_to_image")
        : modes.some((mode) => mode !== "text_to_image");
    if (hit) return true;
  }
  return false;
}

/**
 * ORDER 里一个都没选中时的兜底。
 *
 * 先试 grok（`edit_video` / `extend_video` 目前只有它声明支持），但它同样要过
 * 「没被判定耗尽」这一关——`isExhausted` 记的是「这家没钱了」，绕开它正是耗尽切换的
 * 全部意义，兜底路径上漏掉这个判断等于让钱花光的那家继续接任务。
 *
 * 真的一家都没有时**不能**悄悄落 mock：mock 出的是一段带水印的占位片，交付它等于拿
 * 假成片冒充真成片，还照常扣了用户的钱。只要这台实例配了任何一把真 key，就说明它本
 * 意是接真单的，此时一律 503 让用户稍后再试；完全没配 key 的实例（本地开发、CI）才
 * 是「mock 就是它的正常形态」，照旧返回 mock。
 */
function fallbackProvider(kind: ExhaustionKind): VideoProvider {
  if (hasXaiKey() && !isExhausted("grok", kind)) return grokNativeProvider;
  if (!forceMock() && hasAnyRealKey(kind)) {
    throw new ProviderHttpError(503, "no_provider_available", NO_PROVIDER_AVAILABLE);
  }
  return mockProvider;
}

/**
 * 视频路由（方案 §3.4「功能先于供应商」）：按 `VIDEO_PROVIDER_ORDER` 的次序，取第一个
 * 「配了 key、没被判定积分耗尽、`capabilities().modes` 声明支持这个模式、且接得下请求
 * 画幅」的 provider，而不是按某个开关点名。所以 `edit_video` / `extend_video` 只有 grok
 * 声明支持，自然落回 grok；1:1 的请求在 `yman,kling` 下自然落到可灵。
 *
 * 时长不参与筛选：秒数允许向上归一（4→5，上游按档计费，多给不少给）。画幅参与，
 * 因为竖屏换横屏不是归一，是交付了另一个东西。
 *
 * 分辨率与尾帧同样是硬条件（2026-09-06 起）：请求 1080p 的任务不会被派给只出 720p 的
 * provider，带尾帧的任务只会落到声明 `supportsLastFrameLock` 的那家。方向仍是单向的——
 * 480p 交给 720p 的一家是向上归一，允许；反过来是降档，不允许。
 *
 * 一个都没选中时分两种：
 *  - 这个**模式**没人接（edit / extend 当前只有 grok 声明）：走 `fallbackProvider`——
 *    配了 XAI key 且 grok 未耗尽才试它，否则有真 key 就 503、完全没 key 才 mock。
 *  - 模式接得了、**画幅 / 分辨率 / 尾帧**接不了：返回 `{ blocked }`，由调用方 400。回落
 *    等于替用户把他点的东西换成另一家的默认值，而这正是这次要杜绝的静默改写。
 */
/**
 * 选中的 provider，或「没人接得下」时那句该告诉用户的话。
 * 用结果对象而不是 null，是因为「画幅没人接」「分辨率没人接」「没人发得了尾帧」
 * 是三件不同的事，用户要改的东西也不一样。
 */
type VideoRoute = { provider: VideoProvider } | { blocked: string };

function pickVideoProvider(mode: NativeMode, constraints?: VideoRouteConstraints): VideoRoute {
  let blocked: string | null = null;
  for (const id of effectiveVideoProviderOrder()) {
    if (!hasProviderKey(id) || isExhausted(id, "video")) continue;
    const provider = providerForId(id);
    const caps = provider.capabilities();
    if (!caps.modes.includes(mode)) continue;
    if (constraints?.requireModes?.some((required) => !caps.modes.includes(required))) continue;
    // 记下**第一个**被挡住的理由：错误信息要指向用户真正该改的那一项。
    if (!servesRatio(provider, constraints?.aspectRatio)) {
      blocked ??= NO_PROVIDER_FOR_RATIO;
      continue;
    }
    if (!servesResolutionCap(provider, constraints?.resolution)) {
      blocked ??= NO_PROVIDER_FOR_RESOLUTION;
      continue;
    }
    if (!servesLastFrame(provider, constraints?.needsLastFrame)) {
      blocked ??= NO_PROVIDER_FOR_LAST_FRAME;
      continue;
    }
    return { provider };
  }
  if (blocked) return { blocked };
  const fallback = fallbackProvider("video");
  // 兜底那一家同样要过这三关：它同样发不出尾帧，
  // 「没人接得下」必须以 400 结束，而不是交给一个做不到的 provider。
  if (!servesRatio(fallback, constraints?.aspectRatio)) return { blocked: NO_PROVIDER_FOR_RATIO };
  if (!servesResolutionCap(fallback, constraints?.resolution)) {
    return { blocked: NO_PROVIDER_FOR_RESOLUTION };
  }
  if (!servesLastFrame(fallback, constraints?.needsLastFrame)) {
    return { blocked: NO_PROVIDER_FOR_LAST_FRAME };
  }
  return { provider: fallback };
}

/**
 * 文生图路由：按 `IMAGE_PROVIDER_ORDER`（默认 `openai,grok`，即加 YMan 之前那条硬编码
 * 阶梯）取第一个「有 key、没耗尽、声明 text_to_image」的 provider。
 * 画幅不参与——三条生图通道都能出全部七个画幅。
 *
 * 一个都没选中时走与视频同一个 `fallbackProvider`：配了真 key 的实例宁可 503 也不落
 * mock，只有完全没 key 的实例才拿 mock 当正常形态。
 */
function pickImageProvider(): VideoProvider {
  for (const id of effectiveImageProviderOrder()) {
    if (!hasProviderKey(id) || isExhausted(id, "image")) continue;
    const provider = providerForId(id);
    if (provider.capabilities().modes.includes("text_to_image")) return provider;
  }
  return fallbackProvider("image");
}

/**
 * 这次请求该交给谁。
 *
 * 视频模式走 `pickVideoProvider` 的「能力 + 优先级」；30 / 45 / 60 秒长片由一致性
 * 管线拆成 t2v + i2v shot，选中的 provider 必须两条 mode 都声明（`requireModes`），
 * 画幅 / 分辨率照常参与筛选——可灵、YMan、grok 都接得下时按 ORDER 排先后。
 * 没有任何一家接得下请求画幅时抛 400，而不是悄悄换一个画幅出片；配了真 key 却一家可用
 * 的都不剩（全被判定耗尽）时抛 503，而不是悄悄落 mock 交一段水印片。
 */
export function selectProvider(req?: ProviderGenerateRequest): VideoProvider {
  if (forceMock()) return mockProvider;
  if (req?.mode === "text_to_image") return pickImageProvider();
  if (isHarnessDuration(req?.durationSec)) {
    const route = pickVideoProvider("image_to_video", {
      aspectRatio: req?.aspectRatio,
      resolution: req?.resolution,
      requireModes: ["text_to_video"],
    });
    if ("blocked" in route) throw new ProviderHttpError(400, "invalid_argument", route.blocked);
    return route.provider;
  }
  const route = pickVideoProvider(req?.mode ?? "text_to_video", {
    aspectRatio: req?.aspectRatio,
    resolution: req?.resolution,
    needsLastFrame: Boolean(req?.lastImage),
  });
  if ("blocked" in route) throw new ProviderHttpError(400, "invalid_argument", route.blocked);
  return route.provider;
}

/**
 * `opts.harness` 是调用方（`create.ts`）判定的长片标记，与 `selectProvider` 里的
 * `isHarnessDuration` 同义：长片按「声明 i2v + t2v」挑 ORDER 内第一家。`aspectRatio`
 * 让「先算 provider、再按它归一参数」的调用方（`create.ts` / runner 的换家）拿到与
 * `selectProvider` 一致的答案。
 */
export function currentProviderId(
  mode?: NativeMode,
  opts?: VideoRouteConstraints & { harness?: boolean; durationSec?: number },
): ProviderId {
  if (forceMock()) return "mock";
  if (mode === "text_to_image") return pickImageProvider().id;
  if (opts?.harness || isHarnessDuration(opts?.durationSec)) {
    const route = pickVideoProvider("image_to_video", {
      aspectRatio: opts?.aspectRatio,
      resolution: opts?.resolution,
      requireModes: ["text_to_video"],
    });
    if ("blocked" in route) throw new ProviderHttpError(400, "invalid_argument", route.blocked);
    return route.provider.id;
  }
  const route = pickVideoProvider(mode ?? "text_to_video", opts);
  if ("blocked" in route) throw new ProviderHttpError(400, "invalid_argument", route.blocked);
  return route.provider.id;
}

/** 未注册的 id 抛 `unknown provider`，与字面量时代一致；实现在 `registry.ts`。 */
export function providerForId(id: VideoProvider["id"]): VideoProvider {
  return registryProviderForId(id);
}

/** 时长连续（grok / mock）时芯片显示的几档。 */
const DEFAULT_VIDEO_DURATIONS: readonly number[] = [4, 6, 8, 10];

/**
 * 首页时长芯片该显示哪几档（方案 §3.4「功能先于供应商」：功能照常露出，供应商差异
 * 在这里吸收）。上游按档计费，芯片上只能出现「会被计费的那个时长」——判据是 provider
 * 自己声明的 `capabilities().durations`（没声明 = 时长连续，用默认那几档），服务端解析
 * 一次下发，浏览器看不见 `YMAN_T2V_MODEL` 之类的变量。
 *
 * 30 / 45 / 60 从这里剔掉：它们是一致性管线的长片档，由 `harnessEnabled()` 单独追加，
 * 未开启时 API 会 400。剔完空了（某个模型只有长片档）就退回原表，宁可露出也不留空。
 */
export function videoDurationsFor(providerId: ProviderId): readonly number[] {
  const raw = providerForId(providerId).capabilities().durations ?? DEFAULT_VIDEO_DURATIONS;
  const usable = raw.filter((d) => !isHarnessDuration(d));
  return usable.length ? usable : raw;
}

/** 首页画幅芯片的顺序，也是它认得的全集。 */
const UI_VIDEO_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];

/**
 * 首页画幅芯片该显示哪几个：ORDER 里所有**有 key** 的视频 provider 支持画幅的并集。
 *
 * 并集而不是第一顺位那一家：路由本来就会按画幅挑人，只要有一家接得下 1:1，这个芯片就
 * 该露出来。反过来，一家都接不下的画幅必须从芯片上消失——留着它等于让用户选一个提交
 * 就会 400 的东西。有 provider 不声明画幅（xAI / mock，什么都收）时直接给全集。
 *
 * 被判定耗尽的 provider 不计入并集：它这几个小时里根本不会被路由选中，把它独有的画幅
 * 留在芯片上就是「能选、一提交就被拒」——与上面那条「一家都接不下就别露出」同一个道理。
 */
export function videoAspectRatios(): AspectRatio[] {
  if (forceMock()) return [...UI_VIDEO_RATIOS];
  const allowed = new Set<AspectRatio>();
  let sawKeyedProvider = false;
  for (const id of effectiveVideoProviderOrder()) {
    if (!hasProviderKey(id) || isExhausted(id, "video")) continue;
    const caps = providerForId(id).capabilities();
    if (!caps.modes.includes("text_to_video")) continue;
    sawKeyedProvider = true;
    if (!caps.aspectRatios) return [...UI_VIDEO_RATIOS];
    for (const ratio of caps.aspectRatios) allowed.add(ratio);
  }
  if (!sawKeyedProvider) return [...UI_VIDEO_RATIOS];
  const out = UI_VIDEO_RATIOS.filter((ratio) => allowed.has(ratio));
  // 全被筛没了（配置错到没有一家能出这三个画幅中的任何一个）就退回全集：
  // 芯片留空是个死界面，露出来至少还能拿到一句明确的 400。
  return out.length ? out : [...UI_VIDEO_RATIOS];
}

/**
 * 首页 / 规格弹层的分辨率格子：ORDER 里所有**有 key、未耗尽**的视频 provider 出得了的
 * 档位并集，与 `videoAspectRatios` 同一个道理——只要有一家出得了 1080p，这个格子就该
 * 露出来，路由会把它派给那一家；一家都出不了的档必须消失，留着就是「能选、一提交
 * 就被拒」。有 provider 不声明 `resolutions`（xAI / mock）时直接给三档全集。
 */
export function videoResolutions(): Resolution[] {
  if (forceMock()) return [...RESOLUTION_TIERS];
  const allowed = new Set<Resolution>();
  let sawKeyedProvider = false;
  for (const id of effectiveVideoProviderOrder()) {
    if (!hasProviderKey(id) || isExhausted(id, "video")) continue;
    const caps = providerForId(id).capabilities();
    if (!caps.modes.includes("text_to_video")) continue;
    sawKeyedProvider = true;
    if (!caps.resolutions) return [...RESOLUTION_TIERS];
    for (const resolution of caps.resolutions) allowed.add(resolution);
  }
  if (!sawKeyedProvider) return [...RESOLUTION_TIERS];
  const out = [...allowed].sort((a, b) => resolutionRank(a) - resolutionRank(b));
  return out.length ? out : [...RESOLUTION_TIERS];
}

/**
 * 文生图的画幅芯片。
 *
 * 与视频**完全独立**：三条生图通道（openai / yman / grok）都能出 `ASPECT_RATIOS` 的
 * 全部七个，所以这里恒定给七个，不看 `videoProviderOrder` 也不看视频 provider 的
 * `aspectRatios`。共用 `videoAspectRatios()` 的话，一台只配了 16:9/9:16 视频模型的实例
 * 会把文生图的 4:3 / 3:2 一起吞掉——那是拿视频供应商的限制去砍图片功能。
 *
 * 取值来自 `ASPECT_RATIOS` 这一份事实，只是把 UI 惯用的三个排到前面（芯片是点击循环，
 * 顺序就是用户看到的循环顺序）。
 */
export function imageAspectRatios(): AspectRatio[] {
  return [...UI_VIDEO_RATIOS, ...ASPECT_RATIOS.filter((r) => !UI_VIDEO_RATIOS.includes(r))];
}

/**
 * 首页 / `/api/health` 的读数用哪家的能力来渲染。
 *
 * 与 `currentProviderId` 同一条路径，区别只在**不抛**：全家耗尽时 `currentProviderId`
 * 会 503（提交必须被拒），但界面不能因为上游没钱就整页 500——用户还得能看见自己的作品、
 * 能读到那句「暂时不可用」。此时退回 ORDER 里第一个有 key 的 provider，芯片照常按它的
 * 档位显示；真正的拒绝仍然发生在提交那一刻。
 */
export function uiProviderId(mode: NativeMode = "text_to_video"): ProviderId {
  try {
    return currentProviderId(mode);
  } catch {
    for (const id of effectiveVideoProviderOrder()) {
      if (hasProviderKey(id) && providerForId(id).capabilities().modes.includes(mode)) return id;
    }
    return hasXaiKey() ? "grok" : "mock";
  }
}

/**
 * 音轨能力的唯一判据，`src/app/page.tsx` 与 `/api/health` 共用（两处分叉就会出现
 * 「界面能选、上游不出声」）。
 *
 * 可灵由 `KLING_VIDEO_AUDIO` 决定（默认 off，上游只在 1080p 出声）；YMan 为 false 表示
 * **不可控**——它的建任务接口根本没有音频参数，出不出声由模型自己决定，所以既不能保证
 * 有声，也不该向用户收有声的加价。grok / mock 一直支持。
 */
export function audioAvailableFor(providerId: ProviderId): boolean {
  if (providerId === "kling") return klingVideoAudio() === "native";
  // openai-videos 协议的建任务接口没有音频参数（YMan 与各 relay 同），出不出声由
  // 模型自己决定——不可控就既不能保证有声，也不该向用户收有声的加价。
  if (liveRelayViews().some((view) => view.id === providerId && view.catalog)) return false;
  return true;
}

export function needsSourceFileUpload(
  providerId: VideoProvider["id"],
  mode: ProviderGenerateRequest["mode"],
): boolean {
  return providerId === "grok" && (mode === "edit_video" || mode === "extend_video");
}
