import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import Busboy, { type BusboyInstance } from "@fastify/busboy";
import { probeDurationSec } from "@/lib/ffmpeg";
import { tmpDir } from "@/lib/jobs/store";
import { preprocessImage } from "@/lib/media/preprocess";
import { uploadRoleSchema, type UploadRole, type UploadSidecar } from "@/lib/jobs/schema";
import { ProviderHttpError } from "@/lib/providers/types";

/**
 * Sized for the production box (2 cores / 1.8G, `MemoryMax=700M`) rather than for
 * generosity (plan §3.3, P1): an image is buffered whole in memory before sharp gets
 * it, and two concurrent uploads at the old 12MB/48MB were already enough to matter.
 * `preprocessImage` re-encodes everything to ≤256KB anyway, so the ceiling only ever
 * refuses inputs whose extra bytes would have been thrown away.
 */
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_VIDEO = 24 * 1024 * 1024;
const MAX_IMAGE_LABEL = "6MB";
const MAX_VIDEO_LABEL = "24MB";

/** `ownerId` is the session user; it is stamped into the sidecar so only that
 * user can later claim the file into a job (plan §5.3). */
export async function handleUpload(request: Request, ownerId: string): Promise<UploadSidecar> {
  if (!request.body) throw new ProviderHttpError(400, "invalid_argument", "缺少文件");
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new ProviderHttpError(400, "invalid_argument", "请求必须是 multipart/form-data");
  }
  let busboy: BusboyInstance;
  try {
    busboy = new Busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fields: 4, fileSize: MAX_VIDEO },
    });
  } catch {
    throw new ProviderHttpError(400, "invalid_argument", "上传表单格式不合法");
  }

  const nodeReq = Readable.fromWeb(request.body as never);
  const uploadId = `up_${randomBytes(8).toString("hex")}`;
  await mkdir(tmpDir(), { recursive: true });
  const dest = path.join(tmpDir(), uploadId);

  let role = "start";
  let mime = "application/octet-stream";
  let filename = "file";
  let truncated = false;
  const chunks: Buffer[] = [];
  let isVideo = false;
  let written = 0;
  let fileSeen = false;
  let fileComplete = false;
  let parserFinished = false;

  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const maybeComplete = () => {
      if (settled || !parserFinished || (fileSeen && !fileComplete)) return;
      settled = true;
      resolve();
    };
    busboy.on("field", (name, val) => {
      if (name === "role") role = val;
    });
    busboy.on("file", (_n, file, fileName, _enc, mimeType) => {
      fileSeen = true;
      mime = mimeType || "application/octet-stream";
      filename = fileName || "file";
      isVideo = mime.includes("mp4") || filename.toLowerCase().endsWith(".mp4");
      const max = isVideo ? MAX_VIDEO : MAX_IMAGE;
      if (isVideo) {
        const ws = createWriteStream(dest);
        file.on("data", (d: Buffer) => {
          written += d.length;
          if (written > max) {
            truncated = true;
          }
        });
        file.pipe(ws);
        file.on("error", fail);
        ws.on("finish", () => {
          fileComplete = true;
          maybeComplete();
        });
        ws.on("error", fail);
      } else {
        file.on("data", (d: Buffer) => {
          written += d.length;
          if (written > max) truncated = true;
          else chunks.push(d);
        });
        file.on("end", () => {
          fileComplete = true;
          maybeComplete();
        });
        file.on("error", fail);
      }
      file.on("limit", () => {
        truncated = true;
      });
    });
    busboy.on("error", fail);
    busboy.on("filesLimit", () => fail(new ProviderHttpError(400, "invalid_argument", "一次只能上传一个文件")));
    busboy.on("fieldsLimit", () => fail(new ProviderHttpError(400, "invalid_argument", "上传表单字段过多")));
    busboy.on("finish", () => {
      parserFinished = true;
      maybeComplete();
    });
    nodeReq.on("error", fail);
  });

  nodeReq.pipe(busboy);
  try {
    await done;
  } catch (e) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw e;
  }

  if (truncated) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw new ProviderHttpError(
      400,
      "invalid_argument",
      isVideo ? `视频文件超过 ${MAX_VIDEO_LABEL}` : `图片文件超过 ${MAX_IMAGE_LABEL}`,
    );
  }
  if (!fileSeen) {
    await cleanupUpload(dest);
    throw new ProviderHttpError(400, "invalid_argument", "缺少文件");
  }
  const parsedRole = uploadRoleSchema.safeParse(role);
  if (!parsedRole.success) {
    await cleanupUpload(dest);
    throw new ProviderHttpError(400, "invalid_argument", "未知上传角色");
  }
  // 本地 const 而不是 `parsedRole.data`：下面按它分叉，TypeScript 只在局部变量上
  // 才把「不是 source_video」这件事记住，图片分支就不用再断言一次角色。
  const uploadRole = parsedRole.data;
  if (uploadRole === "source_video" && !isVideo) {
    await cleanupUpload(dest);
    throw new ProviderHttpError(400, "invalid_argument", "源视频必须是 MP4 文件");
  }
  if (uploadRole !== "source_video" && isVideo) {
    await cleanupUpload(dest);
    throw new ProviderHttpError(400, "invalid_argument", "首帧、尾帧和参考资产必须是图片");
  }

  // 走到这里两者已经互为充要条件（上面两条守卫排掉了另外两种组合），按角色分叉。
  if (uploadRole === "source_video") {
    try {
      const probe = await probeDurationSec(dest);
      if (
        !Number.isFinite(probe.durationSec) ||
        probe.durationSec <= 0 ||
        !Number.isInteger(probe.width) ||
        !Number.isInteger(probe.height) ||
        probe.width <= 0 ||
        probe.height <= 0
      ) {
        throw new ProviderHttpError(400, "invalid_argument", "无法解析视频尺寸或时长");
      }
      const side: UploadSidecar = {
        uploadId,
        ownerId,
        role: uploadRole,
        width: probe.width,
        height: probe.height,
        bytes: written,
        mimeType: "video/mp4",
        durationSec: probe.durationSec,
        createdAt: new Date().toISOString(),
      };
      await writeFile(`${dest}.json`, JSON.stringify(side));
      return side;
    } catch (e) {
      await cleanupUpload(dest);
      throw e;
    }
  }

  // 图片走和 `POST /api/uploads/from-job` 同一条落盘路径：预处理、尺寸、sidecar 只有
  // 一份实现，两个入口产出的上传在 `create.ts` 眼里没有任何区别。`dest` 这时还没被
  // 写过（图片是攒在内存里的），所以让它自己取一个 uploadId 不会留下孤儿文件。
  return storeUploadFromBuffer(Buffer.concat(chunks), uploadRole, ownerId);
}

/**
 * 把一段图片字节变成一个可被 `createJob` 认领的上传：压缩 → 落 `data/tmp/<uploadId>`
 * → 写同名 `.json` sidecar。`ownerId` 是会话用户，盖进 sidecar 后只有本人能认领
 * （plan §5.3）。
 *
 * 两个调用方：`handleUpload`（multipart 上传）与 `POST /api/uploads/from-job`
 * （拿自己已生成的图片当首帧）。只接图片——`source_video` 不走这里。
 */
export async function storeUploadFromBuffer(
  buffer: Buffer,
  role: Exclude<UploadRole, "source_video">,
  ownerId: string,
): Promise<UploadSidecar> {
  const uploadId = `up_${randomBytes(8).toString("hex")}`;
  await mkdir(tmpDir(), { recursive: true });
  const dest = path.join(tmpDir(), uploadId);
  try {
    const jpeg = await preprocessImage(buffer);
    await writeFile(dest, jpeg.jpeg);
    const side: UploadSidecar = {
      uploadId,
      ownerId,
      role,
      width: jpeg.width,
      height: jpeg.height,
      bytes: jpeg.jpeg.length,
      mimeType: "image/jpeg",
      durationSec: null,
      createdAt: new Date().toISOString(),
    };
    await writeFile(`${dest}.json`, JSON.stringify(side));
    return side;
  } catch (e) {
    await cleanupUpload(dest);
    throw e;
  }
}

async function cleanupUpload(dest: string) {
  await Promise.all([
    rm(dest, { force: true }),
    rm(`${dest}.json`, { force: true }),
  ]);
}
