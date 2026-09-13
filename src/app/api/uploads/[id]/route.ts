import { readFile } from "node:fs/promises";
import path from "node:path";
import { jsonError } from "@/lib/http";
import { withRequestContext } from "@/lib/request-context";
import { tmpDir } from "@/lib/jobs/store";
import { UPLOAD_ID_RE, type UploadSidecar } from "@/lib/jobs/schema";
import { requireUser } from "@/lib/users/session";
import { dataDir } from "@/lib/env";
import { ASSET_ID_RE, AssetUnavailableError, readAsset } from "@/lib/assets/files.mjs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "上传文件不存在或已过期" } }, { status: 404 });
}

/**
 * 读一份上传素材（C 包画布素材节点刷新后重显用）。
 *
 * 与任务媒体同一条纪律：`Cache-Control: private, no-cache`——字节不变但「谁能读」
 * 会变（同浏览器换账号登录），长缓存会让浏览器跳过 owner 校验直接吃缓存。
 * 别人的 / 过期的 / 手改过的 sidecar 一律 404，与 `createJob` 的认领判定同口径。
 */
async function detail(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const user = await requireUser(request);
    const { id } = await ctx.params;
    let bytes: Buffer;
    let mimeType: string;
    if (ASSET_ID_RE.test(id)) {
      const asset = await readAsset(dataDir(), user.id, id);
      if (!asset) return notFound();
      bytes = asset.bytes;
      mimeType = asset.metadata.mimeType;
    } else {
      if (!UPLOAD_ID_RE.test(id)) return notFound();
      let side: UploadSidecar;
      try {
        side = JSON.parse(await readFile(path.join(tmpDir(), `${id}.json`), "utf8")) as UploadSidecar;
      } catch {
        return notFound();
      }
      if (side.uploadId !== id || side.ownerId !== user.id) return notFound();
      try {
        bytes = await readFile(path.join(tmpDir(), id));
      } catch {
        return notFound();
      }
      mimeType = side.mimeType || "application/octet-stream";
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": mimeType,
        "content-length": String(bytes.length),
        "cache-control": "private, no-cache",
      },
    });
  } catch (e) {
    if (e instanceof AssetUnavailableError || e instanceof SyntaxError) return notFound();
    return jsonError(e);
  }
}

export const GET = withRequestContext(detail);
