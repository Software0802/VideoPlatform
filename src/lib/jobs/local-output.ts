import { mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";

export function resolveLocalOutput(jobDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("invalid local output path");
  const root = path.resolve(jobDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("invalid local output path");
  }
  return resolved;
}

export async function cleanupJobArtifacts(
  jobDir: string,
  tempDir: string,
  jobId: string,
  stagedPath?: string,
): Promise<void> {
  const jobRelativePaths = [
    "outputs/video.mp4",
    "outputs/poster.jpg",
    "outputs/image.jpg",
    "tmp/still.jpg",
    "tmp/video.mp4",
    "tmp/image.jpg",
    stagedPath,
  ].filter((value): value is string => Boolean(value));
  const jobPaths = jobRelativePaths.flatMap((relativePath) => {
    try {
      return [resolveLocalOutput(jobDir, relativePath)];
    } catch {
      return [];
    }
  });
  const globalPaths = [
    path.join(tempDir, `${jobId}-video.mp4`),
    path.join(tempDir, `${jobId}-image.jpg`),
  ];
  await Promise.all(
    [...jobPaths, ...globalPaths].map((file) => rm(file, { force: true }).catch(() => undefined)),
  );
}

/**
 * Directories the retention sweep empties (plan §8). `outputs/` holds the delivered
 * film or image, `inputs/` the uploaded first frame / references / source video — a
 * retention rule that kept the uploads would free almost nothing on a job that was
 * image-to-video.
 *
 * `job.json` itself is deliberately not touched: the record stays as history and is
 * what carries `artifactsPurgedAt`.
 */
const PURGED_DIRS = ["outputs", "inputs"] as const;

/**
 * Delete one job's artifact directories, keeping the record. Used only by the
 * retention sweep; the paths still go through `resolveLocalOutput` so this cannot
 * become an `rm -rf` on something outside the job directory if a caller ever passes
 * a computed name.
 */
export async function purgeJobArtifacts(
  jobDir: string,
  tempDir: string,
  jobId: string,
): Promise<void> {
  // The per-file cleanup first: it also removes the global staging files under
  // `data/tmp/`, which live outside the job directory.
  await cleanupJobArtifacts(jobDir, tempDir, jobId);
  for (const rel of PURGED_DIRS) {
    await rm(resolveLocalOutput(jobDir, rel), { recursive: true, force: true });
  }
}

export async function commitLocalOutput(
  source: string,
  destination: string,
  isCanceled: () => Promise<boolean>,
): Promise<boolean> {
  if (path.resolve(source) === path.resolve(destination)) {
    return !(await isCanceled());
  }
  if (await isCanceled()) {
    await rm(source, { force: true });
    return false;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const replaced = await replaceWithRetry(source, destination, isCanceled);
  if (!replaced) return false;

  if (await isCanceled()) {
    await rm(destination, { force: true });
    return false;
  }
  return true;
}

/**
 * Replace a staged artifact without exposing a partially-written destination.
 * Windows may keep the old destination open while a media response is being
 * read, so both the unlink and the atomic rename get a short bounded retry.
 */
async function replaceWithRetry(
  source: string,
  destination: string,
  isCanceled: () => Promise<boolean>,
): Promise<boolean> {
  const maxAttempts = 8;
  for (let attempt = 0; ; attempt += 1) {
    if (await isCanceled()) {
      await rm(source, { force: true });
      return false;
    }
    try {
      await rm(destination, { force: true });
      if (await isCanceled()) {
        await rm(source, { force: true });
        return false;
      }
      await rename(source, destination);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EBUSY" || code === "EACCES") || attempt >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 160)));
    }
  }
}
