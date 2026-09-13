import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { priceCny } from "@/lib/billing/prices";
import { estimateCostUsd } from "@/lib/cost";
import { jobConcurrency, upstreamPollMaxMs, upstreamRetryBaseMs } from "@/lib/env";
import { HarnessFailure, harnessOrchestrator } from "@/lib/harness/orchestrator";
import { packHarnessDuration } from "@/lib/harness/pack-duration";
import { emitJob } from "@/lib/jobs/events";
import {
  harnessSettingsFor,
  harnessSubmitEstimateUsd,
  modelForProvider,
  providerSettingsFor,
  videoPricingOf,
} from "@/lib/jobs/provider-settings";
import { productForProvider } from "@/lib/products/catalog";
import { recoverDecision } from "@/lib/jobs/recover";
import { JOB_UNCERTAIN_SUBMIT_MESSAGE, UNCERTAIN_SUBMIT_CODE } from "@/lib/jobs/retry-guard";
import { sweepRetention } from "@/lib/jobs/retention";
import { sweepIdempotency, sweepTmp } from "@/lib/jobs/sweep";
import { listJobIndex } from "@/lib/jobs/index";
import { listJobRecords, readJob, tmpDir, toPublic, updateJob } from "@/lib/jobs/store";
import { extractPoster } from "@/lib/media/poster";
import { probeDurationSec } from "@/lib/ffmpeg";
import { persistRemote } from "@/lib/media/persist";
import { deleteXaiFile, uploadXaiFile } from "@/lib/providers/grok/client";
import { markExhausted } from "@/lib/providers/exhaustion";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import { isHarnessDuration } from "@/lib/harness/durations";
import { currentProviderId, needsSourceFileUpload, providerForId } from "@/lib/providers/router";
import {
  ProviderHttpError,
  type MediaRef,
  type ProviderGenerateRequest,
  type ProviderId,
  type VideoProvider,
} from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { enterLogContext, log } from "@/lib/log";
import { isTerminalStatus, type JobRecord } from "@/lib/jobs/schema";
import { canTransition } from "@/lib/jobs/state-machine";
import { cleanupJobArtifacts, commitLocalOutput, resolveLocalOutput } from "./local-output";

type RunnerState = {
  started: boolean;
  inflight: Set<string>;
  /**
   * 待办集合：可能还需要跑的任务 id（方案 §3.3）。
   *
   * 在它之前 `pump()` 每次被叫醒都要把全站 job.json 读一遍去找那几条待跑的——历史任务
   * 越多，每次状态推进就越慢，而待跑的从来只有个位数。现在入队时加进来、跑到终态时摘
   * 掉，`pump` 只读集合里这几条。集合是进程内状态，崩溃后由启动时的索引重新灌满。
   */
  todo: Set<string>;
  timer?: NodeJS.Timeout;
  /** Wakes `pump()` when the earliest backed-off job becomes eligible again. */
  backoffTimer?: NodeJS.Timeout;
  /** 冷启动时延后跑的第一次维护（见 `startJobRunner`）。 */
  maintenanceTimer?: NodeJS.Timeout;
};

function state(): RunnerState {
  const g = globalThis as typeof globalThis & { __lumenRunner?: RunnerState };
  if (!g.__lumenRunner) {
    g.__lumenRunner = { started: false, inflight: new Set(), todo: new Set() };
  }
  return g.__lumenRunner;
}

/** 冷启动时第一次维护延后多久。 */
const MAINTENANCE_DELAY_MS = 30_000;

export async function startJobRunner() {
  const s = state();
  if (s.started) return;
  s.started = true;
  // 冷启动只 await 「恢复」这一件事（方案 §3.3「冷启动」）。维护要扫 data/tmp、
  // data/idempotency 与全站产物目录，和「这台实例能不能开始服务」无关，却曾经挡在
  // 第一个请求前面；改成 30 秒后再跑，之后照旧每小时一次。
  s.maintenanceTimer = setTimeout(() => {
    s.maintenanceTimer = undefined;
    void maintenance();
  }, MAINTENANCE_DELAY_MS);
  s.maintenanceTimer.unref();
  s.timer = setInterval(() => {
    void maintenance();
  }, 3600_000);
  s.timer.unref();
  await recover();
  await refillTodo();
  void pump();
}

/**
 * 从索引把「还没跑完的任务」灌进待办集合。
 *
 * 启动后跑一次（`recover` 已经把崩溃时的中间态推到了该在的状态），此后每小时的维护
 * 再跑一次兜底——待办集合是进程内状态，任何一条因为异常掉出集合的任务，最迟一小时后
 * 会被捡回来，而不是永远躺在 `queued` 里等一个不会来的 pump。
 */
async function refillTodo(): Promise<void> {
  const s = state();
  const entries = await listJobIndex({ nonTerminal: true });
  for (const entry of entries) s.todo.add(entry.id);
}

/**
 * Housekeeping on the runner's own hourly timer (plan §8): staging files and
 * idempotency replays older than a day, then the artifact retention sweep.
 *
 * Deliberately in the runner process rather than a separate cron: retention
 * rewrites `job.json` through `store.updateJob`, and doing that from a second
 * process would race the writer that owns those files.
 *
 * Each step keeps its own failures to itself, so a broken sweep cannot stop the
 * runner from starting.
 */
async function maintenance() {
  for (const step of [sweepTmp, sweepIdempotency, sweepRetention, refillTodo]) {
    try {
      await step();
    } catch (error) {
      log("warn", "maintenance step failed", {
        step: step.name,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }
  void pump();
}

export function enqueue(jobId: string) {
  state().todo.add(jobId);
  void pump();
}

async function recover() {
  const jobs = await listJobRecords();
  const now = Date.now();
  for (const job of jobs) {
    const age = now - new Date(job.updatedAt).getTime();
    // 陈旧判定跟着这条任务所属 provider 的轮询上限走（方案 §2 G6），再加 5 分钟余量：
    // 15 分钟曾经是写死的字面量，于是一家慢上游的正常任务在重启后会被判「过期」，
    // 而它在上游照常出片、照常计费。余量是留给 persist（下载 + 抽帧）的。
    const staleMs = taskTimeoutMsFor(job.provider) + RECOVER_STALE_MARGIN_MS;
    const decision = recoverDecision(job.status, age, Boolean(job.remoteId), staleMs);
    if (decision === "expire") {
      await fail(job.id, "expired", LOCAL_GIVE_UP_MESSAGE);
      continue;
    }
    if (decision === "uncertain") {
      // Last chance to turn "unknown" back into "known" without spending anything:
      // a provider that carries our job id upstream can be asked whether it already
      // has that task. Only a positive, unambiguous answer resumes the job.
      const remoteId = await lookupInterruptedSubmit(job);
      if (remoteId) {
        await updateJob(job.id, (r) => {
          if (r.status !== "submitting") return r;
          r.remoteId = remoteId;
          r.status = "pending";
          return r;
        }).then(emitRec);
        log("info", "uncertain submit resolved upstream", { id: job.id, provider: job.provider });
        continue;
      }
      await fail(job.id, UNCERTAIN_SUBMIT_CODE, JOB_UNCERTAIN_SUBMIT_MESSAGE);
      continue;
    }
    if (decision === "requeue" && job.status !== "queued") {
      await updateJob(job.id, (r) => {
        r.status = "queued";
        return r;
      });
      continue;
    }
    if (decision === "resume-pending") {
      await updateJob(job.id, (r) => {
        r.status = "pending";
        return r;
      });
    }
  }
}

/**
 * 一条任务在本地最多等多久（方案 §2 G6）。
 *
 * 曾经是 `pollUntilDone` 里的一个 15 分钟字面量，兼当 recover 的陈旧判定，于是
 * `klingTaskTimeoutMs()` 配了也没人读。现在由 provider 自己声明
 * （`capabilities().taskTimeoutMs`），没声明的按 15 分钟——grok / mock 就走这条。
 *
 * 认不出的 provider id（历史记录里出现过、现在已经删掉的那家）不该让恢复流程整个抛，
 * 按默认值处理。
 */
export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
/** recover 的陈旧判定 = provider 超时 + 这个余量（留给下载 / 抽帧的 persist 阶段）。 */
const RECOVER_STALE_MARGIN_MS = 5 * 60 * 1000;

export function taskTimeoutMsFor(providerId: ProviderId): number {
  try {
    return providerForId(providerId).capabilities().taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  } catch {
    return DEFAULT_TASK_TIMEOUT_MS;
  }
}

/**
 * 本地放弃等待时说的话。
 *
 * 不能只说「超时」：超时的是**我们**，上游那边任务多半还活着，而且提交的那一刻就已经
 * 计费了。用户据此决定是去上游查收，还是重开一单——「失败」两个字会让他直接重开，
 * 于是同一条片子付两次钱。
 */
export const LOCAL_GIVE_UP_MESSAGE =
  "等待超时：本地已放弃等待，上游可能仍在出片并已计费，请先确认再决定是否重新生成";

/** 轮询阶梯（方案 §3.3「轮询」）：前 20 秒 2s，20→60 秒线性升到 5s，之后到上限。 */
const POLL_BASE_MS = 2_000;
const POLL_MID_MS = 5_000;
const POLL_RAMP_START_MS = 20_000;
const POLL_RAMP_END_MS = 60_000;

/**
 * 距离开始轮询 `elapsedMs` 时，下一次该等多久。
 *
 * 固定 2 秒对一条 5 分钟的可灵任务意味着 150 次 HTTP + 150 次写盘 + 150 次 SSE 广播，
 * 而其中有意义的只有最后一次。阶梯的形状迁就的是「用户还在看着」的那前 20 秒：那时反馈
 * 要快；之后他多半已经切走了，慢一点没人察觉。上限 `UPSTREAM_POLL_MAX_MS` 可调，调到
 * 比 2 秒还小时全程按它走（不给一个「最短也要 2 秒」的隐藏下限）。
 */
export function pollDelayMs(elapsedMs: number, maxMs: number = upstreamPollMaxMs()): number {
  let raw: number;
  if (elapsedMs < POLL_RAMP_START_MS) {
    raw = POLL_BASE_MS;
  } else if (elapsedMs < POLL_RAMP_END_MS) {
    const ratio = (elapsedMs - POLL_RAMP_START_MS) / (POLL_RAMP_END_MS - POLL_RAMP_START_MS);
    raw = POLL_BASE_MS + (POLL_MID_MS - POLL_BASE_MS) * ratio;
  } else {
    raw = maxMs;
  }
  return Math.round(Math.min(raw, maxMs));
}

/**
 * A single-clip job that crashed between `provider.submit` returning and `remoteId`
 * being written. Returns the upstream task id when the provider can prove one exists,
 * null otherwise — including when the lookup itself fails.
 *
 * Never throws: recovery runs during boot, and a flaky upstream must not keep the
 * server from starting. A failed lookup is simply "still unknown", which is the safe
 * side: the job ends up `uncertain_submit` and nothing is re-submitted.
 */
async function lookupInterruptedSubmit(job: JobRecord): Promise<string | null> {
  try {
    const provider = providerForId(job.provider);
    if (!provider.lookupByExternalId) return null;
    return await provider.lookupByExternalId(job.id);
  } catch (error) {
    log("warn", "uncertain submit lookup failed", {
      id: job.id,
      provider: job.provider,
      msg: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 「提交结果不确定」的失败（R06）：上游可能已经把这条请求接走了。
 *
 * 上游给过确定答复的失败——参数不对、鉴权拒绝、限流、余额——都是 4xx，那时 POST 没有
 * 被接受、没有被计费，照原路重发或换家即可。拿不准的只有两类：我们自己合成的超时 /
 * 断连（`upstream_timeout` / `upstream_unavailable`，请求可能已送达）和上游的 5xx
 * （服务端内部错，单子可能已经建出来）。把它们当「确定失败」重发 = 同一条片子付两次钱。
 *
 * 例外：`missing_api_key` 抛在请求发出之前；`mock_failure` 是测试替身模拟的「上游明确
 * 拒收」。非 ProviderHttpError 是普通内部错误（rest-map 校验、读盘失败），同样确定。
 */
const CERTAIN_SUBMIT_FAILURE_CODES = new Set(["missing_api_key", "mock_failure"]);

function isAmbiguousSubmitError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.status < 500) return false;
  // 结构化错误体 = 上游明确拒单，确定没受理没计费（openai-image 通道打这个标记）。
  if (error.upstreamRejected) return false;
  return !CERTAIN_SUBMIT_FAILURE_CODES.has(error.code);
}

/**
 * 一次「不确定」的提交该怎么结（R06）。
 *
 * - `"resumed"`：上游 `lookupByExternalId` 证明单子已经建出来了，记录已接管成
 *   `pending`——它照常计费、照常出片，调用方进轮询段把它跑完；
 * - `"handled"`：任务已结（`failed`/`uncertain_submit` 或已取消），`runOne` 直接返回；
 * - `"not-ambiguous"`：错误不属于这一类，交回调用方按普通失败走。
 */
async function resolveAmbiguousSubmit(
  id: string,
  error: unknown,
): Promise<"resumed" | "handled" | "not-ambiguous"> {
  if (!isAmbiguousSubmitError(error)) return "not-ambiguous";
  const rec = await readJob(id);
  if (!rec || rec.canceled || rec.status === "canceled") return "handled";
  // 先走不花钱的确认路：能把我们的 jobId 当外部单号查回任务，就接管它继续轮询，
  // 而不是把一份可能已付费的单子按「失败」扔掉再重买一次。
  const remoteId = await lookupInterruptedSubmit(rec);
  if (remoteId) {
    const next = await updateJob(id, (r) => {
      if (r.status === "canceled" || r.canceled || r.status !== "submitting") return r;
      r.remoteId = remoteId;
      r.status = "pending";
      r.progress = Math.max(r.progress, 5);
      return r;
    });
    if (next.status === "pending" && next.remoteId === remoteId) {
      emitRec(next);
      log("info", "ambiguous submit resolved by upstream lookup", { id, remoteId });
      return "resumed";
    }
    return "handled";
  }
  // 查不到、provider 没这个能力、或查询本身也挂了：诚实的答案是「不知道」——标记
  // uncertain_submit，锁死一键重试（`retryBlock`），而不是把可能已付费的单子重发。
  const detail = error instanceof Error ? error.message : String(error);
  await fail(id, UNCERTAIN_SUBMIT_CODE, JOB_UNCERTAIN_SUBMIT_MESSAGE, detail);
  return "handled";
}

/**
 * Upstream refusals that are nobody's fault and pass on their own: the account is out
 * of credit, or the platform's concurrency ceiling is full right now. Failing the job
 * outright would show "失败" for what is really "排队", and — because a submit that was
 * refused was never billed — retrying it costs nothing but time.
 */
const UPSTREAM_BACKOFF_CODES: ReadonlySet<string> = new Set(["rate_limited", "quota_exhausted"]);
const MAX_UPSTREAM_RETRIES = 3;
const UPSTREAM_BACKOFF_BASE_MS = 15_000;

/**
 * Send a refused submit back to `queued` with an exponential delay (15s / 30s / 60s),
 * or report that the budget of retries is spent so the caller can fail it.
 *
 * Returns true when the job has been dealt with (re-queued, or already canceled) and
 * `runOne` should simply return.
 */
async function backoffRequeue(id: string, error: unknown): Promise<boolean> {
  if (!(error instanceof ProviderHttpError) || !UPSTREAM_BACKOFF_CODES.has(error.code)) {
    return false;
  }
  const rec = await readJob(id);
  if (!rec) return false;
  // A cancel that landed while the refused request was in flight wins; there is
  // nothing to re-queue and nothing to fail.
  if (rec.canceled || rec.status === "canceled") return true;
  const attempts = rec.upstreamRetries ?? 0;
  if (attempts >= MAX_UPSTREAM_RETRIES) return false;
  const delayMs = UPSTREAM_BACKOFF_BASE_MS * 2 ** attempts;
  const next = await updateJob(id, (r) => {
    if (r.status === "canceled" || r.canceled) return r;
    r.status = "queued";
    r.upstreamRetries = (r.upstreamRetries ?? 0) + 1;
    r.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    return r;
  });
  emitRec(next);
  log("info", "upstream refused submit, backing off", {
    id,
    code: error.code,
    attempt: attempts + 1,
    delayMs,
  });
  return true;
}

/**
 * 一家上游说「积分不足」时，把这次任务改交给下一家接得下的 provider。
 *
 * 被拒的 submit 从来没有被计费，所以换家不是「再买一次」，而是同一次任务换个门；
 * 相比 `backoffRequeue` 的等 15/30/60 秒再撞同一堵墙，充值之前那堵墙不会自己消失。
 *
 * 换家会重算 model 与上游档位（新家的时长 / 分辨率枚举不一样），`priceCny` 则**只降不升**：
 * 换家是我们内部的事，用户什么都没做，不能让他多付；新家的档位反而更便宜时照低的收，
 * 因为交付的确实是更低的那一档。`upstreamRetries` 不加——退避重试的预算是留给「同一家
 * 暂时忙」的。
 *
 * 新家的时长档位比原来**大**（可灵 5 秒 → 只有 10/15 档的模型）且售价会因此上涨时，
 * 干脆不换：那等于替用户买了一个他没选的时长。这种任务交回退避路径，按原规则重试或失败。
 *
 * 返回 true 表示这次失败已经被处理掉（换家或任务已取消），`runOne` 直接返回。
 */
async function switchAwayFromExhausted(id: string, error: unknown): Promise<boolean> {
  if (!(error instanceof ProviderHttpError) || error.code !== "quota_exhausted") return false;
  const rec = await readJob(id);
  if (!rec) return false;
  if (rec.canceled || rec.status === "canceled") return false;
  const kind = isImageMode(rec.mode) ? "image" : "video";
  await markExhausted(rec.provider, kind, error.message);

  let next: ProviderId;
  try {
    next = currentProviderId(rec.mode, {
      harness: Boolean(rec.harness?.enabled),
      aspectRatio: rec.aspectRatio ?? undefined,
      // 尾帧是硬条件：换到一家发不出尾帧的上游，交付的是另一个东西，不是同一件事换个门。
      needsLastFrame: Boolean(rec.assets.last),
      // 分辨率**故意不做硬条件**：这条路径上的备选是「降一档并退掉差价」还是「彻底没有
      // 成片」。降档后 `priceCny` 只降不升（下面那段），所以降档是对用户有利的一侧；
      // 而创建任务时没有这个两难，1080p 接不下就该 400，不该悄悄给 720p。
      durationSec: rec.durationSec,
    });
  } catch {
    // 没有一家接得下这个画幅了（`currentProviderId` 的 400）：交回退避路径，
    // 让它按既有规则重试或失败，而不是在这里编一个新的错误码。
    return false;
  }
  // 换到 mock 就是拿一段水印片冒充成片。宁可让任务照常失败，也不交付一个假成片。
  if (next === rec.provider || next === "mock") return false;

  const model = modelForProvider(next, rec.mode);
  // 长片的 30/45/60 是管线内部拆 shot 的目标总长，不按上游档位归一；换家只换执行方，
  // job.durationSec 必须留住，否则下游认不出它走 harness。分辨率 / 音轨 / 画幅的归一
  // 照常走——`harnessSettingsFor` 只取非时长字段。
  const isHarness = Boolean(rec.harness?.enabled);
  const normBody = {
    prompt: rec.prompt,
    aspectRatio: rec.aspectRatio ?? undefined,
    resolution: rec.resolution ?? undefined,
    generateAudio: rec.generateAudio,
  };
  // 产品只当标签用，不参与归一：换家是我们内部的事，不该顺手把实例配置
  // （`KLING_VIDEO_AUDIO` 之类）换成产品表里的默认档，那会改动用户被收的钱。
  const normOpts = { hasLastFrame: Boolean(rec.assets.last) };
  const hSettings = isHarness
    ? harnessSettingsFor(next, rec.mode, normBody, model, normOpts)
    : null;
  const settings = isHarness
    ? null
    : providerSettingsFor(next, rec.mode, rec.durationSec, normBody, model, normOpts);
  // 产品标签跟着 provider 走：换家之后仍挂着「标准」，界面就会拿一个不是这次执行的
  // 产品名去显示。找不到对应产品就摘掉标签，不编一个。音轨也要对上——可灵的「标准」
  // 与「高清有声」共用同一个上游模型，只按模型名找会把出声的那条标成无声的那一档。
  const product = productForProvider(next, rec.mode, model, {
    audio: (settings ?? hSettings)?.audio,
  });
  // 新家归一后这次任务该值多少钱。图片模式 `settings` 恒为 null，算出来与原价同档。
  const switchedPrice = priceCny({
    mode: rec.mode,
    durationSec: settings ? settings.durationSec : rec.durationSec,
    resolution: (settings ?? hSettings)?.resolution ?? rec.resolution,
    generateAudio: (settings ?? hSettings)
      ? (settings ?? hSettings)!.audio === "native"
      : rec.generateAudio,
    imageResolution: rec.imageResolution,
  });
  // 用户选的是 5 秒，新家最短 10 秒且因此更贵：这不是「同一件事换个门」，是另一件商品。
  if (settings && settings.durationSec > rec.durationSec && switchedPrice > rec.priceCny) {
    log("info", `provider ${rec.provider} 积分耗尽，但 ${next} 的时长档更长且更贵，放弃换家`, {
      id,
      from: rec.provider,
      to: next,
      fromDurationSec: rec.durationSec,
      toDurationSec: settings.durationSec,
    });
    return false;
  }
  const from = rec.provider;
  const updated = await updateJob(id, (r) => {
    if (r.canceled || r.status === "canceled") return r;
    r.provider = next;
    r.model = model;
    r.product = product?.id;
    r.productName = product?.name;
    if (settings) {
      r.durationSec = settings.durationSec;
      r.resolution = settings.resolution;
      r.generateAudio = settings.audio === "native";
    }
    if (hSettings) {
      // 长片只搬非时长字段：durationSec 是管线目标总长，不归一。
      r.resolution = hSettings.resolution;
      r.generateAudio = hSettings.audio === "native";
    }
    // 只降不升：报价是对用户的承诺，换家不能让它涨；新档更便宜就照新档收。
    r.priceCny = Math.min(r.priceCny, switchedPrice);
    r.costUsdEstimate = isImageMode(r.mode)
      ? r.costUsdEstimate
      : isHarness
        ? harnessSubmitEstimateUsd(packHarnessDuration(r.durationSec as 30 | 45 | 60), {
            model,
            video: videoPricingOf(hSettings, next) ?? {
              resolution: r.resolution ?? "720p",
              audio: r.generateAudio ? "native" : "off",
              provider: next,
            },
          })
        : estimateCostUsd(model, r.durationSec, undefined, videoPricingOf(settings, next));
    r.status = "queued";
    // 上一家的退避时间戳不该拖住新家：这是另一个门，不用等。
    delete r.nextAttemptAt;
    return r;
  });
  if (updated.provider !== next) return false;
  emitRec(updated);
  log("info", `provider ${from} 积分耗尽，任务改走 ${next}`, {
    id,
    from,
    to: next,
    model,
    detail: error.message,
  });
  return true;
}

/** User-facing wording for a refusal that survived every retry; upstream text goes to `detail`. */
function upstreamFailure(error: ProviderHttpError): { message: string; detail: string } {
  const message =
    error.code === "quota_exhausted"
      ? "平台余额不足，请联系管理员"
      : `上游繁忙，已重试 ${MAX_UPSTREAM_RETRIES} 次仍失败，请稍后再试`;
  return { message, detail: error.message };
}

/**
 * Re-arm the wake-up for backed-off jobs. Called on every pump so the timer always
 * tracks the *earliest* deadline currently on disk; `unref` keeps it from holding a
 * short-lived process (tests, scripts) open.
 */
function scheduleBackoffPump(s: RunnerState, atMs: number) {
  if (s.backoffTimer) {
    clearTimeout(s.backoffTimer);
    s.backoffTimer = undefined;
  }
  if (!Number.isFinite(atMs)) return;
  // Cap the sleep so a corrupt far-future timestamp cannot park the queue forever.
  const delay = Math.min(Math.max(atMs - Date.now(), 50), 5 * 60_000);
  s.backoffTimer = setTimeout(() => {
    s.backoffTimer = undefined;
    void pump();
  }, delay);
  s.backoffTimer.unref();
}

/**
 * 挑出这一轮该跑的任务并发出去。
 *
 * 只读待办集合里的那几条记录，不再全量扫盘（方案 §3.3）。集合里跑到终态的、以及记录
 * 已经不在了的，就地摘掉——这是待办集合唯一的收缩路径，所以每条任务终态之后至少还会
 * 被 `pump` 看一眼。
 */
async function pump() {
  const s = state();
  const cap = jobConcurrency();
  if (s.inflight.size >= cap) return;
  const now = Date.now();
  let earliestDeferred = Infinity;
  // 先跑已经在上游跑着的（pending / persisting / 长片管线），再跑排队的：一条已经
  // 花过钱的任务比一条还没提交的更该占住并发额度。与全量扫盘时代的顺序一致。
  const running: string[] = [];
  const queued: string[] = [];
  for (const id of [...s.todo]) {
    if (s.inflight.has(id)) continue;
    const job = await readJob(id);
    if (!job || isTerminalStatus(job.status) || job.canceled) {
      s.todo.delete(id);
      continue;
    }
    if (job.status === "queued") {
      const at = job.nextAttemptAt ? Date.parse(job.nextAttemptAt) : NaN;
      if (Number.isFinite(at) && at > now) {
        earliestDeferred = Math.min(earliestDeferred, at);
        continue;
      }
      queued.push(id);
      continue;
    }
    if (job.status === "pending" || job.status === "persisting" || HARNESS_ACTIVE.has(job.status)) {
      running.push(id);
    }
  }
  scheduleBackoffPump(s, earliestDeferred);
  for (const id of [...running, ...queued]) {
    if (s.inflight.size >= cap) break;
    // 上面每条都 await 过一次读盘，期间另一次 pump 可能已经把这条发出去了；这一层
    // 同步的复查是「同一条任务被跑两遍」的最后一道闸（下面的 add 与它之间没有 await）。
    if (s.inflight.has(id)) continue;
    s.inflight.add(id);
    void runOne(id).finally(() => {
      s.inflight.delete(id);
      void pump();
    });
  }
}

async function runOne(id: string) {
  let job = await readJob(id);
  if (!job) return;
  // 这条任务往下所有层的 `log()` 自动带上 jobId / ownerId（方案 §3.2「可观测性」）。
  // `reqId` 显式清掉：`pump()` 常常是被一次 `POST /api/jobs` 叫醒的，于是它这一轮捡起来的
  // **每一条**排队任务都会继承那次请求的 id——包括别人早就排在那里的任务。一个指向错误
  // 请求的 id 比没有 id 更糟：排障时会照着它去翻另一个人的请求。
  enterLogContext({ reqId: undefined, jobId: job.id, ownerId: job.ownerId });
  if (job.canceled || job.status === "canceled") return;
  try {
    if (isHarnessDuration(job.durationSec) && job.status !== "persisting") {
      // Long clips never touch a provider directly: the orchestrator owns
      // queued → … → stitching and hands the stitched file back as persisting.
      try {
        await harnessOrchestrator.execute(id);
      } catch (error) {
        // 长片同样先试换家：quota_exhausted 被 shot 层包成 ShotFailure 时到不了这里，
        // 但 orchestrator 自己抛出的 ProviderHttpError（如预算/上游拒绝）仍走换家。
        if (await switchAwayFromExhausted(id, error)) return;
        throw error;
      }
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
      if (job.status === "persisting") await persist(job);
      return;
    }
    if (job.status === "queued") {
      job = await transition(id, "submitting");
      try {
        await submit(job);
      } catch (error) {
        // 积分耗尽先试换家：等下去只会撞同一堵墙，而被拒的 submit 没有被计费。
        if (await switchAwayFromExhausted(id, error)) return;
        // A refused submit was never billed, so it may be re-sent. Handled here rather
        // than in the catch below so "已重试 3 次" can only be said once that is true.
        if (await backoffRequeue(id, error)) return;
        if (error instanceof ProviderHttpError && UPSTREAM_BACKOFF_CODES.has(error.code)) {
          const { message, detail } = upstreamFailure(error);
          await fail(id, error.code, message, detail);
          return;
        }
        // R06：到这儿的失败里混着「上游可能已经接单」的那一类（读超时、断连、5xx）。
        // 直接当未计费失败 / 重新入队，等于在可能已经付费的请求上再买一次——先查上游
        // 认不认这个外部单号，认了就接管继续轮询，查不到才按 uncertain_submit 结。
        const ambiguous = await resolveAmbiguousSubmit(id, error);
        if (ambiguous === "handled") return;
        if (ambiguous === "not-ambiguous") throw error;
        // "resumed"：落回下面公共的重读 + 轮询段，这条任务接着往出片走。
      }
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
    }
    if (job.status === "pending" || job.status === "submitting") {
      await pollUntilDone(id);
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
    }
    if (job.status === "persisting") {
      await persist(job);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A user pressing 取消 makes the in-flight provider call throw; that is the
    // feature working, not an incident, so it must not show up in the error log.
    const canceledByUser = e instanceof ProviderHttpError && e.code === "canceled";
    log(canceledByUser ? "info" : "error", "job failed", { id, msg });
    if (msg === "HARNESS_NOT_ENABLED") {
      await fail(id, "harness", "一致性管线尚未开放");
      return;
    }
    if (e instanceof HarnessFailure) {
      await fail(id, e.code, e.message);
      return;
    }
    await fail(id, e instanceof ProviderHttpError ? e.code : "internal", msg);
  }
}

async function submit(job: JobRecord) {
  const provider = providerForId(job.provider);

  if (needsSourceFileUpload(provider.id, job.mode) && job.assets.source) {
    const abs = path.join(mediaStore.jobDir(job.id), job.assets.source.path);
    let uploadedFileId: string | undefined;
    try {
      const fileId = await uploadXaiFile(abs, "source.mp4");
      uploadedFileId = fileId;
      const afterUpload = await readJob(job.id);
      if (!afterUpload || afterUpload.status === "canceled" || afterUpload.canceled) {
        await deleteXaiFile(fileId);
        uploadedFileId = undefined;
        return;
      }
      await updateJob(job.id, (r) => {
        if (r.status === "canceled" || r.canceled) return r;
        if (r.assets.source) r.assets.source.xaiFileId = fileId;
        return r;
      });
      const afterClaim = await readJob(job.id);
      if (!afterClaim || afterClaim.status === "canceled" || afterClaim.canceled) {
        await deleteXaiFile(fileId);
        uploadedFileId = undefined;
        return;
      }
      job = afterClaim;
    } catch (e) {
      if (uploadedFileId) await deleteXaiFile(uploadedFileId);
      if (e instanceof ProviderHttpError) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      log("error", "source video Files upload failed", { id: job.id, detail });
      throw new Error("源视频上传失败，请重试");
    }
  }

  const beforeProvider = await readJob(job.id);
  if (!beforeProvider || beforeProvider.status === "canceled" || beforeProvider.canceled) {
    if (job.assets.source?.xaiFileId) await deleteXaiFile(job.assets.source.xaiFileId);
    return;
  }
  job = beforeProvider;
  const req = toProviderReq(job);
  const handle = await provider.submit(req);
  const afterProvider = await readJob(job.id);
  if (!afterProvider || afterProvider.status === "canceled" || afterProvider.canceled) {
    await removeLocalOutput(job.id, handle.localVideoPath);
    if (afterProvider?.assets.source?.xaiFileId) {
      await deleteXaiFile(afterProvider.assets.source.xaiFileId);
    }
    return;
  }
  if (handle.respectModeration === false) {
    await removeLocalOutput(job.id, handle.localVideoPath);
    await fail(job.id, "moderation", "未通过安全审核");
    return;
  }
  await updateJob(job.id, (r) => {
    if (r.status === "canceled" || r.canceled) return r;
    r.remoteId = handle.remoteId ?? job.id;
    r.fileOutputId = handle.fileOutputId ?? r.fileOutputId;
    r.localOutputPath = handle.localVideoPath;
    // A provider that stages the file itself (OpenAI images) reports its charge on the same
    // handle; booking the cost only in the remoteUrl branch would drop it silently.
    r.costUsdActual = handle.costUsdActual ?? r.costUsdActual;
    if (handle.remoteUrl) {
      delete r.localOutputPath;
      r.remoteUrl = handle.remoteUrl;
      r.status = "persisting";
      r.progress = 90;
    } else if (!handle.localVideoPath) {
      r.status = "pending";
      r.progress = 5;
    } else {
      r.status = "persisting";
      r.progress = 90;
    }
    return r;
  }).then(emitRec);
}

function toProviderReq(job: JobRecord): ProviderGenerateRequest {
  const start = job.assets.start
    ? pathRef(job.id, job.assets.start.path)
    : undefined;
  // 尾帧只发给声明 `supportsLastFrameLock` 的 provider。发不了的那几家里，grok 的
  // `assertModeConstraints` 会对带尾帧的请求体直接 400——一条 kling 之前落盘过尾帧的
  // 老任务（那时尾帧只存不发）重试到 grok 就会永远失败，而它本来该照常出片、忽略尾帧。
  const lastImage =
    job.assets.last && providerForId(job.provider).capabilities().supportsLastFrameLock
      ? pathRef(job.id, job.assets.last.path)
      : undefined;
  const refs = job.assets.references?.map((a) => pathRef(job.id, a.path));
  let source: MediaRef | undefined;
  if (job.assets.source?.xaiFileId) {
    source = { kind: "file_id", fileId: job.assets.source.xaiFileId };
  } else if (job.assets.source) {
    source = { kind: "path", path: path.join(mediaStore.jobDir(job.id), job.assets.source.path) };
  }
  return {
    jobId: job.id,
    mode: job.mode,
    prompt: job.prompt,
    model: job.model,
    durationSec: job.mode === "edit_video" || isImageMode(job.mode) ? undefined : job.durationSec,
    aspectRatio: job.aspectRatio ?? undefined,
    resolution: job.resolution ?? undefined,
    imageResolution: job.imageResolution ?? undefined,
    generateAudio: isImageMode(job.mode) ? false : job.generateAudio,
    startImage: start,
    // 可灵在图生视频里以 `last_frame` 发送（上游强制 1080p，`create.ts` 已按这一档定价）；
    // 其余 provider 拿不到它，尾帧只留在 `inputs/last.jpg`（上面那段）。
    lastImage,
    referenceImages: refs,
    referenceAudios: job.voiceIds?.map((voiceId) => ({ voiceId })),
    sourceVideo: source,
    // Re-read job.json rather than close over a flag: "轮询是真相" applies here too —
    // the cancel route writes the record from another request, and a provider that
    // blocks for minutes has to see that write while it is still blocking.
    shouldAbort: async () => {
      const latest = await readJob(job.id);
      return !latest || latest.status === "canceled" || Boolean(latest.canceled);
    },
  };
}

function pathRef(jobId: string, rel: string): MediaRef {
  return { kind: "path", path: path.join(mediaStore.jobDir(jobId), rel) };
}

async function pollUntilDone(id: string) {
  const first = await readJob(id);
  if (!first || first.status === "canceled") return;
  // 总上限按这条任务的 provider 取一次（方案 §2 G6）。中途换家的路径不会走到这儿——
  // `switchAwayFromExhausted` 把任务打回 `queued`，下一轮重新进这个函数。
  const timeoutMs = taskTimeoutMsFor(first.provider);
  const started = Date.now();
  let transientRetries = 0;
  while (Date.now() - started < timeoutMs) {
    const job = await readJob(id);
    if (!job || job.status === "canceled") return;
    const provider = providerForId(job.provider);
    let poll: Awaited<ReturnType<typeof provider.poll>>;
    try {
      poll = await provider.poll({
        providerId: provider.id,
        remoteId: job.remoteId,
        localVideoPath: "outputs/video.mp4",
      });
    } catch (error) {
      if (!isRetryablePollError(error) || transientRetries >= 2) throw error;
      transientRetries += 1;
      await sleep(upstreamRetryBaseMs() * 2 ** (transientRetries - 1));
      continue;
    }
    if (isRetryablePollResult(poll)) {
      if (transientRetries >= 2) {
        // Let the normal failed path preserve the upstream code/message.
      } else {
        transientRetries += 1;
        await sleep(upstreamRetryBaseMs() * 2 ** (transientRetries - 1));
        continue;
      }
    } else {
      // A successful pending response breaks a transient-error streak.
      transientRetries = 0;
    }
    const again = await readJob(id);
    if (
      !again ||
      again.status === "canceled" ||
      again.canceled ||
      ["succeeded", "failed", "expired"].includes(again.status)
    ) {
      return;
    }
    if (poll.status === "pending") {
      // 进度没动就不写盘、不广播（方案 §3.3「轮询」）。一条 5 分钟的任务上游多半只报
      // 几次进度，其余几十次轮询是一模一样的答复，为它们重写 job.json 再走一遍 SSE
      // 只是在 2 核机上白烧 IO 和事件循环。状态还不是 `pending`（刚从 submitting 过来）
      // 时仍要写：那一次是真的有变化。
      const unchanged =
        again.status === "pending" && Math.max(again.progress, poll.progress) === again.progress;
      if (!unchanged) {
        await updateJob(id, (r) => {
          if (r.status === "canceled" || r.canceled) return r;
          r.progress = Math.max(r.progress, poll.progress);
          r.status = "pending";
          return r;
        }).then(emitRec);
      }
      await sleep(pollDelayMs(Date.now() - started));
      continue;
    }
    if (poll.status === "expired") {
      await updateJob(id, (r) => {
        r.status = "expired";
        r.error = { code: "expired", message: "生成任务已过期" };
        return r;
      }).then(emitRec);
      return;
    }
    if (poll.status === "failed" || poll.respectModeration === false) {
      await fail(
        id,
        poll.errorCode ?? "failed",
        poll.respectModeration === false ? "未通过安全审核" : (poll.errorMessage ?? "生成失败"),
      );
      return;
    }
    await updateJob(id, (r) => {
      if (r.status === "canceled" || r.canceled) return r;
      r.status = "persisting";
      r.progress = 90;
      r.remoteUrl = poll.remoteUrl;
      r.fileOutputId = poll.fileOutputId ?? r.fileOutputId;
      r.costUsdActual = poll.usage?.costUsdActual ?? r.costUsdActual;
      return r;
    }).then(emitRec);
    return;
  }
  await fail(id, "timeout", LOCAL_GIVE_UP_MESSAGE);
}

const RETRYABLE_POLL_CODES = new Set([
  "service_unavailable",
  "internal_error",
  "upstream_unavailable",
  "upstream_timeout",
]);

function isRetryablePollError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.code === "invalid_argument") return false;
  return error.status === 429 || error.status >= 500 || RETRYABLE_POLL_CODES.has(error.code);
}

function isRetryablePollResult(poll: Awaited<ReturnType<VideoProvider["poll"]>>): boolean {
  return poll.status === "failed" && Boolean(poll.errorCode && RETRYABLE_POLL_CODES.has(poll.errorCode));
}

async function persist(job: JobRecord) {
  const latest = await readJob(job.id);
  if (!latest || latest.status === "canceled" || latest.canceled) return;
  const outDir = path.join(mediaStore.jobDir(job.id), "outputs");
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpDir(), { recursive: true });

  if (isImageMode(latest.mode)) {
    const committed = await stageThenCommit({
      jobId: latest.id,
      destRel: "outputs/image.jpg",
      tmpAbs: path.join(tmpDir(), `${latest.id}-image.jpg`),
      localPath: latest.localOutputPath,
      remoteUrl: latest.remoteUrl,
      fileId: latest.fileOutputId,
      providerId: latest.provider,
    });
    if (!committed) return;
    const next = await updateJob(job.id, (r) => {
      if (r.status !== "persisting" || r.canceled) return r;
      r.status = "succeeded";
      r.progress = 100;
      r.output = {
        kind: "image",
        imageUrl: mediaStore.publicPath(r.id, "image.jpg"),
      };
      delete r.localOutputPath;
      r.error = null;
      return r;
    });
    if (next.status !== "succeeded") {
      await rm(path.join(outDir, "image.jpg"), { force: true }).catch(() => undefined);
      return;
    }
    emitRec(next);
    return;
  }

  const videoTmp = path.join(tmpDir(), `${latest.id}-video.mp4`);
  const committed = await stageThenCommit({
    jobId: latest.id,
    destRel: "outputs/video.mp4",
    tmpAbs: videoTmp,
    localPath: latest.localOutputPath,
    remoteUrl: latest.remoteUrl,
    fileId: latest.fileOutputId,
    providerId: latest.provider,
  });
  if (!committed) return;

  const posterAbs = path.join(outDir, "poster.jpg");
  const videoAbs = path.join(outDir, "video.mp4");
  try {
    await extractPoster(videoAbs, posterAbs);
  } catch {
    await copyFile(
      path.join(/*turbopackIgnore: true*/ mediaStore.jobDir(job.id), latest.assets.start?.path ?? "tmp/still.jpg"),
      posterAbs,
    ).catch(() => undefined);
  }
  let outputDurationSec = latest.durationSec;
  try {
    outputDurationSec = (await probeDurationSec(videoAbs)).durationSec;
  } catch {
    // Keep the requested duration when a provider returns a playable file
    // that ffmpeg cannot probe a second time.
  }
  const hasPoster = await access(posterAbs).then(() => true).catch(() => false);
  const canceled = await readJob(job.id);
  if (!canceled || canceled.status === "canceled" || canceled.canceled) {
    await rm(videoAbs, { force: true }).catch(() => undefined);
    await rm(posterAbs, { force: true }).catch(() => undefined);
    return;
  }
  const next = await updateJob(job.id, (r) => {
    if (r.status !== "persisting" || r.canceled) return r;
    r.status = "succeeded";
    r.progress = 100;
    r.output = {
      kind: "video",
      videoUrl: mediaStore.publicPath(r.id, "video.mp4"),
      posterUrl: hasPoster ? mediaStore.publicPath(r.id, "poster.jpg") : "",
      durationSec: outputDurationSec,
    };
    delete r.localOutputPath;
    r.error = null;
    return r;
  });
  if (next.status !== "succeeded") {
    await rm(videoAbs, { force: true }).catch(() => undefined);
    await rm(posterAbs, { force: true }).catch(() => undefined);
    return;
  }
  emitRec(next);
}

async function stageThenCommit(opts: {
  jobId: string;
  destRel: string;
  tmpAbs: string;
  localPath?: string;
  remoteUrl?: string;
  fileId?: string;
  /** 成片属于哪家上游；下载鉴权头按它绑定（见 `download-headers.ts`）。 */
  providerId?: ProviderId;
}): Promise<boolean> {
  const finalAbs = path.join(mediaStore.jobDir(opts.jobId), opts.destRel);
  const isCanceled = async () => {
    const current = await readJob(opts.jobId);
    return !current || current.status === "canceled" || Boolean(current.canceled);
  };

  if (opts.localPath) {
    const localAbs = resolveLocalOutput(mediaStore.jobDir(opts.jobId), opts.localPath);
    if (localAbs === finalAbs) {
      if (await isCanceled()) {
        await rm(finalAbs, { force: true }).catch(() => undefined);
        return false;
      }
      return true;
    }
    return commitLocalOutput(localAbs, finalAbs, isCanceled);
  }

  const hasRemote = Boolean(opts.remoteUrl || opts.fileId);
  if (hasRemote) {
    await persistRemote({
      dest: opts.tmpAbs,
      remoteUrl: opts.remoteUrl,
      fileId: opts.fileId,
      providerId: opts.providerId,
    });
    return commitLocalOutput(opts.tmpAbs, finalAbs, isCanceled);
  } else {
    try {
      // Even a provider that leaves a pre-staged file should pass through the
      // same temporary path; cancellation must never expose a half-written
      // artifact in outputs/.
      await persistRemote({ dest: opts.tmpAbs });
    } catch {
      await rm(opts.tmpAbs, { force: true }).catch(() => undefined);
      throw new Error("成片不存在");
    }
    return commitLocalOutput(opts.tmpAbs, finalAbs, isCanceled);
  }
}

async function transition(id: string, to: JobRecord["status"]) {
  const rec = await updateJob(id, (r) => {
    if (!canTransition(r.status, to) && r.status !== to) {
      throw new Error(`illegal ${r.status} -> ${to}`);
    }
    r.status = to;
    return r;
  });
  emitRec(rec);
  return rec;
}

async function fail(id: string, code: string, message: string, detail?: string) {
  const rec = await readJob(id);
  if (
    !rec ||
    rec.canceled ||
    ["succeeded", "failed", "expired", "canceled"].includes(rec.status)
  ) {
    return;
  }
  if (rec?.localOutputPath) await removeLocalOutput(id, rec.localOutputPath);
  if (rec?.assets.source?.xaiFileId) {
    void deleteXaiFile(rec.assets.source.xaiFileId);
  }
  const next = await updateJob(id, (r) => {
    if (["succeeded", "failed", "expired", "canceled"].includes(r.status) || r.canceled) return r;
    r.status = code === "expired" ? "expired" : "failed";
    r.error = detail ? { code, message, detail } : { code, message };
    return r;
  });
  emitRec(next);
}

function emitRec(rec: JobRecord) {
  emitJob(toPublic(rec));
  return rec;
}

async function removeLocalOutput(jobId: string, relativePath?: string) {
  await cleanupJobArtifacts(mediaStore.jobDir(jobId), tmpDir(), jobId, relativePath);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const HARNESS_ACTIVE: ReadonlySet<JobRecord["status"]> = new Set([
  "directing",
  "keyframing",
  "generating_shots",
  "qc",
  "stitching",
]);

/**
 * 全站在途任务数（`MAX_QUEUED_JOBS` 的判据，`/api/health` 的队列读数）。
 *
 * 走索引（方案 §3.3）：它在每一次提交的准入路径上，从前却要把全站 job.json 读一遍。
 * 「在途」= 非终态，与旧的「queued / submitting / pending / persisting + 长片管线中间态」
 * 是同一个集合（`state-machine.ts` 里终态没有出边）。
 */
export async function activeCount(): Promise<number> {
  const entries = await listJobIndex({ nonTerminal: true });
  return entries.length;
}
