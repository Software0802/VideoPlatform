"use client";

import { useEffect } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { isTerminal } from "@/lib/client/labels";
import { fetchJob } from "./jobs";

/**
 * Keeps one job fresh until it reaches a terminal state.
 * SSE gives fast feedback; 2s polling is the source of truth and the
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
      if (!stopped && !finished) timer = setTimeout(tick, 2000);
    };

    if (typeof EventSource !== "undefined") {
      try {
        events = new EventSource(`/api/jobs/${id}/events`);
        const onEvent = (event: Event) => {
          try {
            apply(JSON.parse((event as MessageEvent<string>).data) as JobPublic);
          } catch {
            // Ignore malformed events; polling still runs.
          }
        };
        events.addEventListener("snapshot", onEvent);
        events.addEventListener("status", onEvent);
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
