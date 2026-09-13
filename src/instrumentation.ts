export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Fail loudly before serving a single request: a missing session secret must
  // never be papered over with a random or derived key (plan §3).
  const { assertSessionSecret } = await import("./lib/users/session");
  assertSessionSecret();
  // `data/users/index.json` is a derived cache; verify it against the user
  // directories at boot so a crash between the two writes cannot hide an account.
  const { ensureUserIndex } = await import("./lib/users/store");
  await ensureUserIndex();
  // `data/jobs/index.json` 同理（方案 §3.3）：派生索引，事实源是每个任务目录里的
  // job.json。启动时按目录重建一次——之后每一次筛选（首页、配额、余额预留、队列读数、
  // 留存清理）就都不必再全量读盘了。
  const { ensureJobIndex } = await import("./lib/jobs/index");
  await ensureJobIndex();
  await tuneSharp();
  const { initializeCanvasAssets } = await import("./lib/assets/store");
  await initializeCanvasAssets();
  const { startJobRunner } = await import("./lib/jobs/runner");
  await startJobRunner();
  // 画布 DAG 运行的周期泵（D 包）：非终态 run 的节点刷新与续跑全靠它，
  // 重启后自动接管——run 文件是事实源，泵无状态。
  const { startCanvasRunPump } = await import("./lib/canvas/dag");
  startCanvasRunPump();
}

/**
 * Cap libvips' appetite before the first upload arrives (plan §3.3, P1).
 *
 * Out of the box sharp sizes its thread pool to the CPU count and keeps a 50MB
 * decoded-tile cache per process; on a 2-core / 1.8G box under `MemoryMax=700M`
 * that is a resident cost we never get back plus parallel decodes we did not ask
 * for — `JOB_CONCURRENCY` bounds jobs, not uploads.
 *
 * Deliberately non-fatal: a sharp that cannot be loaded should degrade to "uploads
 * fail" the way it always has, not to "the server refuses to boot".
 */
async function tuneSharp() {
  try {
    const sharp = (await import("sharp")).default;
    sharp.concurrency(1);
    sharp.cache(false);
  } catch (error) {
    const { log } = await import("./lib/log");
    log("warn", "sharp tuning skipped", {
      msg: error instanceof Error ? error.message : String(error),
    });
  }
}
