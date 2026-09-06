import { z } from "zod";
import { jsonError } from "@/lib/http";
import { readJobForUser } from "@/lib/jobs/store";
import { storeUploadFromBuffer } from "@/lib/jobs/upload";
import { ProviderHttpError } from "@/lib/providers/types";
import { mediaStore } from "@/lib/storage/local-fs";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

/** 产物在磁盘上的固定位置，由 `runner.ts` 写死（`destRel: "outputs/image.jpg"`）。 */
const OUTPUT_IMAGE_REL = "outputs/image.jpg";

const bodySchema = z.strictObject({
  // 与 `mediaStore.assertSafeId` 同一套字符集：既挡路径穿越，也不会把用户系统之前
  // 生成的旧 id 拒之门外。
  jobId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** `source_video` 不在其中：这条路径只搬图片。 */
  role: z.enum(["start", "last", "reference"]),
});

/**
 * 「用已生成的图片当首帧」（方案 §1.4 素材选择弹窗）。
 *
 * 把调用者自己的一条成功图片任务的产物，复制成一个普通上传，之后的链路和手动上传
 * 完全一样（同一个 sidecar、同一个认领流程、同样在 `createJob` 里按 ownerId 校验）。
 * 复制而不是引用：原任务可能被留存清理删掉产物，而新任务的输入必须在自己名下。
 *
 * 别人的任务、不存在的任务一律 404，与 `GET /api/jobs/:id` 同一条纪律——404 和 403
 * 的区别本身就是「这个 id 存在」的情报。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = bodySchema.parse(await request.json());
    const job = await readJobForUser(body.jobId, user.id);
    if (!job) {
      return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });
    }
    if (job.status !== "succeeded" || job.output?.kind !== "image") {
      throw new ProviderHttpError(400, "invalid_argument", "只能选用已生成的图片作品");
    }
    if (job.artifactsPurgedAt) {
      throw new ProviderHttpError(400, "artifacts_purged", "作品已过期清理，请重新生成后再用");
    }

    let bytes: Buffer;
    try {
      bytes = await mediaStore.readJobFile(job.id, OUTPUT_IMAGE_REL);
    } catch {
      // 记录说成功、盘上没有：对调用方而言和「作品不存在」是同一件事。
      return Response.json({ error: { code: "not_found", message: "作品文件不存在" } }, { status: 404 });
    }

    const side = await storeUploadFromBuffer(bytes, body.role, user.id);
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
