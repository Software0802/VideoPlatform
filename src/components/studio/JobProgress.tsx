"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";

const STAGES = ["排队", "提交", "生成", "落盘", "完成"] as const;

function stageIndex(s: JobPublic["status"]): number {
  switch (s) {
    case "queued":
      return 0;
    case "submitting":
    case "directing":
    case "keyframing":
      return 1;
    case "pending":
    case "generating_shots":
    case "qc":
      return 2;
    case "persisting":
    case "stitching":
      return 3;
    case "succeeded":
      return 4;
    default:
      return -1;
  }
}

function statusLabel(s: JobPublic["status"]) {
  const map: Record<JobPublic["status"], string> = {
    queued: "排队中",
    submitting: "提交 Grok",
    pending: "生成中",
    persisting: "落盘",
    directing: "导演分镜",
    keyframing: "锁帧",
    generating_shots: "生成分镜",
    qc: "质检",
    stitching: "拼接",
    succeeded: "完成",
    failed: "失败",
    expired: "已过期",
    canceled: "已取消",
  };
  return map[s];
}

function elapsed(from: string, now: number | null): string {
  if (now == null) return "00:00";
  const sec = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function JobProgress({
  initial,
  onUpdate,
  onUnauthorized,
  onRetried,
}: {
  initial: JobPublic;
  onUpdate?: (job: JobPublic) => void;
  onUnauthorized?: () => void;
  onRetried?: (job: JobPublic) => void;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [canceling, setCanceling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setClock] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerStart: ReturnType<typeof setTimeout> | undefined;
    let events: EventSource | undefined;
    const terminal = (status: JobPublic["status"]) =>
      ["succeeded", "failed", "expired", "canceled"].includes(status);
    let finished = terminal(initial.status);
    const stopLiveUpdates = () => {
      finished = true;
      if (timer) clearTimeout(timer);
      if (timerStart) clearTimeout(timerStart);
      events?.close();
    };
    const apply = (data: JobPublic) => {
      if (stopped || finished && !terminal(data.status)) return;
      setJob(data);
      onUpdate?.(data);
      if (terminal(data.status)) {
        stopLiveUpdates();
      }
    };
    const tick = async () => {
      if (stopped || finished) return;
      try {
        const res = await fetch(`/api/jobs/${initial.id}`, { cache: "no-store" });
        if (res.ok) {
          apply((await res.json()) as JobPublic);
        } else if (res.status === 401) {
          onUnauthorized?.();
          setActionError("需要访问令牌，请先在本机完成鉴权。");
        }
      } catch {
        // SSE/轮询都可能暂时断开，下一轮继续尝试。
      }
      if (!stopped && !finished) timer = setTimeout(tick, 2000);
    };

    // SSE 用于及时反馈，轮询作为真相与断线兜底（设计书约定）。
    if (typeof EventSource !== "undefined" && !terminal(initial.status)) {
      try {
        events = new EventSource(`/api/jobs/${initial.id}/events`);
        const onEvent = (event: Event) => {
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as JobPublic;
            apply(data);
          } catch {
            // 忽略无效事件，让轮询继续工作。
          }
        };
        events.addEventListener("snapshot", onEvent);
        events.addEventListener("status", onEvent);
        events.onerror = () => {
          // 浏览器会自动重连；若服务端已关闭，轮询仍会接管。
        };
      } catch {
        events = undefined;
      }
    }
    if (!finished) timerStart = setTimeout(tick, 400);
    return () => {
      stopped = true;
      stopLiveUpdates();
    };
  }, [initial.id, initial.status, onUpdate, onUnauthorized]);

  useEffect(() => {
    const firstTick = window.setTimeout(() => setClock(Date.now()), 0);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => {
      window.clearTimeout(firstTick);
      window.clearInterval(timer);
    };
  }, []);

  const idx = stageIndex(job.status);
  const succeeded = job.status === "succeeded";
  const terminal = succeeded || ["failed", "expired", "canceled"].includes(job.status);
  const failed = ["failed", "expired", "canceled"].includes(job.status);
  const active = idx >= 0 && idx < 4;

  async function cancel() {
    setCanceling(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      if (res.status === 401) {
        onUnauthorized?.();
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? "取消失败");
      }
      applyLocal((await res.json()) as JobPublic);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "取消失败");
    } finally {
      setCanceling(false);
    }
  }

  async function retry() {
    setRetrying(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/retry`, { method: "POST" });
      if (res.status === 401) {
        onUnauthorized?.();
      }
      const data = (await res.json().catch(() => null)) as
        | JobPublic
        | { error?: { message?: string } }
        | null;
      if (!res.ok) {
        throw new Error(
          data && "error" in data && data.error?.message ? data.error.message : "重试失败",
        );
      }
      const next = data as JobPublic;
      if (onRetried) onRetried(next);
      else router.push(`/jobs/${next.id}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "重试失败");
    } finally {
      setRetrying(false);
    }
  }

  function applyLocal(next: JobPublic) {
    setJob(next);
    onUpdate?.(next);
  }

  return (
    <div
      className="monitor-panel space-y-5 p-5"
      data-active={active}
      data-status={job.status}
      aria-busy={active}
    >
      {/* 状态头 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="readout text-accent/65">当前任务</p>
          <p className="mt-2 flex items-center gap-2.5 text-sm font-medium" role="status" aria-live="polite">
            <span
              className={`inline-block size-2 rounded-full ${
                active
                  ? "animate-pulse-dot bg-accent"
                  : succeeded
                    ? "bg-ok"
                    : failed
                      ? "bg-danger"
                      : "bg-muted"
              }`}
            />
            {statusLabel(job.status)}
            <span className="font-mono text-xs tracking-wider text-muted">
              {job.progress}%
            </span>
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] tracking-[0.12em] text-faint">{job.id.slice(-8).toUpperCase()}</p>
          <p className="mt-2 flex items-center justify-end gap-3 font-mono text-[11px] tracking-[0.1em] text-muted">
            <span>{elapsed(job.createdAt, now)}</span>
            {active ? (
              <button
                type="button"
                onClick={cancel}
                disabled={canceling}
                className="inline-flex min-h-11 items-center text-faint underline-offset-4 transition-colors hover:text-danger hover:underline disabled:opacity-50"
              >
                {canceling ? "取消中…" : "取消"}
              </button>
            ) : failed ? (
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="inline-flex min-h-11 items-center text-accent underline-offset-4 transition-colors hover:text-accent-strong hover:underline disabled:opacity-50"
              >
                {retrying ? "重试中…" : "重试"}
              </button>
            ) : null}
          </p>
        </div>
      </div>

      {/* 阶段时间线 */}
      <ol className="flex items-center" aria-label="任务阶段">
        {STAGES.map((label, i) => {
          const reached = idx >= i;
          const current = idx === i && active;
          return (
            <li key={label} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <span
                  className={`block size-2 rounded-full border transition-colors duration-300 ${
                    current
                      ? "animate-pulse-dot border-accent bg-accent"
                      : reached
                        ? "border-accent bg-accent"
                        : terminal
                          ? "border-line-strong bg-transparent"
                          : "border-line-strong bg-transparent"
                  }`}
                />
                <span
                  className={`font-mono text-[9px] tracking-[0.12em] ${
                    reached ? "text-dim" : "text-faint"
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < STAGES.length - 1 ? (
                <div
                  className={`mx-1.5 mb-4 h-px flex-1 transition-colors duration-300 ${
                    idx > i ? "bg-accent/60" : "bg-line"
                  }`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* 进度条 */}
      <div className="monitor-progress">
        <div
          className={`relative z-[1] h-full rounded-full transition-[width] duration-500 ease-expo ${
            failed ? "bg-danger" : succeeded ? "bg-ok" : "bg-accent"
          }`}
          style={{
            width: `${job.progress}%`,
            boxShadow: failed || succeeded ? "none" : "0 0 12px oklch(0.79 0.105 78 / 55%)",
          }}
        />
      </div>

      {job.error ? (
        <p
          role="alert"
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger"
        >
          {job.error.message}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
          {actionError}
        </p>
      ) : null}

      {/* 成片 */}
      {job.output?.kind === "image" ? (
        <div className="media-frame">
          <Image
            className="block w-full bg-black"
            src={job.output.imageUrl}
            alt={job.prompt || "生成图像"}
            loading="eager"
            decoding="async"
            unoptimized
            width={mediaDimensions(job, "image").width}
            height={mediaDimensions(job, "image").height}
            sizes="(max-width: 1280px) 100vw, 55vw"
          />
          <span className="absolute bottom-3 left-3 z-[1] font-mono text-[10px] tracking-[0.12em] text-dim">静帧 / {job.imageResolution?.toUpperCase() ?? "1K"}</span>
        </div>
      ) : job.output?.kind === "video" ? (
        <div className="media-frame">
          <video
            className="block w-full bg-black"
            src={job.output.videoUrl}
            poster={job.output.posterUrl}
            controls
            preload="metadata"
          />
          <span className="absolute bottom-3 left-3 z-[1] font-mono text-[10px] tracking-[0.12em] text-dim">成片 / {job.output.durationSec}s</span>
        </div>
      ) : null}
    </div>
  );
}

const ASPECT_DIMENSIONS: Record<NonNullable<JobPublic["aspectRatio"]>, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "4:3": { width: 1280, height: 960 },
  "3:4": { width: 960, height: 1280 },
  "3:2": { width: 1280, height: 854 },
  "2:3": { width: 854, height: 1280 },
};

function mediaDimensions(job: JobPublic, kind: "image" | "video") {
  if (job.aspectRatio) return ASPECT_DIMENSIONS[job.aspectRatio];
  return kind === "image" ? { width: 1024, height: 1024 } : ASPECT_DIMENSIONS["16:9"];
}
