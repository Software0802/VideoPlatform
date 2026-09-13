export type NativeMode =
  | "text_to_image"
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video"
  | "edit_video"
  | "extend_video";

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
export type Resolution = "480p" | "720p" | "1080p";
export type ImageResolution = "1k" | "2k";
/**
 * Provider 身份。只是字符串：合法值由 `providers/registry.ts` 的运行时注册表约束
 * （`isRegisteredProviderId` / `providerForId`），不再是编译期字面量联合——中继
 * （relay）provider 由配置在运行时注册，类型系统拦不住也不需要拦。
 */
export type ProviderId = string;

export type MediaRef =
  | { kind: "path"; path: string }
  | { kind: "data_uri"; dataUri: string }
  | { kind: "file_id"; fileId: string }
  | { kind: "url"; url: string };

export type ProviderGenerateRequest = {
  jobId: string;
  mode: NativeMode;
  prompt: string;
  model: string;
  durationSec?: number;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  imageResolution?: ImageResolution;
  generateAudio: boolean;
  startImage?: MediaRef;
  /**
   * 尾帧（首尾帧锁定）。**只有声明 `supportsLastFrameLock` 的 provider 才会发它**：
   * grok 的 rest-map 永远不把它写进请求体（golden test 保障），可灵在图生视频里以
   * `last_frame` 发送并被上游强制到 1080p。其余 provider 忽略。
   */
  lastImage?: MediaRef;
  referenceImages?: MediaRef[];
  referenceAudios?: { voiceId: string }[];
  sourceVideo?: MediaRef;
  /**
   * Cooperative cancellation for providers whose `submit` blocks for minutes.
   *
   * The runner only checks `canceled` on either side of `submit()`, which is
   * enough for a provider that finishes in one request but not for the OpenAI
   * async image task: it can poll for up to `OPENAI_IMAGE_TASK_TIMEOUT_MS`, and
   * fetching the result at the end is what settles the charge upstream. Such a
   * provider must call this before every billable step and abort when it
   * resolves true. Optional — the video providers never need it.
   */
  shouldAbort?: () => Promise<boolean>;
};

export type ProviderHandle = {
  providerId: ProviderId;
  remoteId?: string;
  localVideoPath?: string;
  /** Sync image generations return a URL immediately (no request_id poll). */
  remoteUrl?: string;
  fileOutputId?: string;
  costUsdActual?: number;
  respectModeration?: boolean;
};

export type ProviderPoll = {
  status: "pending" | "done" | "failed" | "expired";
  progress: number;
  remoteUrl?: string;
  durationSec?: number;
  respectModeration?: boolean;
  errorCode?: string;
  errorMessage?: string;
  usage?: {
    costInUsdTicks?: number;
    costUsdActual?: number;
    raw?: unknown;
  };
  fileOutputId?: string;
};

export interface VideoProvider {
  readonly id: ProviderId;
  /**
   * 「这家现在有没有可用的上游 key」。路由第一关（`providers/registry.ts` 的
   * `hasProviderKey`）优先用它；不声明时回落到内置各家的既有判据（`*_API_KEY`
   * 环境变量 / mock 恒真 / jimeng 占位恒假）。relay 必须声明它（读自己的 `keyEnv`）。
   */
  hasKey?(): boolean;
  capabilities(): {
    modes: NativeMode[];
    maxDurationSec: number;
    supportsLastFrameLock: boolean;
    maxResolution: Resolution;
    /**
     * 视频侧真正出得了的分辨率档。**省略 = 不限**（按 `maxResolution` 判断）。
     *
     * 路由拿它当硬条件：请求 1080p 时不会被派给只出 720p 的 provider。方向是单向的——
     * 480p 的请求交给只有 720p 的一家没问题（向上归一，用户拿到的只多不少），反过来
     * 把 1080p 降成 720p 是交付了另一个东西。
     */
    resolutions?: Resolution[];
    /**
     * 参考生视频最多收几张参考图。**省略 = 不限**（受请求体 schema 的上限约束）。
     * grok 7、YMan 9（按所选模型）、可灵 0。
     */
    maxReferenceImages?: number;
    /**
     * 视频侧接得下的画幅。**省略 = 不限**（xAI / mock 那样什么都收）。
     *
     * 路由拿它当硬条件：一个不声明 1:1 的 provider 不会被派去做 1:1 的任务，而不是
     * 让它把画幅悄悄换成自己的第一档——用户选的画幅是需求，不是建议。
     */
    aspectRatios?: AspectRatio[];
    /**
     * 上游按档计费的时长枚举。**省略 = 连续**（1..maxDurationSec 都收）。
     * 只喂首页的时长芯片，不参与路由：秒数还允许向上归一（4→5），画幅不允许。
     */
    durations?: number[];
    /**
     * 文生图能不能带参考图。**省略 = false**。为真时 `text_to_image` 且
     * `referenceImages` 非空的请求改走图生图接口（OpenAI 兼容通道是
     * `POST /images/edits` multipart）；为假时这类请求在 `validate()` 被 400 拒掉。
     */
    supportsImageReference?: boolean;
    /**
     * 一条任务从提交到出片，本地最多等多久（毫秒）。**省略 = 15 分钟**
     * （`runner.DEFAULT_TASK_TIMEOUT_MS`，grok / mock 走这条）。
     *
     * 它同时是 `pollUntilDone` 的总上限和 `recover` 陈旧判定的基数（再加 5 分钟余量）。
     * 之所以按 provider 声明而不是全局一个字面量：本地放弃等待并不会让上游停下来，
     * 一家慢上游被判「过期」时，片子照出、钱照扣，用户只看到「失败」——那是最贵的一种
     * 误报，所以慢的那家必须能把这个数抬上去（可灵读 `KLING_TASK_TIMEOUT_MS`，
     * YMan 读 `YMAN_TASK_TIMEOUT_MS`）。
     */
    taskTimeoutMs?: number;
  };
  /**
   * 这家上游**自己**的请求约束（可选）。
   *
   * 与请求体的通用校验（`jobs/request-validation.ts`）分工明确：那边管「这个 mode 该带
   * 哪些字段」，与 provider 无关；这里管「这家接不接得下这样一个请求」——参考图上限、
   * 源视频必须是 file_id、某个模型不收源视频之类。创建任务时按选中的 provider 调一次，
   * 所以 grok 的 7 张参考图上限不会再被套到 YMan 的 9 张上。
   */
  validate?(req: ProviderGenerateRequest): void;
  submit(req: ProviderGenerateRequest): Promise<ProviderHandle>;
  poll(handle: ProviderHandle): Promise<ProviderPoll>;
  /**
   * Crash recovery (plan §3.2, G1): find the task the upstream may already have created
   * for `externalId` — our own job id, which such a provider sends along as its client-side
   * task id. Returns the upstream task id, or null when the upstream has no task under it.
   *
   * **Optional on purpose.** A provider that cannot ask this question omits the method,
   * and the runner then leaves an interrupted submit as `uncertain_submit` rather than
   * guessing; adding the method must never become a reason to re-POST a billable request.
   */
  lookupByExternalId?(externalId: string): Promise<string | null>;
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    opts?: { upstreamRejected?: boolean },
  ) {
    super(message);
    this.name = "ProviderHttpError";
    /**
     * 上游以结构化错误体**明确拒单**的 5xx（已确定没受理、没计费），区别于
     * 「请求可能已送达」的断连 / 裸 5xx——runner 据此不把它判成 `uncertain_submit`。
     * 目前只有 OpenAI 兼容生图通道会打这个标记。
     */
    this.upstreamRejected = opts?.upstreamRejected === true;
  }
  public readonly upstreamRejected: boolean;
}
