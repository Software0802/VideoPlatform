import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import Busboy, { type BusboyInstance } from "@fastify/busboy";
import { probeDurationSec } from "@/lib/ffmpeg";
import { tmpDir } from "@/lib/jobs/store";
import { preprocessImage } from "@/lib/media/preprocess";
import { uploadRoleSchema, type UploadSidecar } from "@/lib/jobs/schema";
import { ProviderHttpError } from "@/lib/providers/types";

const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_VIDEO = 48 * 1024 * 1024;

export async function handleUpload(request: Request): Promise<UploadSidecar> {
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
    throw new ProviderHttpError(400, "invalid_argument", "文件过大");
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
  if (parsedRole.data === "source_video" && !isVideo) {
    await cleanupUpload(dest);
    throw new ProviderHttpError(400, "invalid_argument", "源视频必须是 MP4 文件");
  }
  if (parsedRole.data !== "source_video" && isVideo) {
    await cleanupUpload(dest);
    throw new ProviderHttpError(400, "invalid_argument", "首帧、尾帧和参考资产必须是图片");
  }

  if (isVideo) {
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
        role: parsedRole.data,
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

  try {
    const jpeg = await preprocessImage(Buffer.concat(chunks));
    await writeFile(dest, jpeg.jpeg);
    const side: UploadSidecar = {
      uploadId,
      role: parsedRole.data,
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
