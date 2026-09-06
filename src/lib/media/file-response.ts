import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseByteRange } from "@/lib/jobs/range";

/**
 * 「把磁盘上一个文件按 HTTP 语义发出去」的共用实现：Range / 206、弱 ETag /
 * `If-None-Match` → 304、`Content-Disposition`。
 *
 * 抽出来是因为现在有两条路径要发同一批字节，而它们的**授权方式**完全相反：
 * `/api/media/:jobId/:file` 靠会话 + owner 校验（`private, no-cache`），
 * `/api/share/:token/media` 靠签名令牌（公开，可缓存）。缓存策略因此是参数而不是常量
 * ——共用的是传输语义，不是「谁能读」。
 *
 * 授权判断一律留在调用方，并且必须在调用本函数**之前**完成：这里一旦被调用就会
 * 开始读文件。
 */

export type ServeFileOptions = {
  contentType: string;
  /** 由调用方按授权方式决定，见上面。 */
  cacheControl: string;
  /** 带上就是下载（`?download=1`），不带是内联播放。 */
  disposition?: string;
};

/**
 * 弱校验器：大小 + mtime，`stat` 顺手就有。弱而不是强，是因为它来自元数据而不是字节
 * ——回答「变了没有」够用，且从不参与 Range 校验（我们完全忽略 `If-Range`，过期的
 * 范围请求只是重读一次文件）。
 */
export function weakEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

/** RFC 7232 §3.2：`*` 匹配一切，其余按弱比较逐个比对不透明标签。 */
export function ifNoneMatchHit(header: string | null, etag: string): boolean {
  if (!header) return false;
  const target = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate.replace(/^W\//, "") === target);
}

function rangeNotSatisfiable(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

/**
 * 发文件。文件不存在 / 读不到 stat 时返回 `null`，由调用方决定 404 的形状——媒体路由
 * 与分享路由的错误体不一样，这里不替它们编。
 */
export async function serveFile(
  request: Request,
  absolutePath: string,
  opts: ServeFileOptions,
): Promise<Response | null> {
  let size: number;
  let mtimeMs: number;
  try {
    const info = await stat(/*turbopackIgnore: true*/ absolutePath);
    if (!info.isFile()) return null;
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return null;
  }

  const etag = weakEtag(size, mtimeMs);
  const validators: Record<string, string> = {
    "Cache-Control": opts.cacheControl,
    ETag: etag,
    "Last-Modified": new Date(Math.floor(mtimeMs)).toUTCString(),
  };
  const disposition: Record<string, string> = opts.disposition
    ? { "Content-Disposition": opts.disposition }
    : {};

  // 按 RFC 7232 §6 在 Range 之前判：已经拿着这批字节的客户端，不管它要不要切片都该拿
  // 304。调用方的授权检查已经跑过了——304 同样是在陈述一个私有文件的状态。
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
    const stream = createReadStream(/*turbopackIgnore: true*/ absolutePath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": opts.contentType,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        ...validators,
        ...disposition,
      },
    });
  }

  const stream = createReadStream(/*turbopackIgnore: true*/ absolutePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": opts.contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      ...validators,
      ...disposition,
    },
  });
}
