#!/usr/bin/env node
// @ts-check

import { loginForSmoke } from "./lib/smoke-session.mjs";

const args = new Set(process.argv.slice(2));
/** @param {string} name */
const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
// `localhost`, not 127.0.0.1: Next 16 dev answers 403 to the latter (AGENTS.md).
const baseUrl = (valueFor("--base-url") ?? process.env.LUMEN_URL ?? "http://localhost:3000").replace(/\/$/, "");
const delayMs = Number(process.env.SMOKE_CANCEL_DELAY_MS ?? 100);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);
/** `lumen_session=…`, obtained in run() before the first API call. */
let sessionCookie = "";

/** @param {Record<string, string>} [extra] */
const headers = (extra = {}) => /** @type {Record<string, string>} */ ({
  ...(sessionCookie ? { Cookie: sessionCookie } : {}),
  ...extra,
});

/**
 * @param {string} route
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function json(route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: headers(/** @type {Record<string, string> | undefined} */ (init.headers)),
  });
  const text = await response.text();
  /** @type {any} */
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${route}: ${body?.error?.message ?? response.status}`);
  return body;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  sessionCookie = await loginForSmoke(baseUrl);
  const health = await json("/api/health");
  if (!health.ok) throw new Error("健康检查未通过");
  if (!health.mockMode && !args.has("--allow-live")) {
    throw new Error("取消 smoke 默认只允许 mock；如确认真实 live，请显式传 --allow-live");
  }
  const created = await json("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "text_to_video",
      prompt: "cancel-safe fixture",
      durationSec: 8,
      aspectRatio: "16:9",
      resolution: "480p",
      generateAudio: false,
    }),
  });
  await sleep(delayMs);
  const canceled = await json(`/api/jobs/${encodeURIComponent(created.id)}/cancel`, { method: "POST" });
  if (canceled.status !== "canceled") throw new Error(`取消接口返回 ${canceled.status}`);

  const started = Date.now();
  let final = canceled;
  while (Date.now() - started < timeoutMs) {
    final = await json(`/api/jobs/${encodeURIComponent(created.id)}`);
    if (["succeeded", "failed", "expired", "canceled"].includes(final.status)) break;
    await sleep(100);
  }
  if (final.status !== "canceled" || final.error?.code !== "canceled") {
    throw new Error(`任务未保持 canceled: ${final.status}/${final.error?.code ?? "none"}`);
  }
  const media = await fetch(`${baseUrl}/api/media/${encodeURIComponent(created.id)}/video.mp4`, {
    headers: headers(),
  });
  if (media.status !== 404) throw new Error(`取消任务媒体应为 404，得到 ${media.status}`);
  console.log(JSON.stringify({ ok: true, id: created.id, status: final.status, mediaStatus: media.status }, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(`cancel smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
