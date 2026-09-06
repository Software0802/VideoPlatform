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

/**
 * The bytes behind one URL really are immutable (an artifact under `outputs/` is written
 * once by `stageThenCommit`; a retry gets a new job id, retention deletes rather than
 * rewrites) — but *who may read them* is not, and that is what decides the header.
 *
 * A long `max-age` would let one browser keep serving job A's poster from disk after the
 * user signed out and signed in as someone else: the request never reaches us, so the
 * `readJobForUser` check below never runs. `no-cache` keeps the entry in the browser
 * cache but forces revalidation on every use, so the owner check runs every time; the
 * bandwidth is still saved, because a revalidation that matches the ETag is answered
 * with a bodyless 304 (after the ownership check — see below).
 *
 * `private` stays for the same reason it was there: these are one user's outputs and the
 * owner check is the only thing standing between them and anyone who can guess a job id,
 * so no shared cache may ever hold a copy.
 */
const CACHE_CONTROL = "private, no-cache";

/**
 * Weak validator: size + mtime, which is what `stat` already gave us. Weak rather than
 * strong because it is derived from metadata, not from the bytes — good enough for the
 * "did this change at all" question a 304 answers, and never used for range validation
 * (we ignore `If-Range` entirely, so a stale range request just re-reads the file).
 */
function weakEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

/** RFC 7232 §3.2: `*` matches anything, otherwise compare the opaque tags weakly. */
function ifNoneMatchHit(header: string | null, etag: string): boolean {
  if (!header) return false;
  const target = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate.replace(/^W\//, "") === target);
}

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
  let mtimeMs: number;
  try {
    const info = await stat(/*turbopackIgnore: true*/ abs);
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 });
  }

  const type = file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
  const wantDownload = new URL(request.url).searchParams.get("download") === "1";
  const filename = `lumen-${jobId}${file.endsWith(".mp4") ? ".mp4" : ".jpg"}`;
  const disposition = wantDownload ? `attachment; filename="${filename}"` : undefined;
  const etag = weakEtag(size, mtimeMs);
  const validators = {
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
    "Last-Modified": new Date(Math.floor(mtimeMs)).toUTCString(),
  };
  // Evaluated before Range, per RFC 7232 §6: a client that already holds these bytes
  // gets 304 whether or not it asked for a slice of them. The ownership check above
  // has already run — a 304 is still a statement about a private file.
  if (ifNoneMatchHit(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ...validators, "Accept-Ranges": "bytes" },
    });
  }
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
        ...validators,
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
      ...validators,
      ...(disposition ? { "Content-Disposition": disposition } : {}),
    },
  });
}
