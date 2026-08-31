import { EventEmitter } from "node:events";
import type { JobPublic } from "@/lib/jobs/schema";

type Bus = EventEmitter & { _lumen?: true };

function bus(): Bus {
  const g = globalThis as typeof globalThis & { __lumenBus?: Bus };
  if (!g.__lumenBus) {
    g.__lumenBus = new EventEmitter();
    g.__lumenBus.setMaxListeners(200);
  }
  return g.__lumenBus;
}

export function emitJob(job: JobPublic, extra?: { type?: string }) {
  bus().emit(`job:${job.id}`, { type: extra?.type ?? "snapshot", job });
}

export function onJob(id: string, fn: (ev: { type: string; job: JobPublic }) => void) {
  const b = bus();
  const key = `job:${id}`;
  b.on(key, fn);
  return () => b.off(key, fn);
}
