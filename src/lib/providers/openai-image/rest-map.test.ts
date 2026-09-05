import { describe, expect, it } from "vitest";
import type { AspectRatio, ProviderGenerateRequest } from "@/lib/providers/types";
import { buildImageRequest, mapAspectToSize, mapQuality, parseImageResponse } from "./rest-map";

function req(over: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    jobId: "job_openai_map",
    mode: "text_to_image",
    model: "gpt-image-1",
    prompt: "一只在雨里的橘猫",
    generateAudio: false,
    ...over,
  };
}

describe("mapAspectToSize", () => {
  const cases: Array<[AspectRatio | undefined, string, { w: number; h: number } | null]> = [
    ["1:1", "1024x1024", null],
    ["3:2", "1536x1024", null],
    ["2:3", "1024x1536", null],
    ["16:9", "1536x1024", { w: 1536, h: 864 }],
    ["9:16", "1024x1536", { w: 864, h: 1536 }],
    ["4:3", "1536x1024", { w: 1365, h: 1024 }],
    ["3:4", "1024x1536", { w: 1024, h: 1365 }],
    [undefined, "1024x1024", null],
  ];

  it.each(cases)("maps %s to %s", (aspect, size, crop) => {
    expect(mapAspectToSize(aspect)).toEqual({ size, crop });
  });

  it("only ever asks for a size gpt-image-1 accepts", () => {
    for (const [aspect] of cases) {
      expect(["1024x1024", "1536x1024", "1024x1536"]).toContain(mapAspectToSize(aspect).size);
    }
  });

  it("hands out a fresh crop object so callers cannot mutate the table", () => {
    const first = mapAspectToSize("16:9");
    first.crop!.w = 1;
    expect(mapAspectToSize("16:9").crop).toEqual({ w: 1536, h: 864 });
  });
});

describe("mapQuality", () => {
  it("treats the 2k chip as the high tier and everything else as low", () => {
    expect(mapQuality("2k")).toBe("high");
    expect(mapQuality("1k")).toBe("low");
    expect(mapQuality(undefined)).toBe("low");
  });
});

describe("buildImageRequest", () => {
  it("sends exactly the six documented fields", () => {
    const body = buildImageRequest(req({ aspectRatio: "16:9", imageResolution: "2k" }));
    expect(Object.keys(body).sort()).toEqual(
      ["model", "n", "output_format", "prompt", "quality", "size"].sort(),
    );
    expect(body).toEqual({
      model: "gpt-image-1",
      prompt: "一只在雨里的橘猫",
      size: "1536x1024",
      quality: "high",
      n: 1,
      output_format: "png",
    });
  });

  it("never leaks video-shaped fields upstream", () => {
    const body = buildImageRequest(
      req({
        aspectRatio: "9:16",
        durationSec: 8,
        resolution: "1080p",
        generateAudio: true,
        startImage: { kind: "data_uri", dataUri: "data:image/jpeg;base64,aa" },
      }),
    );
    for (const key of [
      "duration",
      "aspect_ratio",
      "resolution",
      "generate_audio",
      "image",
      "storage_options",
      "response_format",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.size).toBe("1024x1536");
  });

  it("forwards the prompt verbatim — no appended, translated or default wording", () => {
    const prompt = "  a lone   lighthouse\n\n镜头缓慢推近, 4k, --no text  ";
    expect(buildImageRequest(req({ prompt })).prompt).toBe(prompt);
    expect(buildImageRequest(req({ prompt: "" })).prompt).toBe("");
  });

  it("uses the caller's model name", () => {
    expect(buildImageRequest(req({ model: "gpt-image-1-mini" })).model).toBe("gpt-image-1-mini");
  });
});

describe("parseImageResponse", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

  it("decodes b64_json and the token usage", () => {
    const parsed = parseImageResponse({
      data: [{ b64_json: png.toString("base64") }],
      usage: {
        input_tokens: 42,
        output_tokens: 4160,
        total_tokens: 4202,
        input_tokens_details: { text_tokens: 42, image_tokens: 0 },
      },
    });
    expect(parsed.png.equals(png)).toBe(true);
    expect(parsed.usage).toEqual({ inputTokens: 42, outputTokens: 4160, totalTokens: 4202 });
  });

  it("returns no usage when the response omits it", () => {
    const parsed = parseImageResponse({ data: [{ b64_json: png.toString("base64") }] });
    expect(parsed.usage).toBeUndefined();
  });

  it("fails with a 502 when no image came back", () => {
    for (const body of [{}, { data: [] }, { data: [{}] }, { data: [{ b64_json: "" }] }]) {
      expect(() => parseImageResponse(body)).toThrow(
        expect.objectContaining({ status: 502, code: "upstream_invalid_response" }),
      );
    }
  });

  it("refuses a url-only response instead of downloading it", () => {
    let thrown: unknown;
    try {
      parseImageResponse({ data: [{ url: "https://cdn.example.com/img.png" }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 502, code: "upstream_invalid_response" });
    expect((thrown as Error).message).toContain("b64_json");
  });
});
