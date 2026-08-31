import { createWriteStream } from "node:fs";
import { access, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { downloadHeadersFor, fetchUpstream, downloadXaiFile } from "@/lib/providers/grok/client";
import { log } from "@/lib/log";

export async function downloadToFile(url: string, dest: string) {
  const res = await fetchUpstream(url, { headers: downloadHeadersFor(url) });
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
}): Promise<void> {
  if (opts.remoteUrl?.startsWith("http")) {
    try {
      await downloadToFile(opts.remoteUrl, opts.dest);
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
