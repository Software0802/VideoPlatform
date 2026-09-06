import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/env";
import type { MediaStore } from "@/lib/storage/types";

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export class LocalFsMediaStore implements MediaStore {
  constructor(private readonly configuredRoot?: string) {}

  /** Resolve the environment-backed root at use time so test/runtime config
   * changes cannot leave the store and tmp helpers pointing at different
   * directories. An explicit root remains stable for callers that inject one.
   */
  private rootDir(): string {
    return this.configuredRoot ?? dataDir();
  }

  jobDir(jobId: string): string {
    assertSafeId(jobId);
    return path.join(this.rootDir(), "jobs", jobId);
  }

  publicPath(jobId: string, file: "video.mp4" | "poster.jpg" | "image.jpg"): string {
    return `/api/media/${jobId}/${file}`;
  }

  async writeJobFile(jobId: string, rel: string, bytes: Buffer | Uint8Array): Promise<string> {
    const abs = this.resolveRel(jobId, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    return abs;
  }

  async readJobFile(jobId: string, rel: string): Promise<Buffer> {
    return readFile(this.resolveRel(jobId, rel));
  }

  async statJobFile(jobId: string, rel: string): Promise<{ size: number }> {
    const s = await stat(this.resolveRel(jobId, rel));
    return { size: s.size };
  }

  async openJobFile(jobId: string, rel: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolveRel(jobId, rel));
  }

  async listJobs(): Promise<string[]> {
    const dir = path.join(this.rootDir(), "jobs");
    try {
      const names = await readdir(dir);
      // 只留合法的任务 id：挡掉 `index.json`（派生索引，`jobs/index.ts`）、原子写留下的
      // `.tmp`，以及任何手工放进来的东西——它们都不是任务目录。判据与 `assertSafeId` 同源。
      return names.filter((n) => SAFE_ID_RE.test(n));
    } catch {
      return [];
    }
  }

  private resolveRel(jobId: string, rel: string): string {
    assertSafeId(jobId);
    const abs = path.resolve(this.jobDir(jobId), rel);
    const root = this.jobDir(jobId);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      throw new Error("invalid path");
    }
    return abs;
  }
}

export function assertSafeId(id: string) {
  if (!SAFE_ID_RE.test(id)) throw new Error("invalid id");
}

export const mediaStore = new LocalFsMediaStore();
