import { jobConcurrency } from "@/lib/env";
import { isHarnessDuration } from "@/lib/harness/durations";
import { HarnessFailure, harnessOrchestrator } from "@/lib/harness/orchestrator";
import { listJobIndex } from "@/lib/jobs/index";
import { recoverDecision } from "@/lib/jobs/recover";
import { JOB_UNCERTAIN_SUBMIT_MESSAGE, UNCERTAIN_SUBMIT_CODE } from "@/lib/jobs/retry-guard";
import { sweepRetention } from "@/lib/jobs/retention";
import { isTerminalStatus, type JobRecord } from "@/lib/jobs/schema";
import { listJobRecords, readJob, updateJob } from "@/lib/jobs/store";
import { sweepIdempotency, sweepTmp } from "@/lib/jobs/sweep";
import { enterLogContext, log } from "@/lib/log";
import { ProviderHttpError } from "@/lib/providers/types";
import { backoffRequeue, switchProvider } from "./runner/failover";
import { LOCAL_GIVE_UP_MESSAGE, pollUntilDone, taskTimeoutMsFor } from "./runner/poll";
import { persist } from "./runner/persist";
import { lookupInterruptedSubmit, resolveAmbiguousSubmit, submit } from "./runner/submit";
import {
  emitRec,
  fail,
  scheduleBackoffPump,
  state,
  transition,
  UPSTREAM_BACKOFF_CODES,
  upstreamFailure,
} from "./runner/state";

export {
  DEFAULT_TASK_TIMEOUT_MS,
  LOCAL_GIVE_UP_MESSAGE,
  pollDelayMs,
  taskTimeoutMsFor,
} from "./runner/poll";

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

/** recover 的陈旧判定 = provider 超时 + 这个余量（留给下载 / 抽帧的 persist 阶段）。 */
const RECOVER_STALE_MARGIN_MS = 5 * 60 * 1000;

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

const HARNESS_ACTIVE: ReadonlySet<JobRecord["status"]> = new Set([
  "directing",
  "keyframing",
  "generating_shots",
  "qc",
  "stitching",
]);

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
  scheduleBackoffPump(s, earliestDeferred, pump);
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
        // 长片同样先试换家：分镜级的确定拒绝在 shot 层消化（`onCertainRejection`），
        // orchestrator 自己抛出的 ProviderHttpError（如预算/上游拒绝）仍走任务级换家。
        if (await switchProvider(id, error, 0)) return;
        throw error;
      }
      job = await readJob(id);
      if (!job || job.status === "canceled" || job.canceled) return;
      if (job.status === "persisting") await persist(job);
      return;
    }
    if (job.status === "queued") {
      job = await transition(id, "submitting");
      const submitStarted = Date.now();
      try {
        await submit(job);
      } catch (error) {
        // 确定拒绝先试换家：被拒的 submit 没有计费，等下去只会撞同一堵墙。
        if (await switchProvider(id, error, Date.now() - submitStarted)) return;
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
