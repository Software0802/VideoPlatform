import { jsonError } from "@/lib/http";
import { sweepTmpSoon } from "@/lib/jobs/sweep";
import { handleUpload } from "@/lib/jobs/upload";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";
import { consumeRateLimit } from "@/lib/users/rate-limit";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/**
 * 每人每分钟能传多少个素材（方案 §3.2「安全收口」）。
 *
 * 比提交任务（10）更紧：上传是唯一一条「不花上游的钱、却直接吃掉本机磁盘」的路径，
 * 而 `data/tmp/` 里的文件要到被任务认领或过期清理时才消失。真实创作一次最多传首帧 +
 * 尾帧 + 几张参考图，5 次/分钟够用。
 */
const UPLOADS_RATE_LIMIT = 5;

async function handler(request: Request) {
  try {
    const user = await requireUser(request);
    const gate = consumeRateLimit([`uploads:user:${user.id}`], { limit: UPLOADS_RATE_LIMIT });
    if (!gate.allowed) {
      throw new ProviderHttpError(
        429,
        "rate_limited",
        `上传过于频繁，请 ${gate.retryAfterSec} 秒后再试`,
      );
    }
    const side = await handleUpload(request, user.id);
    // 容量检查不等 runner 那个每小时的定时器：暂存区涨到上限只需要几十次上传，
    // 而这条路径正是唯一能把它撑起来的路径。后台跑，不占用户这次响应的时间。
    sweepTmpSoon();
    return Response.json({
      uploadId: side.uploadId,
      role: side.role,
      width: side.width,
      height: side.height,
      bytes: side.bytes,
      durationSec: side.durationSec,
    });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(handler);
