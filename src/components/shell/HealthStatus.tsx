"use client";

import { useEffect, useState } from "react";

type HealthState = "checking" | "ok" | "error";

/** Small, non-blocking health readout for the studio chrome. */
export function HealthStatus({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [state, setState] = useState<HealthState>("checking");

  useEffect(() => {
    let stopped = false;
    let notifiedUnauthorized = false;
    const controller = new AbortController();
    async function check() {
      try {
        const response = await fetch("/api/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!notifiedUnauthorized) {
            notifiedUnauthorized = true;
            onUnauthorized?.();
          }
          if (!stopped) setState("error");
          return;
        }
        notifiedUnauthorized = false;
        if (!stopped) setState(response.ok ? "ok" : "error");
      } catch {
        if (!stopped) setState("error");
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [onUnauthorized]);

  const label = state === "ok" ? "服务正常" : state === "checking" ? "检查中" : "服务异常";
  return (
    <span
      className={`health-status health-status--${state}`}
      role="status"
      aria-label={`健康状态：${label}`}
      title={label}
    >
      <span className="health-status__dot" aria-hidden="true" />
      <span className="hidden sm:inline">健康</span>
    </span>
  );
}
