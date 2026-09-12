import { createJob } from "@/lib/jobs/create";
import { cancelOwnedJob } from "@/lib/jobs/cancel";
import { lookupIdempotency, stableJsonHash } from "@/lib/jobs/idempotency";
import { withAdmissionLock } from "@/lib/jobs/admission";
import { reserveJobFunds } from "@/lib/billing/admission";
import type { CreateJobBody, JobStatus } from "@/lib/jobs/schema";
import { isTerminalStatus } from "@/lib/jobs/schema";
import { readJob } from "@/lib/jobs/store";
import { copyUpload, storeUploadFromBuffer } from "@/lib/jobs/upload";
import { ProviderHttpError } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { log } from "@/lib/log";
import { readCanvas } from "@/lib/canvas/store";
import {
  computeQuote,
  expandRegenerate,
  genDeps,
  isGenNode,
  mergePrompt,
  nodeInputHash,
  nodeMode,
  planNodeJob,
  type ReuseDecision,
} from "@/lib/canvas/graph";
import {
  carveRunShare,
  findRunByIdempotencyKey,
  listActiveCanvasRuns,
  listCanvasRuns,
  newCanvasRunId,
  readCanvasRun,
  updateCanvasRun,
  writeCanvasRun,
} from "@/lib/canvas/run-store";
import type {
  CanvasDocument,
  CanvasNode,
  CanvasNodeExecution,
  CanvasRun,
  CanvasRunApprovalBody,
  CanvasRunCreateBody,
  CanvasRunStatus,
} from "@/lib/canvas/schema";

/**
 * 画布 DAG 运行（D 包）：一次报价、一次确认、按依赖自动执行全部生成节点。
 *
 * 设计要点（docs/plan-dag-canvas-run-2026-09-12.md）：
 * - 子任务走 `createJob`——同一套准入 / 计价 / 预留 / 幂等，不另起炉灶；
 *   幂等键 `run:<runId>:<nodeId>:<attempt>`。
 * - 报价不落盘：`quoteHash` 是（文档 + 归一参数 + 价目表）的确定性哈希，创建时
 *   重算比对；执行器提交节点前再按 `quote.items[].priceCny` 校验成交价，不一致
 *   即 `price_changed`——「报的价 = 会扣的价」两道关。
 * - 崩溃窗口：提交前先 `lookupIdempotency` 查回既有 job 接管，不重新解析输入
 *   （素材复制每次产生新 uploadId，重新解析会撞 `idempotency_conflict`）。
 * - 素材不消耗：material / 上游产物一律复制成新上传再交给 createJob 认领。
 * - 取消是持久化意图：`cancelRequestedAt` 落盘后泵不再提交新节点，在途子任务
 *   走 `cancelOwnedJob`（R09 checkpoint 语义不变），全部终态后 run → canceled。
 * - run 执行不写回画布文档（后台写会与用户编辑抢 revision）；产物展示由前端
 *   用最新 run 的 nodeExecutions overlay。
 */

const OUTPUT_IMAGE_REL = "outputs/image.jpg";
const QUEUE_RETRY_MS = 15_000;
const SWEEP_INTERVAL_MS = 3_000;

const EXEC_TERMINAL = new Set(["succeeded", "failed", "blocked"]);

function requestHashOf(body: CanvasRunCreateBody): string {
  return stableJsonHash({
    canvasId: body.canvasId,
    quoteHash: body.quoteHash,
    approvalNodeIds: [...(body.approvalNodeIds ?? [])].sort(),
    regenerate: [...(body.regenerate ?? [])].sort(),
  });
}

/** 全部执行位终态时的 run 结算态；还有非终态位时返回 null。 */
function settledStatus(
  execs: readonly CanvasNodeExecution[],
  canceled: boolean,
): CanvasRunStatus | null {
  if (!execs.every((e) => EXEC_TERMINAL.has(e.status))) return null;
  if (canceled) return "canceled";
  if (execs.every((e) => e.status === "succeeded")) return "succeeded";
  if (execs.some((e) => e.status === "succeeded")) return "partially_failed";
  return "failed";
}

/** 复用要核的最后一步：历史任务还在、成功、产物没被留存清理、文件还在盘上。 */
async function jobOutputUsable(ownerId: string, jobId: string): Promise<boolean> {
  const job = await readJob(jobId);
  if (!job || job.ownerId !== ownerId || job.status !== "succeeded" || job.artifactsPurgedAt) {
    return false;
  }
  const rel = job.output?.kind === "image" ? "outputs/image.jpg" : "outputs/video.mp4";
  try {
    await mediaStore.statJobFile(jobId, rel);
    return true;
  } catch {
    return false;
  }
}

/**
 * 复用判定（D 切片二）：对每个不在 regen 闭包里的生成节点，按 `inputHash` 在该
 * 画布的历史 run（新→旧）里找「同节点、同输入、且成功」的执行位——命中且产物
 * 仍在盘上 → 采纳该 jobId；有命中记录但产物全都不可用 → `purged`（blocked，
 * 不悄悄重生成）；没有同输入的历史成功 → 不标记，正常执行。
 */
export async function resolveReuseForQuote(
  ownerId: string,
  doc: CanvasDocument,
  regen: ReadonlySet<string>,
): Promise<Map<string, ReuseDecision>> {
  const graph = { nodes: doc.nodes, edges: doc.edges };
  const priors = (await listCanvasRuns(ownerId)).filter((r) => r.canvasId === doc.id);
  const out = new Map<string, ReuseDecision>();
  for (const node of graph.nodes.filter(isGenNode)) {
    if (regen.has(node.id)) continue;
    const want = nodeInputHash(graph, node.id);
    let sawMatch = false;
    for (const prior of priors) {
      const item = prior.quote.items.find((i) => i.nodeId === node.id);
      // 切片一的旧 run 没有 inputHash——没有判定键就当不可复用。
      if (!item?.inputHash || item.inputHash !== want) continue;
      const exec = prior.nodeExecutions.find((e) => e.nodeId === node.id);
      if (exec?.status !== "succeeded" || !exec.jobId) continue;
      sawMatch = true;
      if (await jobOutputUsable(ownerId, exec.jobId)) {
        out.set(node.id, { jobId: exec.jobId });
        break;
      }
    }
    if (!out.has(node.id) && sawMatch) out.set(node.id, "purged");
  }
  return out;
}

/**
 * 创建一次整图运行（D 切片二：含总预算冻结 + 复用采纳 + 审批门名单）。
 *
 * 三段式：锁外快路径做幂等查询与报价重算（慢路径不占全局准入锁）；
 * `withAdmissionLock` 内再查一次幂等键（并发双发只有一个能建出来）、复核
 * revision、按 `totalCny` 冻结 run 级预留、写盘——hold 落盘后才出锁。
 */
export async function createCanvasRun(
  ownerId: string,
  body: CanvasRunCreateBody,
): Promise<{ run: CanvasRun; replay: boolean }> {
  const requestHash = requestHashOf(body);
  const replyPrior = (prior: CanvasRun) => {
    if (prior.idempotency!.requestHash !== requestHash) {
      throw new ProviderHttpError(
        409,
        "idempotency_conflict",
        "同一幂等键被用于不同的请求参数，请重新发起",
      );
    }
    return { run: prior, replay: true };
  };
  const prior = await findRunByIdempotencyKey(ownerId, body.idempotencyKey);
  if (prior) return replyPrior(prior);

  const doc = await readCanvas(ownerId, body.canvasId);
  if (!doc) throw new ProviderHttpError(404, "not_found", "画布不存在");
  const graph = { nodes: doc.nodes, edges: doc.edges };
  const genIds = new Set(graph.nodes.filter(isGenNode).map((n) => n.id));
  for (const id of [...(body.approvalNodeIds ?? []), ...(body.regenerate ?? [])]) {
    if (!genIds.has(id)) {
      throw new ProviderHttpError(400, "invalid_argument", "审批/重跑名单里有非生成节点");
    }
  }
  const regen = expandRegenerate(graph, body.regenerate ?? []);
  const reuse = await resolveReuseForQuote(ownerId, doc, regen);
  const quote = await computeQuote(ownerId, doc, { regenerate: body.regenerate, reuse });
  if (quote.hash !== body.quoteHash) {
    throw new ProviderHttpError(409, "quote_stale", "报价已过期或画布已修改，请重新获取报价");
  }

  const now = new Date().toISOString();
  const nodeExecutions: CanvasNodeExecution[] = graph.nodes.filter(isGenNode).map((node) => {
    const decision = reuse.get(node.id);
    if (decision && decision !== "purged") {
      return {
        nodeId: node.id,
        attempt: 1,
        status: "succeeded" as const,
        jobId: decision.jobId,
        reused: true,
        startedAt: now,
        finishedAt: now,
      };
    }
    if (decision === "purged") {
      return {
        nodeId: node.id,
        attempt: 1,
        status: "blocked" as const,
        errorCode: "output_purged",
        finishedAt: now,
      };
    }
    return {
      nodeId: node.id,
      attempt: 1,
      status: genDeps(graph, node.id).length
        ? ("waiting_dependencies" as const)
        : ("ready" as const),
    };
  });

  const created = await withAdmissionLock(async () => {
    // 并发同 key 双发：锁内复核，只有一个能过——另一个同参交回 / 异参 409。
    const again = await findRunByIdempotencyKey(ownerId, body.idempotencyKey);
    if (again) return replyPrior(again);
    // revision 复核：锁外算报价用的 doc 和此刻落盘要冻结的必须是同一份。
    const fresh = await readCanvas(ownerId, body.canvasId);
    if (!fresh || fresh.revision !== doc.revision) {
      throw new ProviderHttpError(409, "quote_stale", "画布已修改，请重新获取报价");
    }
    // 总价冻结：分池口径与 createJob 的 reserveJobFunds 完全相同——建 run
    // 成功 = 全程钱够；不足即 402，run 文件不留痕。
    const hold = await reserveJobFunds(ownerId, quote.totalCny);
    const run: CanvasRun = {
      schemaVersion: 1,
      id: newCanvasRunId(),
      ownerId,
      canvasId: doc.id,
      documentRevision: doc.revision,
      graphSnapshot: graph,
      quote,
      reservation: hold
        ? {
            amountCny: hold.amountCny,
            memberCny: hold.memberCny,
            purchasedCny: hold.purchasedCny,
            remainingCny: hold.amountCny,
            remainingMemberCny: hold.memberCny,
            remainingPurchasedCny: hold.purchasedCny,
            transfers: {},
            ...(hold.subscriptionId ? { subscriptionId: hold.subscriptionId } : {}),
            ...(hold.periodIndex !== undefined ? { periodIndex: hold.periodIndex } : {}),
            createdAt: now,
          }
        : undefined,
      gatedNodeIds: body.approvalNodeIds?.length ? [...body.approvalNodeIds] : undefined,
      regenerate: regen.size ? [...regen].sort() : undefined,
      idempotency: { key: body.idempotencyKey, requestHash },
      status: "running",
      nodeExecutions,
      createdAt: now,
      updatedAt: now,
    };
    // 全部执行位创建即终态（全复用 / 全 blocked）→ 直接落终态，不等泵。
    const settled = settledStatus(nodeExecutions, false);
    if (settled) {
      run.status = settled;
      run.finishedAt = now;
    }
    await writeCanvasRun(run);
    return { run, replay: false };
  });
  if (!created.replay && created.run.status === "running") kickSweep(ownerId, created.run.id);
  return created;
}

/** 审批门：批准 → 节点回 ready 等下一轮提交；驳回 → blocked 并传播下游。 */
export async function decideCanvasRunApproval(
  ownerId: string,
  runId: string,
  body: CanvasRunApprovalBody,
): Promise<CanvasRun> {
  const run = await updateCanvasRun(ownerId, runId, (r) => {
    const exec = r.nodeExecutions.find((e) => e.nodeId === body.nodeId);
    if (!exec) throw new ProviderHttpError(404, "not_found", "节点不在这次运行里");
    const want = body.decision === "approve" ? "approved" : "rejected";
    if (exec.status !== "awaiting_approval") {
      // 同决策重放交回原样（幂等）；异决策或时机已过都是 409。
      if (exec.approval?.decision === want) return undefined;
      throw new ProviderHttpError(409, "invalid_state", "该节点当前不需要审批或已有不同决策");
    }
    const now = new Date().toISOString();
    return {
      ...r,
      nodeExecutions: r.nodeExecutions.map((e) =>
        e.nodeId === body.nodeId
          ? body.decision === "approve"
            ? {
                ...e,
                status: "ready" as const,
                approval: { decision: "approved" as const, decidedAt: now },
              }
            : {
                ...e,
                status: "blocked" as const,
                errorCode: "approval_rejected",
                approval: { decision: "rejected" as const, decidedAt: now },
                finishedAt: now,
              }
          : e,
      ),
    };
  });
  if (!run) throw new ProviderHttpError(404, "not_found", "运行不存在");
  kickSweep(ownerId, runId);
  return run;
}

export async function readCanvasRunForUser(ownerId: string, runId: string): Promise<CanvasRun> {
  const run = await readCanvasRun(ownerId, runId);
  if (!run) throw new ProviderHttpError(404, "not_found", "运行不存在");
  return run;
}

export async function listRunsForCanvas(ownerId: string, canvasId: string): Promise<CanvasRun[]> {
  const runs = await listCanvasRuns(ownerId);
  return runs.filter((r) => r.canvasId === canvasId);
}

/** 取消：持久化意图后立即推一轮 sweep——停提交、收在途、全终态才落 canceled。 */
export async function cancelCanvasRun(ownerId: string, runId: string): Promise<CanvasRun> {
  const run = await updateCanvasRun(ownerId, runId, (r) => {
    if (r.status !== "running") return undefined; // 终态幂等交回
    return { ...r, cancelRequestedAt: r.cancelRequestedAt ?? new Date().toISOString() };
  });
  if (!run) throw new ProviderHttpError(404, "not_found", "运行不存在");
  kickSweep(ownerId, runId);
  return run;
}

/** fire-and-forget 推进一轮：异步错误只记日志，不许成 unhandled rejection。 */
function kickSweep(ownerId: string, runId: string): void {
  void sweepCanvasRun(ownerId, runId).catch((error) => {
    log("warn", "canvas run kick failed", {
      runId,
      msg: error instanceof Error ? error.message : String(error),
    });
  });
}

/** 上游 gen_image 本轮产物 → 复制成新的可认领上传。产物不在盘上 = 没有这份输入。 */
async function outputToUpload(jobId: string, ownerId: string): Promise<string | null> {
  const job = await readJob(jobId);
  if (!job || job.ownerId !== ownerId || job.status !== "succeeded" || job.output?.kind !== "image") {
    return null;
  }
  if (job.artifactsPurgedAt) return null;
  try {
    const bytes = await mediaStore.readJobFile(job.id, OUTPUT_IMAGE_REL);
    const side = await storeUploadFromBuffer(bytes, "start", ownerId);
    return side.uploadId;
  } catch {
    return null;
  }
}

/**
 * 节点本轮的图片输入：material 复制 > 上游 gen_image 本轮产物复制。
 * `execs` 必须传本轮刷新后的执行表——上游刚在同一轮里转 succeeded 时，
 * `run.nodeExecutions` 还是旧快照，读它会误判成「产物没来」。
 */
async function resolveRunImageInput(
  run: CanvasRun,
  execs: CanvasNodeExecution[],
  node: CanvasNode,
  ownerId: string,
): Promise<string | undefined> {
  const graph = run.graphSnapshot;
  const from = new Set(graph.edges.filter((e) => e.to === node.id).map((e) => e.from));
  const inputs = graph.nodes.filter((n) => from.has(n.id));
  const imageCapable = inputs.some((n) => n.kind === "material" || n.kind === "gen_image");
  for (const input of inputs) {
    if (input.kind === "material" && input.uploadId) {
      try {
        const side = await copyUpload(input.uploadId, "start", ownerId);
        return side.uploadId;
      } catch {
        continue; // 素材在报价后没了：试下一个候选，全不行才判失败。
      }
    }
    if (input.kind === "gen_image") {
      const exec = execs.find((e) => e.nodeId === input.id);
      if (exec?.status === "succeeded" && exec.jobId) {
        const uploadId = await outputToUpload(exec.jobId, ownerId);
        if (uploadId) return uploadId;
      }
    }
  }
  // 图上有图片来源却一份都解析不出来：不能静默退化成文生视频——用户按
  // 图生视频报的价、期待的是那张图的运动，交一个不相干的文生片是骗他。
  if (imageCapable) {
    throw new ProviderHttpError(400, "input_missing", "连入的图片素材不可用，请重新上传或重跑上游节点");
  }
  return undefined;
}

function jobToExecStatus(
  exec: CanvasNodeExecution,
  jobStatus: JobStatus,
  errorCode: string | undefined,
): CanvasNodeExecution {
  const now = new Date().toISOString();
  if (jobStatus === "succeeded") {
    return { ...exec, status: "succeeded", finishedAt: exec.finishedAt ?? now };
  }
  if (isTerminalStatus(jobStatus)) {
    return {
      ...exec,
      status: "failed",
      errorCode: errorCode ?? jobStatus,
      finishedAt: exec.finishedAt ?? now,
    };
  }
  return exec;
}

/** 单轮推进：刷新在途 → 传播 blocked → 提交就绪节点（或收敛取消）→ 结算终态。 */
async function sweepOnce(run: CanvasRun): Promise<CanvasRun> {
  const now = new Date().toISOString();
  const execs = run.nodeExecutions.map((e) => ({ ...e }));
  const byNode = new Map(execs.map((e) => [e.nodeId, e]));
  const graph = run.graphSnapshot;

  // 1) 在途节点按 job.json 刷新（轮询是真相）。
  for (const exec of execs) {
    if (exec.status !== "running" || !exec.jobId) continue;
    const job = await readJob(exec.jobId);
    if (!job) {
      Object.assign(exec, { status: "failed", errorCode: "job_missing", finishedAt: now });
      continue;
    }
    Object.assign(exec, jobToExecStatus(exec, job.status, job.error?.code));
  }

  // 2) 依赖失败/被拦 → blocked（立即标记，不必等其它上游跑完——那份输入已不可能来）。
  for (const exec of execs) {
    if (exec.status !== "waiting_dependencies" && exec.status !== "ready") continue;
    const deps = genDeps(graph, exec.nodeId);
    if (deps.some((d) => ["failed", "blocked"].includes(byNode.get(d.id)?.status ?? ""))) {
      Object.assign(exec, { status: "blocked", errorCode: "upstream_failed", finishedAt: now });
    }
  }

  if (run.cancelRequestedAt) {
    // 3a) 取消中：不再提交；未提交/待批准的标 blocked，在途的逐个走既有 job cancel。
    for (const exec of execs) {
      if (
        exec.status === "waiting_dependencies" ||
        exec.status === "ready" ||
        exec.status === "awaiting_approval"
      ) {
        Object.assign(exec, { status: "blocked", errorCode: "canceled", finishedAt: now });
      } else if (exec.status === "running" && exec.jobId) {
        try {
          await cancelOwnedJob(run.ownerId, exec.jobId);
        } catch {
          // 已终态 / 已 checkpoint：job 层语义原样保留，下一轮刷新会收进来。
        }
      }
    }
  } else {
    // 3b) 正常推进：依赖全成功的节点进入提交。
    for (const exec of execs) {
      if (exec.status !== "waiting_dependencies" && exec.status !== "ready") continue;
      const deps = genDeps(graph, exec.nodeId);
      if (!deps.every((d) => byNode.get(d.id)?.status === "succeeded")) continue;
      exec.status = "ready";
      if (exec.nextAttemptAt && Date.parse(exec.nextAttemptAt) > Date.now()) continue;

      // 人工审批门（D 切片二）：被设门且尚无批准决策 → 停住等 approvals 端点。
      if (
        run.gatedNodeIds?.includes(exec.nodeId) &&
        exec.approval?.decision !== "approved"
      ) {
        exec.status = "awaiting_approval";
        continue;
      }

      const node = graph.nodes.find((n) => n.id === exec.nodeId)!;
      const quoted = run.quote.items.find((i) => i.nodeId === exec.nodeId);
      // 成交价校验：归一价与报价快照不一致就停这条节点，不按新价静默扣款。
      try {
        const plan = planNodeJob(graph, node);
        if (quoted && plan.priceCny !== quoted.priceCny) {
          Object.assign(exec, { status: "failed", errorCode: "price_changed", finishedAt: now });
          continue;
        }
      } catch (e) {
        Object.assign(exec, {
          status: "failed",
          errorCode: e instanceof ProviderHttpError ? e.code : "internal_error",
          finishedAt: now,
        });
        continue;
      }

      const key = `run:${run.id}:${exec.nodeId}:${exec.attempt}`;
      // 崩溃窗口：可能上次已把任务建出来而没来得及写回。先按幂等键查回接管，
      // 不重新解析输入（素材复制每次产生新 uploadId，重建请求会撞 409）。
      const priorJobId = await lookupIdempotency(run.ownerId, key);
      if (priorJobId) {
        const job = await readJob(priorJobId);
        if (job && job.ownerId === run.ownerId) {
          exec.jobId = job.id;
          exec.startedAt ??= now;
          exec.status = "running";
          Object.assign(exec, jobToExecStatus(exec, job.status, job.error?.code));
          continue;
        }
      }

      try {
        const startUploadId =
          node.kind === "gen_video"
            ? await resolveRunImageInput(run, execs, node, run.ownerId)
            : undefined;
        const body: CreateJobBody = {
          mode: nodeMode(graph, node),
          prompt: mergePrompt(graph, node),
          ...(node.product ? { model: node.product } : {}),
          ...(startUploadId ? { startUploadId } : {}),
          idempotencyKey: key,
        };
        // 资金不从零押：createJob 临界区里调 carveRunShare，把该节点的份额从
        // run 级预留转移给子任务（台账幂等——崩溃重试复用同一份额换 jobId）。
        // 没有 run 预留（切片一的旧 run）回落普通预留——准入闸门不能因路径不同被绕过。
        const { job } = await createJob(body, run.ownerId, {
          reserveFunds: (priceCny, jobId) =>
            run.reservation
              ? carveRunShare(run, exec.nodeId, priceCny, jobId)
              : reserveJobFunds(run.ownerId, priceCny),
        });
        exec.jobId = job.id;
        exec.status = "running";
        exec.startedAt ??= now;
      } catch (e) {
        if (e instanceof ProviderHttpError && e.code === "queue_full") {
          // 队列满在 run 里是等待信号不是失败：15s 后泵再来试。
          exec.nextAttemptAt = new Date(Date.now() + QUEUE_RETRY_MS).toISOString();
          continue;
        }
        Object.assign(exec, {
          status: "failed",
          errorCode: e instanceof ProviderHttpError ? e.code : "internal_error",
          finishedAt: now,
        });
      }
    }
  }

  // 4) 全部执行位终态 → 结算 run。
  const settled = settledStatus(execs, Boolean(run.cancelRequestedAt));
  const status = settled ?? run.status;
  const finishedAt = settled ? now : run.finishedAt;
  return { ...run, status, nodeExecutions: execs, finishedAt };
}

/** 推进一张 run（锁内读-改-写）；终态 run 直接返回。 */
export async function sweepCanvasRun(ownerId: string, runId: string): Promise<CanvasRun | null> {
  return updateCanvasRun(ownerId, runId, (r) => (r.status === "running" ? sweepOnce(r) : undefined));
}

type PumpState = typeof globalThis & {
  __lumenCanvasRunPump?: { started: boolean; sweeping: boolean; timer?: NodeJS.Timeout };
};

function pumpState() {
  const g = globalThis as PumpState;
  if (!g.__lumenCanvasRunPump) g.__lumenCanvasRunPump = { started: false, sweeping: false };
  return g.__lumenCanvasRunPump;
}

/** 全部非终态 run 扫一遍（泵周期与创建/取消时调用）。 */
export async function sweepCanvasRuns(): Promise<void> {
  const s = pumpState();
  if (s.sweeping) return;
  s.sweeping = true;
  try {
    for (const run of await listActiveCanvasRuns()) {
      try {
        await sweepCanvasRun(run.ownerId, run.id);
      } catch (error) {
        log("warn", "canvas run sweep failed", {
          runId: run.id,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    s.sweeping = false;
  }
}

/** 冷启动注册：周期泵 + 立即先扫一轮（重启续跑就靠它）。 */
export function startCanvasRunPump(): void {
  const s = pumpState();
  if (s.started) return;
  s.started = true;
  s.timer = setInterval(() => void sweepCanvasRuns(), SWEEP_INTERVAL_MS);
  s.timer.unref();
  void sweepCanvasRuns();
}
