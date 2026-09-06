import { EventEmitter } from "node:events";
import type { JobPublic } from "@/lib/jobs/schema";

type Bus = EventEmitter & { _lumen?: true };

export type JobEvent = { type: string; job: JobPublic };

/** 全站频道：每条任务事件都会**额外**在这里发一份，见 `onAnyJob`。 */
const ANY_JOB = "job:*";

function bus(): Bus {
  const g = globalThis as typeof globalThis & { __lumenBus?: Bus };
  if (!g.__lumenBus) {
    g.__lumenBus = new EventEmitter();
    g.__lumenBus.setMaxListeners(200);
  }
  return g.__lumenBus;
}

export function emitJob(job: JobPublic, extra?: { type?: string }) {
  const event: JobEvent = { type: extra?.type ?? "snapshot", job };
  bus().emit(`job:${job.id}`, event);
  bus().emit(ANY_JOB, event);
}

export function onJob(id: string, fn: (ev: JobEvent) => void) {
  const b = bus();
  const key = `job:${id}`;
  b.on(key, fn);
  return () => b.off(key, fn);
}

/**
 * 订阅**所有**任务事件（`GET /api/events` 的全局流用）。
 *
 * 没有按 ownerId 分频道，是因为 `JobPublic` 里根本没有 `ownerId`——浏览器不该知道别人
 * 的用户 id，所以公开形状里就没有它，`emitJob` 的十来个调用点（runner / orchestrator /
 * 取消路由）也就没法在发事件时说出这条任务是谁的。过滤因此留给订阅方：`/api/events`
 * 对每个 jobId 用 `readJobForUser` 判一次并在连接内记住结果，一条连接对一条任务最多
 * 读一次盘。
 */
export function onAnyJob(fn: (ev: JobEvent) => void) {
  const b = bus();
  b.on(ANY_JOB, fn);
  return () => b.off(ANY_JOB, fn);
}
