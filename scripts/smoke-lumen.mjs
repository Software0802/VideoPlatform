#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const valueFor = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const baseUrl = (valueFor("--base-url") ?? process.env.LUMEN_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const requireLive = args.has("--require-live");
const requireMock = args.has("--require-mock");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15 * 60 * 1000);
const pollMs = Number(process.env.SMOKE_POLL_MS ?? 1000);
const authToken = process.env.LUMEN_ACCESS_TOKEN;
const results = [];

function requestHeaders(extra = {}) {
  return {
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...extra,
  };
}

async function jsonRequest(route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: requestHeaders(init.headers),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.raw ?? `HTTP ${response.status}`;
    throw new Error(`${init.method ?? "GET"} ${route}: ${message}`);
  }
  return body;
}

async function upload(bytes, role, filename, mimeType) {
  const form = new FormData();
  form.set("role", role);
  form.set("file", new Blob([bytes], { type: mimeType }), filename);
  return jsonRequest("/api/uploads", { method: "POST", body: form });
}

async function createJob(body) {
  const job = await jsonRequest("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const completed = await waitForJob(job.id);
  results.push({
    id: completed.id,
    mode: completed.mode,
    status: completed.status,
    costUsdEstimate: completed.costUsdEstimate,
    costUsdActual: completed.costUsdActual,
    output: completed.output,
  });
  if (completed.status !== "succeeded" || !completed.output) {
    throw new Error(`${completed.mode} ${completed.id} 未成功: ${completed.error?.message ?? completed.status}`);
  }
  return completed;
}

async function waitForJob(id) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await jsonRequest(`/api/jobs/${encodeURIComponent(id)}`);
    if (["succeeded", "failed", "expired", "canceled"].includes(last.status)) return last;
    await sleep(pollMs);
  }
  throw new Error(`任务 ${id} 超过 ${Math.round(timeoutMs / 1000)} 秒仍未结束（最后状态 ${last?.status ?? "unknown"}）`);
}

async function mediaBytes(url) {
  const response = await fetch(`${baseUrl}${url}`, {
    headers: requestHeaders(),
  });
  if (!response.ok) throw new Error(`读取媒体 ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function assertRange(url) {
  const response = await fetch(`${baseUrl}${url}`, {
    headers: requestHeaders({ Range: "bytes=0-1" }),
  });
  if (response.status !== 206) throw new Error(`Range ${url}: 期望 206，得到 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== 2) throw new Error(`Range ${url}: 期望 2 字节，得到 ${bytes.length}`);
  const contentRange = response.headers.get("content-range") ?? "";
  if (!/^bytes 0-1\/\d+$/.test(contentRange)) {
    throw new Error(`Range ${url}: Content-Range 异常 ${contentRange}`);
  }
}

async function run() {
  const health = await jsonRequest("/api/health");
  if (requireLive && health.mockMode) throw new Error("要求 live，但服务仍处于 mock 模式");
  if (requireMock && !health.mockMode) throw new Error("要求 mock，但服务已连接上游");
  if (!health.ok) throw new Error("健康检查未通过");

  const t2v = await createJob({
    mode: "text_to_video",
    prompt: "夜雨中的老电影院，暖色钨丝灯，镜头缓慢推进",
    durationSec: 3,
    aspectRatio: "16:9",
    resolution: "480p",
    generateAudio: false,
  });
  if (t2v.output.kind !== "video") throw new Error("T2V 未返回视频输出");
  await assertRange(t2v.output.videoUrl);

  const poster = await mediaBytes(t2v.output.posterUrl);
  const start = await upload(poster, "start", "start.jpg", "image/jpeg");
  const i2v = await createJob({
    mode: "image_to_video",
    prompt: "镜头继续缓慢推进，雨滴在灯光中闪烁",
    durationSec: 3,
    aspectRatio: "16:9",
    resolution: "480p",
    generateAudio: false,
    startUploadId: start.uploadId,
  });
  if (i2v.output.kind !== "video") throw new Error("I2V 未返回视频输出");

  const i2vPoster = await mediaBytes(i2v.output.posterUrl);
  const ref1 = await upload(i2vPoster, "reference", "ref-1.jpg", "image/jpeg");
  const r2v = await createJob({
    mode: "reference_to_video",
    prompt: "保持同一角色与色调，穿过雨夜街道",
    durationSec: 3,
    aspectRatio: "16:9",
    resolution: "480p",
    generateAudio: false,
    referenceUploadIds: [ref1.uploadId],
  });
  if (r2v.output.kind !== "video") throw new Error("R2V 未返回视频输出");

  const sourceBytes = await mediaBytes(t2v.output.videoUrl);
  const sourceForExtend = await upload(sourceBytes, "source_video", "source.mp4", "video/mp4");
  const extended = await createJob({
    mode: "extend_video",
    prompt: "继续向前移动，保持画面连续",
    durationSec: 2,
    sourceVideoUploadId: sourceForExtend.uploadId,
  });
  if (extended.output.kind !== "video") throw new Error("Extend 未返回视频输出");

  const sourceForEdit = await upload(sourceBytes, "source_video", "source-edit.mp4", "video/mp4");
  const edited = await createJob({
    mode: "edit_video",
    prompt: "加入轻微胶片颗粒与暖色调",
    sourceVideoUploadId: sourceForEdit.uploadId,
  });
  if (edited.output.kind !== "video") throw new Error("Edit 未返回视频输出");

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    mode: health.mockMode ? "mock" : "live",
    upstream: health.grokUpstream?.kind ?? null,
    jobs: results,
  }, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
