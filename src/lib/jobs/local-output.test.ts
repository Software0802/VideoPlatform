import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupJobArtifacts, commitLocalOutput, resolveLocalOutput } from "./local-output";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lumen-local-output-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("commitLocalOutput", () => {
  it("rejects staged paths outside the job directory", () => {
    expect(() => resolveLocalOutput(path.join(root, "job"), "../escape.mp4")).toThrow(
      /invalid local output path/,
    );
  });

  it("removes staged bytes and never creates outputs after cancellation", async () => {
    const source = path.join(root, "cancel", "staged.mp4");
    const destination = path.join(root, "cancel", "outputs", "video.mp4");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "staged");

    const committed = await commitLocalOutput(source, destination, async () => true);

    expect(committed).toBe(false);
    await expect(access(source)).rejects.toThrow();
    await expect(access(destination)).rejects.toThrow();
  });

  it("moves staged bytes only while the job remains active", async () => {
    const source = path.join(root, "active", "staged.mp4");
    const destination = path.join(root, "active", "outputs", "video.mp4");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "ready");

    const committed = await commitLocalOutput(source, destination, async () => false);

    expect(committed).toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("ready");
  });

  it("cleans public, job-local, and global staged artifacts", async () => {
    const jobDir = path.join(root, "cleanup", "job");
    const tempDir = path.join(root, "cleanup", "tmp");
    const files = [
      path.join(jobDir, "outputs", "video.mp4"),
      path.join(jobDir, "outputs", "poster.jpg"),
      path.join(jobDir, "outputs", "image.jpg"),
      path.join(jobDir, "tmp", "still.jpg"),
      path.join(jobDir, "tmp", "video.mp4"),
      path.join(tempDir, "job-cleanup-video.mp4"),
    ];
    await Promise.all(files.map(async (file) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "artifact");
    }));

    await cleanupJobArtifacts(jobDir, tempDir, "job-cleanup");

    await Promise.all(files.map((file) => expect(access(file)).rejects.toThrow()));
  });
});
