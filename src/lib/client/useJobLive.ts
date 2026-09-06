"use client";

import { useEffect } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { isTerminal } from "@/lib/client/labels";
import { fetchJob } from "./jobs";

/**
 * 两条通道的间隔（方案 §3.3「轮询」）。
 *
 * SSE 一次都没送到过时按 `POLL_FAST_MS` 轮询——那时轮询是唯一的通道。一旦收到过事件，
 * 说明这条连接是通的，轮询退到 `POLL_SLOW_MS` 只当兜底；连接一断（`onerror`）立刻回到
 * 快档。「轮询是真相」没有变，变的只是在 SSE 健康时少问几遍：一条 5 分钟的任务从 150 次
 * 请求降到 30 次左右，而用户看到的进度仍然由 SSE 实时推着走。
 */
const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 10_000;

/**
 * Keeps one job fresh until it reaches a terminal state.
 * SSE gives fast feedback; polling is the source of truth and the
 * reconnect fallback (see docs/design.md §3).
 */
export function useJobLive(job: Pick<JobPublic, "id" | "status">, onUpdate: (job: JobPublic) => void) {
  const { id } = job;
  // Only re-subscribe when the job flips to terminal, not on every status hop.
  const terminal = isTerminal(job.status);
  useEffect(() => {
    if (terminal) return;
    let stopped = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let events: EventSource | undefined;
    let pollMs = POLL_FAST_MS;

    const stop = () => {
      finished = true;
      if (timer) clearTimeout(timer);
      events?.close();
    };
    const apply = (data: JobPublic) => {
      if (stopped || (finished && !isTerminal(data.status))) return;
      onUpdate(data);
      if (isTerminal(data.status)) stop();
    };
    const tick = async () => {
      if (stopped || finished) return;
      try {
        const data = await fetchJob(id);
        if (data) apply(data);
      } catch {
        // A 401 already sent the browser to /login; anything else is transient.
      }
      if (!stopped && !finished) timer = setTimeout(tick, pollMs);
    };

    if (typeof EventSource !== "undefined") {
      try {
        events = new EventSource(`/api/jobs/${id}/events`);
        const onEvent = (event: Event) => {
          // 收到过事件 = 这条 SSE 是通的，轮询退到慢档当兜底。
          pollMs = POLL_SLOW_MS;
          try {
            apply(JSON.parse((event as MessageEvent<string>).data) as JobPublic);
          } catch {
            // Ignore malformed events; polling still runs.
          }
        };
        events.addEventListener("snapshot", onEvent);
        events.addEventListener("status", onEvent);
        events.addEventListener("error", () => {
          // 连接断了（或从未建起来）：立刻回到快档，并把已经排上的那次慢等待提前。
          // EventSource 自己会重连，但在它重连成功之前，轮询是唯一还在动的通道。
          if (pollMs === POLL_FAST_MS) return;
          pollMs = POLL_FAST_MS;
          if (stopped || finished) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(tick, pollMs);
        });
      } catch {
        events = undefined;
      }
    }
    timer = setTimeout(tick, 400);
    return () => {
      stopped = true;
      stop();
    };
  }, [id, terminal, onUpdate]);
}
