import { z } from "zod";
import type { HarnessShotRecord } from "@/lib/harness/shot-state";
import type { HarnessPlan } from "@/lib/harness/types";
import { tagsSchema } from "@/lib/jobs/tags";
import { ASPECT_RATIOS, RESOLUTIONS } from "@/lib/providers/grok/mode-matrix";

export const nativeModeSchema = z.enum([
  "text_to_image",
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit_video",
  "extend_video",
]);

export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export const resolutionSchema = z.enum(RESOLUTIONS);
export const imageResolutionSchema = z.enum(["1k", "2k"]);
export const jobStatusSchema = z.enum([
  "queued",
  "submitting",
  "pending",
  "persisting",
  "directing",
  "keyframing",
  "generating_shots",
  "qc",
  "stitching",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * Statuses with no outgoing edges in `state-machine.ts`. Lives here rather than
 * next to the transition table so that both the store (which stamps
 * `completedAt` on the way in) and the quota counter (which reads it back) share
 * one definition instead of two hand-kept copies.
 */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const jobPublicSchema = z.object({
  id: z.string(),
  status: jobStatusSchema,
  progress: z.number().finite().min(0).max(100),
  mode: nativeModeSchema,
  model: z.string(),
  /**
   * Provider id 是开放字符串（`ProviderId = string`）：relay provider 由配置在运行时
   * 注册进 `providers/registry.ts`，写死字面量联合会让 relay 任务落盘后读不回来。
   * 上限 64 只是挡明显畸形；合法性由注册表判。
   */
  provider: z.string().min(1).max(64),
  /**
   * 产品 id（`src/lib/products/catalog.ts`）。用户选的那一档，也是界面该显示的东西——
   * `model` 是上游模型名（`kling-2.6`），不该出现在界面上，供应商名更不该。
   * 旧记录没有这两个字段，所以是可选的；没有产品时界面回落显示模式名。
   */
  product: z.string().optional(),
  productName: z.string().optional(),
  prompt: z.string(),
  durationSec: z.number(),
  aspectRatio: aspectRatioSchema.nullable(),
  resolution: resolutionSchema.nullable(),
  generateAudio: z.boolean(),
  lastFrameStored: z.boolean(),
  /**
   * 尾帧是否真的锁住了成片的最后一帧。
   *
   * 曾经是字面量 `false`（那时唯一的上游是 grok，尾帧只落盘、永不进请求体）。可灵这条
   * 通道会把 `last_frame` 真的发上去，此时说 false 就是在骗人——用户按「首尾帧」那一档
   * 被计了价，界面却告诉他没锁。判据是「provider 声明 `supportsLastFrameLock` 且这次
   * 真的带了尾帧」，见 `jobs/create.ts`。
   */
  lastFrameLocksOutput: z.boolean(),
  harness: z.object({ enabled: z.boolean() }),
  /**
   * 对用户的售价，人民币元（方案 §3.2）。提交时按归一后的参数定一次，之后永不改写——
   * 它同时是在途预留的金额和成功后扣款的金额，改写它会让两者对不上。
   *
   * `.default(0)`：余额模型之前的记录里没有这个字段，读出即 0，也就是既不占预留也
   * 不扣款——那些任务当时走的是日配额，不该被追溯计费。
   */
  priceCny: z.number().default(0),
  /** Estimate shown at submit time; never rewritten afterwards (R05). */
  costUsdEstimate: z.number(),
  /** Harness: estimate recomputed from the Director's packing, shown beside the submit-time
   * one. The budget cap does NOT derive from it — see `budgetCap` / evals/rubric.md §5. */
  costUsdPlanned: z.number().nullable().optional(),
  /** Sum of every charge the upstream reported (shots, sheets, retries). */
  costUsdActual: z.number().nullable(),
  /** True when a paid call returned no usage or LLM calls were made without a price table: actual is a lower bound. */
  costIncomplete: z.boolean().optional(),
  /** Soft warning (evals/rubric.md §5): actual spend passed 1.5 × the submit-time estimate.
   * Nothing stops; the job just no longer counts as cost-compliant. The hard stop stays at ×2. */
  costOverTarget: z.boolean().optional(),
  imageResolution: imageResolutionSchema.nullable(),
  /**
   * 用户贴在这条作品上的分类标签（阶段 B）。创建时可带、之后可 `PATCH` 改，服务端不
   * 解释它的含义。`.default([])`：标签之前的记录里没有这个字段，读出即空数组，界面
   * 按「未分类」渲染。
   */
  tags: z.array(z.string()).default([]),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  output: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("video"),
        videoUrl: z.string(),
        posterUrl: z.string(),
        durationSec: z.number(),
      }),
      z.object({
        kind: z.literal("image"),
        imageUrl: z.string(),
      }),
    ])
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * When the retention sweep deleted this job's `inputs/` and `outputs/` (plan §8),
   * ISO, or null. `status` deliberately stays `succeeded`: terminal statuses have no
   * outgoing edges, so artifact retention is a second axis rather than a state
   * transition. The browser needs it to render a placeholder instead of requesting
   * bytes that are no longer on disk.
   */
  artifactsPurgedAt: z.string().nullable(),
  bible: z.null(),
  /** Set when a shot may already have been paid for upstream: one-click Retry is refused
   * server-side (409 `retry_blocked`) and the UI shows `message` instead of the button. */
  retryBlocked: z
    .object({
      code: z.literal("uncertain_submit"),
      message: z.string(),
      shotIndexes: z.array(z.number().int().min(0)),
    })
    .nullable(),
  /** Harness jobs expose per-shot progress; native clips keep null. */
  shots: z
    .array(
      z.object({
        id: z.string(),
        index: z.number().int().min(0),
        durationSec: z.number(),
        status: z.string(),
        retries: z.number().int().min(0),
        error: z.object({ code: z.string(), message: z.string() }).nullable(),
      }),
    )
    .nullable(),
});

export type JobPublic = z.infer<typeof jobPublicSchema>;

/** Keep provider/user-controlled progress inside the public 0–100 contract. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export const UPLOAD_ID_RE = /^up_[0-9a-f]{16}$/;
export const uploadIdSchema = z.string().regex(UPLOAD_ID_RE);

export const RESERVATION_ID_RE = /^res_[0-9a-f]{16}$/;

/**
 * 资金预留（A 包）：准入那一刻冻结的分池分配额，存在 `job.json` 上与任务同生死——
 * 预留和任务在同一次原子写里诞生，不存在「钱占住了、任务没落盘」或反过来的窗口。
 *
 * 状态不单独存：`held` 就是「任务非终态」，`settled` 就是 `billing.chargedAt` 已盖，
 * `released` 就是其余终态。三态全部由 `status` 派生，所以永远不可能出现「任务已经
 * 终态、预留还占着钱」这类两个事实源打架的情况。
 *
 * `memberCny` 是会员池 earmark，维护的不变量：**会员池账面余额在任何时候不得低于
 * 所有在途任务 earmark 之和**——期次重置 / 到期清零 / 换订阅重置都先保住这个数再动
 * 池子（`subscription.ts` 的 `heldMemberEarmarksCny`）。任务进终态后 earmark 随
 * 「非终态」标签一起消失，下一次惰性结算把没被承诺的部分冲销——过期会员额就此作废，
 * 不转成已购余额。结算扣款带 `memberMaxCny = memberCny` 上限（`protocol.mjs`），
 * 保证扣这条任务的钱不会动到别的在途任务 earmark 进池的部分。
 */
export type JobReservation = {
  /** `res_<16hex>`。 */
  id: string;
  /** 预留总额，人民币元——与 `priceCny` 同值，写死不改。 */
  amountCny: number;
  /** 会员池 earmark：结算时最多从会员池出这么多。 */
  memberCny: number;
  /** 已购池承诺额 = `amountCny − memberCny`。 */
  purchasedCny: number;
  /** earmark 出自哪份订阅的哪一期（诊断与审计归属；老记录没有这两个字段）。 */
  subscriptionId?: string;
  periodIndex?: number;
  createdAt: string;
  /**
   * 释放处理已完成的时刻（ISO）：任务进了非成功终态、earmark 该溶解还是该冲销
   * 已经做过判定（当期 earmark 直接溶解不写流水；过期 earmark 写 `res:<id>:release`
   * 冲销行）。没盖这个戳就还会被 `updateJob` 反复补偿，与 `chargedAt` 同一个模式。
   */
  releasedAt?: string;
};

export const createJobBodySchema = z.object({
  mode: nativeModeSchema,
  /**
   * 产品 id（`video-standard` 之类），**不是**上游模型名。缺省时由服务端按 ORDER 能力
   * 路由决定，并把选中的产品写进记录。认不出、当前不可用、或不支持这次的
   * mode / 画幅 / 分辨率时一律 400——一个提交就会被拒的选项不该被静默换掉。
   *
   * `.max(64)`：产品 id 是我们自己发的短标识，长度上限挡住「拿这个字段当垃圾桶」的请求，
   * 与 `prompt` 的 2000 同一个理由（它会被原样带进错误信息与日志）。
   */
  model: z.string().max(64).optional(),
  prompt: z.string().max(2000).default(""),
  durationSec: z.number().optional(),
  aspectRatio: aspectRatioSchema.optional(),
  resolution: resolutionSchema.optional(),
  generateAudio: z.boolean().optional(),
  imageResolution: imageResolutionSchema.optional(),
  startUploadId: uploadIdSchema.optional(),
  lastUploadId: uploadIdSchema.optional(),
  // 上限放宽到 9（YMan 的参考生视频收 9 张）；精确上限由选中的 provider / 产品在
  // `create.ts` 里按 `capabilities().maxReferenceImages` 判定，grok 仍是 7。
  referenceUploadIds: z.array(uploadIdSchema).max(9).optional(),
  voiceIds: z.array(z.string()).max(3).optional(),
  sourceVideoUploadId: uploadIdSchema.optional(),
  /** 创建时就贴好的分类标签（可选）。校验与归一见 `@/lib/jobs/tags`。 */
  tags: tagsSchema.optional(),
  idempotencyKey: z.string().optional(),
}).strict();

export type CreateJobBody = z.infer<typeof createJobBodySchema>;

export const uploadRoleSchema = z.enum(["start", "last", "reference", "source_video"]);
export type UploadRole = z.infer<typeof uploadRoleSchema>;

export type UploadSidecar = {
  uploadId: string;
  /**
   * Who uploaded the file (plan §5.3). Without it, knowing someone else's
   * upload id was enough to claim their file into your own job. Missing means a
   * pre-user-system upload, which `createJob` treats as non-existent.
   */
  ownerId?: string;
  role: UploadRole;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  durationSec: number | null;
  createdAt: string;
};

/**
 * Director / visual-QC token ledger. `unpricedCalls` and `costUsd` were added after
 * the first harness runs, so job.json files written before that omit them; every read
 * goes through `normalizeLlmUsage`, which reads a missing field as 0.
 */
export type JobLlmUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Calls that finished without upstream usage: `costUsd` is a lower bound (default 0). */
  unpricedCalls?: number;
  /** List-price estimate of the priced calls, folded into `costUsdActual` (default 0). */
  costUsd?: number;
};

export type NormalizedLlmUsage = Required<JobLlmUsage>;

export function normalizeLlmUsage(usage: JobLlmUsage | null | undefined): NormalizedLlmUsage {
  return {
    calls: usage?.calls ?? 0,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    unpricedCalls: usage?.unpricedCalls ?? 0,
    costUsd: usage?.costUsd ?? 0,
  };
}

export type JobAssetImage = { path: string; width: number; height: number };
export type JobAssetVideo = JobAssetImage & {
  durationSec: number;
  xaiFileId: string | null;
};

/**
 * `retryBlocked` is derived from `harnessShots` at `toPublic` time, never stored, so it is
 * omitted here — otherwise every writer of a record would have to carry a computed field.
 */
export type JobRecord = Omit<
  JobPublic,
  "retryBlocked" | "artifactsPurgedAt" | "error" | "tags"
> & {
  schemaVersion: 1;
  /**
   * 作品标签。可选而不是 `string[]`：标签之前写下的每一条 `job.json` 里都没有它，
   * `toPublic` 读作 `[]`（`tags ?? []`），公开形状上仍是必有的数组。
   */
  tags?: string[];
  /**
   * Widened from the public shape by `detail`. When an upstream refusal is shown to the
   * user through a Chinese fallback ("平台余额不足…"), the upstream's own wording still has
   * to survive for whoever reads `job.json` afterwards. `toPublic` parses through
   * `jobPublicSchema`, whose `error` object drops unknown keys — so `detail` stays
   * server-side without any extra filtering at the boundary.
   */
  error: { code: string; message: string; detail?: string } | null;
  /**
   * Set once by the retention sweep (`retention.ts`) after it deleted the job's
   * `inputs/` and `outputs/`. Absent on every record that still has its bytes,
   * which is why it is optional here and `string | null` on the public DTO.
   */
  artifactsPurgedAt?: string;
  /**
   * Owning user (plan §5). Deliberately absent from `JobPublic`: the browser
   * never needs it and must not learn other people's user ids. Missing means a
   * pre-user-system job — see `canAccessJob`.
   */
  ownerId?: string;
  /**
   * When the job first reached a terminal status, ISO. Stamped once by
   * `store.updateJob` and never rewritten, so a later write (a产物 sweep, a
   * cost correction) cannot move the job to another day.
   *
   * The daily quota buckets settled jobs by this, not by `createdAt`: a job
   * submitted at 23:59 and finished at 00:05 belongs to the day it *finished*,
   * otherwise it counts towards neither day and comes out free. Records written
   * before this field existed fall back to `updatedAt`.
   */
  completedAt?: string;
  /**
   * 结算标记（方案 §3.2）。`chargedAt` 一旦写上，这条任务的 `priceCny` 就已经从余额里
   * 扣掉了；`store.updateJob` 只在「非终态 → succeeded」那一次写它，并以它自身为
   * 幂等键，所以任何后续写盘（产物清理、成本回填）都不会重复扣款。
   * 服务端字段，不进 `JobPublic`——浏览器不需要知道钱是哪一刻扣的。
   */
  billing?: { chargedAt: string };
  /**
   * 创建请求带的幂等键与请求体哈希（R07）。幂等映射文件只是缓存：job.json 才是
   * 「这个 key 建了哪条任务」的事实源——崩在「任务落盘、映射没写」之间时，下一次
   * 同 key 请求靠它把映射重建回来。`requestHash` 是同 key 异参的判据：对不上即
   * 409 `idempotency_conflict`，不许沉默复用旧任务。老记录没有它：那时幂等只写在
   * 映射文件里，只能按归属信映射。
   */
  idempotency?: { key: string; requestHash: string };
  /**
   * 资金预留（A 包，见 `JobReservation` 的注释）。缺省 = 升级前创建的任务：在途预留
   * 按 `priceCny` 全额计（与旧口径一致），结算按「会员池优先」扣款、不戴 earmark 上限。
   */
  reservation?: JobReservation;
  /**
   * How many times an upstream refusal that is nobody's fault (rate limit, platform
   * balance) sent this job back to `queued` instead of failing it. Absent on records
   * written before the field existed, so every read goes through `?? 0`.
   */
  upstreamRetries?: number;
  /**
   * Earliest instant the runner may pick this `queued` job up again, ISO. Written
   * together with `upstreamRetries` by the backoff path; `pump()` skips a queued job
   * until it passes. Absent means "eligible now", which is the case for every job that
   * was never bounced off the upstream.
   */
  nextAttemptAt?: string;
  remoteId?: string;
  remoteUrl?: string;
  fileOutputId?: string;
  localOutputPath?: string;
  canceled?: boolean;
  assets: {
    start?: JobAssetImage;
    last?: JobAssetImage;
    references?: JobAssetImage[];
    source?: JobAssetVideo;
  };
  voiceIds?: string[];
  /** Internal Phase 2 snapshot; omitted from the Phase 1 public DTO. */
  harnessPlan?: HarnessPlan | null;
  harnessShots?: HarnessShotRecord[] | null;
  /** Director / visual-QC token ledger; see `normalizeLlmUsage` for legacy records. */
  llmUsage?: JobLlmUsage;
  /** Whole-film check after stitching (R08). */
  harnessStitch?: { durationSec: number; expectedSec: number; settleSec: number; toleranceSec: number };
};
