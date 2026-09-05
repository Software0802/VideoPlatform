import path from "node:path";

export const OFFICIAL_XAI_BASE = "https://api.x.ai/v1";
export const DEFAULT_SUB2API_BASE = "http://127.0.0.1:8080/v1";

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
}

export function jobConcurrency(): number {
  const n = Number(process.env.JOB_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

export function maxQueuedJobs(): number {
  const n = Number(process.env.MAX_QUEUED_JOBS ?? 20);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

export function grokApiKey(): string | undefined {
  const official = process.env.XAI_API_KEY?.trim();
  if (official) return official;
  const proxy = process.env.SUB2API_API_KEY?.trim();
  if (proxy) return proxy;
  return undefined;
}

export function hasXaiKey(): boolean {
  return Boolean(grokApiKey());
}

export function forceMock(): boolean {
  const v = process.env.LUMEN_FORCE_MOCK?.trim();
  return v === "1" || v === "true";
}

export function isMockMode(): boolean {
  return forceMock() || !hasXaiKey();
}

export type GrokUpstreamKind = "xai" | "sub2api";

export function grokUpstreamKind(): GrokUpstreamKind {
  if (xaiBase().includes("api.x.ai")) return "xai";
  return "sub2api";
}

/** REST root including `/v1`, no trailing slash. */
export function xaiBase(): string {
  const raw = process.env.XAI_BASE_URL?.trim();
  if (raw) return normalizeXaiBase(raw);
  if (process.env.SUB2API_API_KEY?.trim() && !process.env.XAI_API_KEY?.trim()) {
    return DEFAULT_SUB2API_BASE;
  }
  return OFFICIAL_XAI_BASE;
}

export function normalizeXaiBase(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) return OFFICIAL_XAI_BASE;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}

export function upstreamTimeoutMs(): number {
  const n = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 5 * 60_000) : 30_000;
}

/** M2.4：一致性管线总开关。未开启时 30/45/60 仍由 API 拒绝，orchestrator 恒抛。 */
export function harnessEnabled(): boolean {
  const v = process.env.HARNESS_ENABLED?.trim();
  return v === "1" || v === "true";
}

/** 同一 harness job 内并行生成的 shot 数（默认 2）。 */
export function harnessShotConcurrency(): number {
  const n = Number(process.env.HARNESS_SHOT_CONCURRENCY ?? 2);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 4) : 2;
}

/**
 * grok-4.6 视觉一致性 QC 阈值（0–1）。未设置即跳过视觉打分——阈值需由
 * evals/runs 对照集校准后固定（design.md §7.2 H2），仓库不预设。
 */
export function harnessQcVisualThreshold(): number | null {
  const raw = process.env.HARNESS_QC_VISUAL_THRESHOLD?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function upstreamRetryBaseMs(): number {
  const n = Number(process.env.UPSTREAM_RETRY_BASE_MS ?? 250);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 10_000) : 250;
}
