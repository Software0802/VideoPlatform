import { createWriteStream } from "node:fs";
import { access, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { downloadHeadersFor } from "@/lib/media/download-headers";
import { fetchUpstream, downloadXaiFile } from "@/lib/providers/grok/client";
import type { ProviderId } from "@/lib/providers/types";
import { log } from "@/lib/log";

/**
 * `providerId` 是这次成片属于哪家任务（`job.provider`）。给了它，鉴权头就按 provider
 * 绑定分发——只有「这家的 origin」才拿得到「这家的 key」；不给则退回按 origin 匹配的
 * 旧行为。见 `download-headers.ts`。
 */
export async function downloadToFile(url: string, dest: string, providerId?: ProviderId) {
  const res = await fetchUpstream(url, { headers: downloadHeadersFor(url, providerId) });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status}`);
  }
  try {
    const nodeStream = Readable.fromWeb(res.body as never);
    await pipeline(nodeStream, createWriteStream(dest));
  } catch (error) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function persistRemote(opts: {
  dest: string;
  remoteUrl?: string;
  fileId?: string;
  /** 这次成片属于哪家 provider 的任务；透传给 `downloadToFile` 做鉴权头绑定。 */
  providerId?: ProviderId;
}): Promise<void> {
  if (opts.remoteUrl?.startsWith("http")) {
    try {
      await downloadToFile(opts.remoteUrl, opts.dest, opts.providerId);
      return;
    } catch (e) {
      if (!opts.fileId) throw e;
      log("warn", "vidgen/imgen download failed, falling back to Files", {
        fileId: opts.fileId,
      });
    }
  } else if (opts.remoteUrl?.startsWith("data:")) {
    const comma = opts.remoteUrl.indexOf(",");
    const b64 = comma >= 0 ? opts.remoteUrl.slice(comma + 1) : "";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(opts.dest, Buffer.from(b64, "base64"));
    return;
  }
  if (opts.fileId) {
    await downloadXaiFile(opts.fileId, opts.dest);
    return;
  }
  await access(opts.dest);
}
