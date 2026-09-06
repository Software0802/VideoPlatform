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
