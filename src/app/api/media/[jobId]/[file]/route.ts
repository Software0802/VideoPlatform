import path from "node:path";
import { jsonError } from "@/lib/http";
import { readJobForUser } from "@/lib/jobs/store";
import { serveFile } from "@/lib/media/file-response";
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
 *
 * 分享链接（`/api/share/:token/media`）走的是另一套：那条路径的授权是签名令牌而不是
 * 会话，所以它可以 `public, max-age`。传输语义（Range / ETag / 304）两条共用
 * `@/lib/media/file-response`，缓存策略各自决定。
 */
const CACHE_CONTROL = "private, no-cache";

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "文件不存在" } }, { status: 404 });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ jobId: string; file: string }> },
) {
  const { jobId, file } = await ctx.params;
  if (!ALLOWED.has(file)) return notFound();
  // Being a static file is no excuse for skipping the owner check (plan §5.1):
  // the media URL is guessable from a job id, so it gets the same 404 as an
  // unknown job rather than streaming someone else's footage.
  try {
    const user = await requireUser(request);
    if (!(await readJobForUser(jobId, user.id))) return notFound();
  } catch (e) {
    return jsonError(e);
  }
  let abs: string;
  try {
    abs = path.join(mediaStore.jobDir(jobId), `outputs/${file}`);
  } catch {
    return notFound();
  }

  const wantDownload = new URL(request.url).searchParams.get("download") === "1";
  const filename = `lumen-${jobId}${file.endsWith(".mp4") ? ".mp4" : ".jpg"}`;
  const res = await serveFile(request, abs, {
    contentType: file.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
    cacheControl: CACHE_CONTROL,
    disposition: wantDownload ? `attachment; filename="${filename}"` : undefined,
  });
  return res ?? notFound();
}
