import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { purgeJobArtifacts } from "./local-output";

/**
 * Retention deletes bytes, never the record. This pins exactly which directories
 * go: outputs, inputs and the harness shots — and that job.json survives.
 */

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function seedJob(): Promise<{ jobDir: string; tmp: string }> {
  root = await mkdtemp(path.join(os.tmpdir(), "lumen-purge-"));
  const jobDir = path.join(root, "jobs", "job_purge01");
  const tmp = path.join(root, "tmp");
  for (const rel of [
    "outputs/video.mp4",
    "outputs/poster.jpg",
    "inputs/start.jpg",
    "shots/shot-0/clip.mp4",
    "shots/shot-1/clip.mp4",
  ]) {
    const abs = path.join(jobDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, rel);
  }
  await mkdir(tmp, { recursive: true });
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({ id: "job_purge01" }));
  return { jobDir, tmp };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("purgeJobArtifacts", () => {
  it("removes outputs, inputs and shots but keeps job.json", async () => {
    const { jobDir, tmp } = await seedJob();

    await purgeJobArtifacts(jobDir, tmp, "job_purge01");

    expect(await exists(path.join(jobDir, "outputs"))).toBe(false);
    expect(await exists(path.join(jobDir, "inputs"))).toBe(false);
    expect(await exists(path.join(jobDir, "shots"))).toBe(false);
    expect(JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"))).toEqual({
      id: "job_purge01",
    });
  });

  it("is idempotent when the directories are already gone", async () => {
    const { jobDir, tmp } = await seedJob();
    await purgeJobArtifacts(jobDir, tmp, "job_purge01");
    await expect(purgeJobArtifacts(jobDir, tmp, "job_purge01")).resolves.toBeUndefined();
    expect(await exists(path.join(jobDir, "job.json"))).toBe(true);
  });
});
