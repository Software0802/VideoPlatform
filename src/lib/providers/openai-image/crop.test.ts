import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cropToAspect } from "./crop";
import { mapAspectToSize } from "./rest-map";

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .png()
    .toBuffer();
}

function isJpeg(buf: Buffer): boolean {
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

describe("cropToAspect", () => {
  it("converts to JPEG without cropping when the aspect needs no crop", async () => {
    const out = await cropToAspect(await solidPng(1024, 1024), null);
    const meta = await sharp(out).metadata();
    expect(isJpeg(out)).toBe(true);
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([1024, 1024]);
  });

  it.each([
    ["16:9", 1536, 1024, 1536, 864],
    ["9:16", 1024, 1536, 864, 1536],
    ["4:3", 1536, 1024, 1365, 1024],
    ["3:4", 1024, 1536, 1024, 1365],
  ] as const)(
    "crops %s to the exact target box when upstream ships the expected size",
    async (aspect, srcW, srcH, outW, outH) => {
      const { crop } = mapAspectToSize(aspect);
      const out = await cropToAspect(await solidPng(srcW, srcH), crop);
      const meta = await sharp(out).metadata();
      expect(isJpeg(out)).toBe(true);
      expect([meta.width, meta.height]).toEqual([outW, outH]);
    },
  );

  it("keeps the target ratio instead of the literal pixels when upstream changed the size", async () => {
    // 800x800 is not a size gpt-image-1 documents; the 16:9 box must still come out 16:9.
    const out = await cropToAspect(await solidPng(800, 800), { w: 1536, h: 864 });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([800, 450]);
    expect(meta.width! / meta.height!).toBeCloseTo(1536 / 864, 2);
  });

  it("never enlarges past a source that is smaller than the target on the long edge", async () => {
    const out = await cropToAspect(await solidPng(512, 900), { w: 864, h: 1536 });
    const meta = await sharp(out).metadata();
    expect(meta.width!).toBeLessThanOrEqual(512);
    expect(meta.height!).toBeLessThanOrEqual(900);
    expect(meta.width! / meta.height!).toBeCloseTo(864 / 1536, 2);
  });
});
