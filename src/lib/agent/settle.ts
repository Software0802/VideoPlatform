import { readdir } from "node:fs/promises";
import { applyBalanceChange } from "@/lib/billing/ledger";
import { log } from "@/lib/log";
import { round2 } from "@/lib/billing/protocol.mjs";
import { AGENT_SESSION_ID_RE, type AgentSession, type AgentTurn } from "@/lib/agent/schema";
import { agentDir, agentUserDir, readSession, updateSession } from "@/lib/agent/store";
import { USER_ID_RE } from "@/lib/users/schema";

/**
 * 智能体轮次的「收尸」逻辑（review 2026-09-15 B-07 / B-09）。
 *
 * 两种卡住，扣过的钱都挂在账上：
 *
 * - `thinking`：轮次费在调用 LLM **之前**就扣了（`run-turn.ts` 的 charge），进程在写回提案
 *   之前死掉，这笔钱就永远停在「思考中」。
 * - `executing`：批准之后、逐条 `createJob` 之间死掉。轮次永远显示「已批准，生成中」，
 *   界面上既没有重试也没有报错，会话因为有活动轮次也永不归档，唯一出路是重发一轮再付一次钱。
 *
 * 这个模块从 `run-turn.ts` 里分出来，是为了让 runner 的每小时维护能调它而不产生 import 环
 * （`run-turn` 会 import 任务侧的 createJob）。原来的惰性结算只在「有人打开这个会话」时触发，
 * 用户再也不打开的会话里那笔钱就一直挂着。
 */

/** 「还在 thinking」超过它 = 发起它的那次请求已经死了（进程重启 / 连接断）。 */
export const STALE_THINKING_MS = 2 * 60 * 1000;

/**
 * 「还在 executing」超过它 = 批准之后的建单循环死在半路。
 *
 * 5 分钟是保守值：`createJob` 不调上游，写完 job.json 就入队，整个批准循环是毫秒级的文件 IO，
 * 而且每建成一条就会刷新 `updatedAt`。真正会停在这里不动的只有「进程没了」。
 */
export const STALE_EXECUTING_MS = 5 * 60 * 1000;

/** 复活后给提案的新窗口，与 `run-turn.ts` 的 `PROPOSAL_TTL_MS` 同值（批准接口按它判过期）。 */
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** 结算判据只写一份：惰性结算与定时扫描共用，免得两边阈值哪天对不上。 */
export function staleThinkingTurns(session: AgentSession, nowMs = Date.now()): AgentTurn[] {
  return (session.turns ?? []).filter(
    (t) => t.status === "thinking" && nowMs - Date.parse(t.updatedAt) > STALE_THINKING_MS,
  );
}

/** 同上，`executing` 那一半。必须带 proposal——没有提案就无从让用户重新批准。 */
export function staleExecutingTurns(session: AgentSession, nowMs = Date.now()): AgentTurn[] {
  return (session.turns ?? []).filter(
    (t) =>
      t.status === "executing" &&
      Boolean(t.proposal) &&
      nowMs - Date.parse(t.updatedAt) > STALE_EXECUTING_MS,
  );
}

/**
 * 退这一轮的轮次费。`ref` 幂等（`applyBalanceChange` 按 ref 判重），`refundOf` 指向原扣款，
 * 让内核按原扣款的 memberCny 把钱拆回原来的池子。
 */
export async function refundTurn(ownerId: string, priceCny: number, ref: string): Promise<void> {
  try {
    await applyBalanceChange(
      ownerId,
      priceCny,
      {
        kind: "adjust",
        amountCny: priceCny,
        ref: `${ref}:refund`,
        note: "智能体对话失败退回",
      },
      { refundOf: ref },
    );
  } catch (error) {
    // 退款失败不该盖掉「智能体挂了」这个真正的原因；记一条 warn 供人工对账。
    log("warn", "智能体退款失败", { ownerId, ref, error: String(error) });
  }
}

/**
 * 卡住的 `thinking`：先退款（锁外，两把锁不嵌套），再在会话锁内标 failed。
 *
 * 预算回退在回调里按**实际翻掉的那几条**累加，不用锁外快照的总额——并发结算时快照可能
 * 已经被另一次结算处理过，按快照减会把 `spentCny` 减两次。
 */
async function settleStaleThinking(ownerId: string, session: AgentSession): Promise<AgentSession> {
  const stale = staleThinkingTurns(session);
  if (!stale.length) return session;
  for (const t of stale) {
    await refundTurn(ownerId, t.priceCny, t.chargeRef);
  }
  const refs = new Set(stale.map((t) => `${t.chargeRef}:refund`));
  const settled = await updateSession(ownerId, session.id, (s) => {
    let back = 0;
    const turns = (s.turns ?? []).map((t) => {
      if (!refs.has(`${t.chargeRef}:refund`) || t.status !== "thinking") return t;
      back = round2(back + t.priceCny);
      return {
        ...t,
        status: "failed" as const,
        refundRef: `${t.chargeRef}:refund`,
        error: { code: "stale", message: "请求中断，本轮费用已退回" },
        updatedAt: new Date().toISOString(),
      };
    });
    if (back <= 0) return { ...s, turns };
    return {
      ...s,
      turns,
      ...(s.budget
        ? { budget: { ...s.budget, spentCny: Math.max(0, round2(s.budget.spentCny - back)) } }
        : {}),
    };
  });
  return settled ?? session;
}

/**
 * 卡住的 `executing`：**不退款、不标 failed**，改回 `awaiting_approval`，让界面重新显示
 * 批准按钮。
 *
 * 不退款是因为对话已经交付（口径与「驳回不退轮次费」一致）；不标 failed 是因为提案还在，
 * 用户重新批准即可，而续建由幂等键 `agent:<turnId>:<i>` 兜住——已经建成的那几条不会重复计费。
 * 提案顺带续一个新的 30 分钟窗口：它上一次是被批准过的，不该因为我们自己崩了就过期。
 */
async function reviveStaleExecuting(ownerId: string, session: AgentSession): Promise<AgentSession> {
  const stuck = staleExecutingTurns(session);
  if (!stuck.length) return session;
  const ids = new Set(stuck.map((t) => t.id));
  const next = await updateSession(ownerId, session.id, (s) => {
    // 锁内按同一判据重判：拿到锁之前那几条可能已经自己走完了。
    const hit = staleExecutingTurns(s).filter((t) => ids.has(t.id));
    if (!hit.length) return undefined;
    const revive = new Set(hit.map((t) => t.id));
    return {
      ...s,
      turns: (s.turns ?? []).map((t) =>
        revive.has(t.id) && t.proposal
          ? {
              ...t,
              status: "awaiting_approval" as const,
              proposal: {
                ...t.proposal,
                expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
              },
              updatedAt: new Date().toISOString(),
            }
          : t,
      ),
    };
  });
  if (next) {
    log("info", "智能体轮次从 executing 复活为待批准", {
      ownerId,
      sessionId: session.id,
      turns: [...ids].length,
    });
  }
  return next ?? session;
}

/**
 * 惰性结算入口（会话详情与读单轮都走它）：先收 `thinking`，再救 `executing`。
 */
export async function settleStaleTurns(ownerId: string, session: AgentSession): Promise<AgentSession> {
  return reviveStaleExecuting(ownerId, await settleStaleThinking(ownerId, session));
}

export type AgentSweepResult = {
  /** 退款并标 failed 的 thinking 轮次数。 */
  settled: number;
  /** 改回待批准的 executing 轮次数。 */
  revived: number;
  /** 读或写失败的会话数；每个只记 warn，不中断整轮。 */
  failed: number;
};

async function ownerIds(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && USER_ID_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 全量扫一遍会话，把卡住的轮次结掉。runner 的每小时维护调它——惰性结算只在有人打开会话时
 * 才发生，而「再也不打开的那个会话」正是钱会一直挂着的地方（review 2026-09-15 B-09）。
 *
 * 归档与否不影响：已归档的会话里同样可能挂着一笔没退的钱。
 */
export async function sweepAgentTurns(): Promise<AgentSweepResult> {
  const result: AgentSweepResult = { settled: 0, revived: 0, failed: 0 };
  for (const ownerId of await ownerIds(agentDir())) {
    for (const name of await namesIn(agentUserDir(ownerId))) {
      const sessionId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!AGENT_SESSION_ID_RE.test(sessionId)) continue;
      try {
        const session = await readSession(ownerId, sessionId);
        if (!session) continue;
        const thinking = staleThinkingTurns(session).length;
        const executing = staleExecutingTurns(session).length;
        if (!thinking && !executing) continue;
        await settleStaleTurns(ownerId, session);
        result.settled += thinking;
        result.revived += executing;
      } catch (error) {
        result.failed += 1;
        log("warn", "智能体轮次扫描失败", {
          ownerId,
          sessionId,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (result.settled || result.revived) {
    log("info", "智能体轮次扫描", result);
  }
  return result;
}
