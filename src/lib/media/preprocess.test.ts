import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { preprocessImage } from "./preprocess";

/**
 * Decode ceiling (plan §3.3, P1): a small-in-bytes image can still legally decode to a
 * huge bitmap, and the production box runs under `MemoryMax=700M`. `sharp({ create })`
 * synthesizes a solid-color bitmap and encodes it, so these fixtures stay tiny on disk
 * (and fast to build) no matter how many pixels they claim.
 */

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .png()
    .toBuffer();
}

describe("preprocessImage", () => {
  it("accepts a normal 1000x1000 image and returns a jpeg within the size and dimension budget", async () => {
    const input = await solidPng(1000, 1000);
    const result = await preprocessImage(input);

    expect(result.width).toBe(1000);
    expect(result.height).toBe(1000);
    expect(Buffer.isBuffer(result.jpeg)).toBe(true);
    expect(result.jpeg.length).toBeGreaterThan(0);
    expect(result.jpeg.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("rejects a 7000x6000 image (42MP, over the 40MP ceiling) with 400 invalid_argument", async () => {
    const input = await solidPng(7000, 6000);
    await expect(preprocessImage(input)).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
    });
    await expect(preprocessImage(input)).rejects.toThrow(/像素/);
  });

  it("does not reject an oversized image on byte size alone — a small-on-disk PNG still trips the pixel ceiling", async () => {
    // A solid color still compresses well under any upload size ceiling (6MB) even at
    // 42MP, so this specifically exercises the pixel check rather than a byte-size one.
    const input = await solidPng(7000, 6000);
    expect(input.length).toBeLessThan(2 * 1024 * 1024);
    await expect(preprocessImage(input)).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("preprocessImage 的解码失败", () => {
  /*
    review 2026-09-15 U-01：选了 `.txt`、或改了扩展名的假 png，sharp 抛的是一句英文
    （`Input buffer contains unsupported image format`），而 `jsonError` 对未知异常一律
    500 `internal` 并把 message 原样下发——用户看到的是上游解码器的措辞，前端也把它当
    「服务端故障，稍后重试」处理。这里钉住：解不开的输入是 400 `invalid_argument` + 中文。
  */
  it("非图片字节 → 400 invalid_argument，不把 sharp 的英文原文抛出去", async () => {
    const notAnImage = Buffer.from("这不是图片，只是一段文本。".repeat(8), "utf8");
    await expect(preprocessImage(notAnImage)).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
    });
    await expect(preprocessImage(notAnImage)).rejects.toThrow(/图片文件/);
  });

  it("伪造文件头的 png（前 8 字节对、其余是垃圾）同样是 400", async () => {
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("garbage".repeat(64), "utf8"),
    ]);
    await expect(preprocessImage(fakePng)).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
    });
  });

  it("空字节也走同一条 400，而不是 500", async () => {
    await expect(preprocessImage(Buffer.alloc(0))).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
    });
  });
});
