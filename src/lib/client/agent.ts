import type { JobPublic } from "@/lib/jobs/schema";
import type { Locale } from "@/lib/i18n/locales";
import { parseAuthed } from "@/lib/client/http";

/**
 * `/api/agent/*` 的浏览器侧读取口（方案 §1）。组件不直接 `fetch`，与 `jobs.ts` /
 * `auth.ts` 同一条纪律。
 *
 * 类型是服务端形状的**镜像**（客户端包不去 import 服务端模块），所以每个返回值都过一遍
 * 结构化读取：认得的字段取出来，认不得的丢掉，形状不对的整条剔除。理由与 `models.ts`
 * 的 `readProduct` 相同——只信检查过的值，而不是相信服务端这一版和这一版前端同时上线。
 */

export type AgentTier = "fast" | "balanced" | "quality";
export const AGENT_TIERS: readonly AgentTier[] = ["fast", "balanced", "quality"];

export type AgentJobRef = { jobId?: string; kind: "image" | "video"; prompt: string; error?: string };

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  skillId?: string;
  jobs?: AgentJobRef[];
  priceCny?: number;
  at: string;
};

export type AgentSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  skillId?: string;
};

export type AgentSessionDetail = AgentSessionSummary & {
  tier?: AgentTier;
  imageProduct?: string;
  videoProduct?: string;
  messages: AgentMessage[];
  jobs: JobPublic[];
};

export type AgentSkill = {
  id: string;
  name: Record<Locale, string>;
  desc: Record<Locale, string>;
  group: "core" | "ecommerce";
};

export type AgentTurnBody = {
  text: string;
  skillId?: string;
  tier?: AgentTier;
  imageProduct?: string;
  videoProduct?: string;
  /**
   * 一轮对话的稳定身份（R08）：一次逻辑发送生成一个，网络层重试时原样带上，
   * 服务端按它幂等——重放不会扣第二次钱、不会多出半轮对话。
   */
  turnId?: string;
};

/** 一轮对话的幂等键，`msg_` + 16 位十六进制，与服务端 `AGENT_MESSAGE_ID_RE` 同形。 */
export function newAgentTurnId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `msg_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const optStr = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

function readTier(value: unknown): AgentTier | undefined {
  return AGENT_TIERS.find((t) => t === value);
}

function readLocalized(value: unknown): Record<Locale, string> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const zh = str(v["zh-CN"]);
  const en = str(v.en);
  if (!zh) return null;
  // 英文缺失时回落中文：少一条翻译不该让技能从广场上消失。
  return { "zh-CN": zh, en: en || zh };
}

function readSkill(raw: unknown): AgentSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = str(s.id);
  const name = readLocalized(s.name);
  const desc = readLocalized(s.desc);
  if (!id || !name || !desc) return null;
  return { id, name, desc, group: s.group === "ecommerce" ? "ecommerce" : "core" };
}

function readJobRef(raw: unknown): AgentJobRef | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const kind = j.kind === "image" ? "image" : j.kind === "video" ? "video" : null;
  if (!kind) return null;
  return {
    kind,
    prompt: str(j.prompt),
    ...(optStr(j.jobId) ? { jobId: str(j.jobId) } : {}),
    ...(optStr(j.error) ? { error: str(j.error) } : {}),
  };
}

function readMessage(raw: unknown): AgentMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id);
  const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null;
  if (!id || !role) return null;
  const jobs = Array.isArray(m.jobs)
    ? m.jobs.map(readJobRef).filter((j): j is AgentJobRef => j !== null)
    : [];
  return {
    id,
    role,
    text: str(m.text),
    at: str(m.at),
    ...(optStr(m.skillId) ? { skillId: str(m.skillId) } : {}),
    ...(jobs.length ? { jobs } : {}),
    ...(typeof m.priceCny === "number" && Number.isFinite(m.priceCny) ? { priceCny: m.priceCny } : {}),
  };
}

function readSummary(raw: unknown): AgentSessionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = str(s.id);
  if (!id) return null;
  return {
    id,
    title: str(s.title) || id,
    createdAt: str(s.createdAt),
    updatedAt: str(s.updatedAt),
    ...(optStr(s.skillId) ? { skillId: str(s.skillId) } : {}),
  };
}

function readDetail(raw: unknown): AgentSessionDetail {
  const base = readSummary(raw);
  if (!base) throw new Error("服务端返回的会话形状无法识别");
  const s = raw as Record<string, unknown>;
  return {
    ...base,
    ...(readTier(s.tier) ? { tier: readTier(s.tier) } : {}),
    ...(optStr(s.imageProduct) ? { imageProduct: str(s.imageProduct) } : {}),
    ...(optStr(s.videoProduct) ? { videoProduct: str(s.videoProduct) } : {}),
    messages: Array.isArray(s.messages)
      ? s.messages.map(readMessage).filter((m): m is AgentMessage => m !== null)
      : [],
    // 任务用的是任务自己的公开投影，形状由 `jobs/schema.ts` 保证，这里只做数组兜底。
    jobs: Array.isArray(s.jobs) ? (s.jobs as JobPublic[]) : [],
  };
}

/**
 * 技能表 + 「这台实例的智能体能不能用」。
 *
 * `available` 缺失（老服务端）时按可用处理：少一个字段不该把整个功能锁死，真不可用时
 * 服务端仍然会在提交时回 503。
 */
export async function fetchAgentSkills(): Promise<{ skills: AgentSkill[]; available: boolean }> {
  const res = await fetch("/api/agent/skills", { cache: "no-store" });
  const data = await parseAuthed<{ skills?: unknown; available?: unknown }>(res, "无法读取技能列表");
  const raw = Array.isArray(data.skills) ? data.skills : [];
  return {
    skills: raw.map(readSkill).filter((s): s is AgentSkill => s !== null),
    available: typeof data.available === "boolean" ? data.available : true,
  };
}

export async function fetchAgentSessions(): Promise<AgentSessionSummary[]> {
  const res = await fetch("/api/agent/sessions", { cache: "no-store" });
  const data = await parseAuthed<{ sessions?: unknown }>(res, "无法读取会话列表");
  const raw = Array.isArray(data.sessions) ? data.sessions : [];
  return raw.map(readSummary).filter((s): s is AgentSessionSummary => s !== null);
}

export async function createAgentSession(body: AgentTurnBody): Promise<AgentSessionDetail> {
  const res = await fetch("/api/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseAuthed<{ session?: unknown }>(res, "无法创建会话");
  return readDetail(data.session);
}

export async function fetchAgentSession(id: string): Promise<AgentSessionDetail> {
  const res = await fetch(`/api/agent/sessions/${id}`, { cache: "no-store" });
  const data = await parseAuthed<{ session?: unknown }>(res, "无法读取会话");
  return readDetail(data.session);
}

export async function sendAgentMessage(id: string, body: AgentTurnBody): Promise<AgentSessionDetail> {
  const res = await fetch(`/api/agent/sessions/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseAuthed<{ session?: unknown }>(res, "发送失败");
  return readDetail(data.session);
}

export async function renameAgentSession(id: string, title: string): Promise<AgentSessionDetail> {
  const res = await fetch(`/api/agent/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await parseAuthed<{ session?: unknown }>(res, "重命名失败");
  return readDetail(data.session);
}

export async function deleteAgentSession(id: string): Promise<void> {
  const res = await fetch(`/api/agent/sessions/${id}`, { method: "DELETE" });
  if (res.status === 204) return;
  await parseAuthed<unknown>(res, "删除失败");
}

/** 任务还没跑完（资产栏据此决定要不要继续轮询）。 */
export function isJobPending(job: JobPublic): boolean {
  return job.status !== "succeeded" && job.status !== "failed" && job.status !== "canceled" && job.status !== "expired";
}
