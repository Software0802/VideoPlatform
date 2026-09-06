import path from "node:path";
import { serveFile } from "@/lib/media/file-response";
import { resolveSharedJob } from "@/lib/share/resolve";
import { mediaStore } from "@/lib/storage/local-fs";

export const runtime = "nodejs";

/**
 * 公开的成片流（方案 §1.4）。与 `/api/media/:jobId/:file` 是同一批字节、同一套传输语义
 * （Range / 弱 ETag / 304，共用 `@/lib/media/file-response`），差别只在授权与缓存：
 *
 * - 那条按会话 + owner 校验，所以必须 `private, no-cache`——同一个浏览器换账号登录后，
 *   缓存里的副本不能绕过 owner 校验被再用一次（AGENTS「媒体路由」硬约束）。
 * - 这条按签名令牌授权，URL 本身就是凭据：拿到 URL 的人**就是**被授权的人，缓存副本
 *   不会落到「不该看的人」手上，所以 `public, max-age=3600` 是安全的，也让转发出去的
 *   链接被反复打开时不必每次回源。
 *
 * 到期的令牌最多让边缘再供一小时旧字节。这是刻意的取舍：分享链接的威胁模型是「链接
 * 泄露」，不是「一小时内的精确回收」。
 */
const CACHE_CONTROL = "public, max-age=3600";

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "链接已失效" } }, { status: 404 });
}

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const rec = await resolveSharedJob(token);
  if (!rec || !rec.output) return notFound();

  const isVideo = rec.output.kind === "video";
  const file = isVideo ? "video.mp4" : "image.jpg";
  let abs: string;
  try {
    // `jobDir` 里的 `assertSafeId` 把路径钉死在 `data/jobs/<id>/` 下；文件名是上面两个
    // 字面量之一，用户输入只有令牌，且它已经验过签。
    abs = path.join(mediaStore.jobDir(rec.id), `outputs/${file}`);
  } catch {
    return notFound();
  }

  const res = await serveFile(request, abs, {
    contentType: isVideo ? "video/mp4" : "image/jpeg",
    cacheControl: CACHE_CONTROL,
  });
  return res ?? notFound();
}
