import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { jsonError } from "@/lib/http";
import { parseByteRange } from "@/lib/jobs/range";
import { readJobForUser } from "@/lib/jobs/store";
import { mediaStore } from "@/lib/storage/local-fs";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

const ALLOWED = new Set(["video.mp4", "poster.jpg", "image.jpg"]);

function rangeNotSatisfiable(size: number) {
  return new Response(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ jobId: string; file: string }> },
) {
  const { jobId, file } = await ctx.params;
  if (!ALLOWED.has(file)) {
    return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 });
  }
  // Being a static file is no excuse for skipping the owner check (plan §5.1):
  // the media URL is guessable from a job id, so it gets the same 404 as an
  // unknown job rather than streaming someone else's footage.
  try {
    const user = await requireUser(request);
    if (!(await readJobForUser(jobId, user.id))) {
      return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 });
    }
  } catch (e) {
    return jsonError(e);
  }
  let abs: string;
  try {
    abs = path.join(mediaStore.jobDir(jobId), `outputs/${file}`);
  } catch {
    return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 });
  }
  let size: number;
  try {
    size = (await stat(/*turbopackIgnore: true*/ abs)).size;
  } catch {
    return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 });
  }

  const type = file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
  const wantDownload = new URL(request.url).searchParams.get("download") === "1";
  const filename = `lumen-${jobId}${file.endsWith(".mp4") ? ".mp4" : ".jpg"}`;
  const disposition = wantDownload ? `attachment; filename="${filename}"` : undefined;
  const range = request.headers.get("range");
  if (range) {
    const parsed = parseByteRange(range, size);
    if (!parsed) return rangeNotSatisfiable(size);
    const { start, end } = parsed;
    const stream = createReadStream(/*turbopackIgnore: true*/ abs, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        ...(disposition ? { "Content-Disposition": disposition } : {}),
      },
    });
  }

  const stream = createReadStream(/*turbopackIgnore: true*/ abs);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      ...(disposition ? { "Content-Disposition": disposition } : {}),
    },
  });
}
