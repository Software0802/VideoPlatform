import { rm } from "node:fs/promises";
import { removeFromJobIndex } from "@/lib/jobs/index";
import { cleanupJobArtifacts } from "@/lib/jobs/local-output";
import { isTerminalStatus, type JobRecord } from "@/lib/jobs/schema";
import { readJob, tmpDir, withJobLock } from "@/lib/jobs/store";
import { ProviderHttpError } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";

/**
 * 用户主动删除一条作品（方案 §1.4）。与留存清理（`retention.ts`）是两件事：那条只删
 * 产物、留下记录与 `artifactsPurgedAt`，好让界面还能显示「已清理」；这条是用户说
 * 「我不要了」，整个 `data/jobs/<id>/` 连同 `job.json` 一起消失，之后所有路由对这个
 * id 一律 404。
 *
 * 钱不退：`data/ledger/<user>.jsonl` 完全不动。删除的是作品，不是那次已经发生的上游
 * 调用——让删除能退款，等于给「生成完就删」开了一条免费通道。
 *
 * 只删终态任务，而且这件事在**锁内**再判一次（见 `deleteJobById`）：进行中的任务另一端
 * 正有 runner 拿着锁写 `job.json` 与 `outputs/`，删了目录只会让它在写盘时炸掉，还留下
 * 半个目录。
 */
export async function deleteJobDirectory(rec: JobRecord): Promise<void> {
  await deleteJobById(rec.id);
}

/**
 * 删除的唯一实现，整段跑在这条任务的写锁里（`store.withJobLock`，与 `writeJob` /
 * `updateJob` 同一把）。
 *
 * 锁是这条路径上的正确性前提，不只是防撞车：`updateJob` 的临界区是「读 job.json → 写盘
 * → 更索引」，写盘那步带 `mkdir(recursive)`。不加锁时 `rm` 落在它的读与写之间，目录会
 * 被 `mkdir` + 原子替换整个复活出来——只剩一份 job.json 的僵尸任务，产物没了、索引也
 * 已经摘掉，界面上永远是一条打不开的记录。
 *
 * 状态在锁内重新 `readJob` 复核，不信路由传进来的那份快照：HTTP 层读记录、判终态、再调
 * 到这里，中间任务完全可能被 `POST /api/jobs/:id/retry` 推回非终态（路由的检查因此只是
 * 快速失败，真正的判定在这里）。复核不过就抛 409 `job_active`，与路由同一个错误码。
 *
 * 记录已经不在了（并发的另一条 DELETE 先落刀，或目录被手工删过）时静默走完：删除是幂等
 * 的，剩下的活是把 `data/tmp/` 的孤儿文件和索引条目清干净。可见性校验（`readJobForUser`）
 * 由调用方在前面做过。
 */
export async function deleteJobById(id: string): Promise<void> {
  await withJobLock(id, async () => {
    const rec = await readJob(id);
    if (rec && !isTerminalStatus(rec.status)) {
      throw new ProviderHttpError(409, "job_active", "任务进行中，请先取消再删除");
    }
    // `jobDir` 里的 `assertSafeId` 是这条路径上的护栏：id 只能是 `[A-Za-z0-9_-]+`，
    // 所以下面的 `rm -r` 永远落在 `data/jobs/` 里的一个目录上。
    const dir = mediaStore.jobDir(id);
    // 先清 `data/tmp/` 下那两个以 jobId 命名的暂存文件——它们在任务目录之外，
    // 只删目录会把它们留成孤儿。
    await cleanupJobArtifacts(dir, tmpDir(), id, rec?.localOutputPath);
    // `rm` 按 lstat 递归：路径上真有软链时删的是链接本身，不会跟着它出去（与
    // `retention.ts` 的 `purgeJobArtifacts` 同一套语义）。maxRetries 是 Windows 的
    // 老问题——刚被媒体路由读过的 video.mp4 可能还占着句柄，EBUSY 要给它几百毫秒。
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    // 索引是派生缓存，事实源（目录）先没，索引后跟——与 `store.ts` 的写序同一条纪律。
    // 崩在两步之间只会留一条指向空目录的索引项，`listJobIndex` 下次对目录时自己重建。
    await removeFromJobIndex(id);
  });
}
