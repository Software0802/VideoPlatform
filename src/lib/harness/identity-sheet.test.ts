import { createServer } from "node:http";
import { grokNativeProvider } from "@/lib/providers/grok/native";
import { MODEL_IMAGE } from "@/lib/providers/grok/mode-matrix";
import { describe, expect, it, vi } from "vitest";
import type { ProviderHandle, VideoProvider } from "@/lib/providers/types";
import type { IdentityBible } from "./types";
import {
  buildIdentitySheetPrompt,
  requestIdentitySheet,
  type IdentitySheetInput,
} from "./identity-sheet";

const bible: IdentityBible = {
  version: 1,
  logline: "雨夜摄影师寻找旧电影院",
  style: {
    palette: ["amber", "deep blue"],
    lighting: "warm tungsten against cool rain light",
    lens: "35mm",
    era: "contemporary",
    doNotChange: ["short black hair", "navy coat", "facial identity"],
  },
  characters: [
    {
      id: "char_main",
      name: "林",
      lockedTraits: ["short black hair", "navy coat", "small silver camera"],
      sheetAssetIds: [],
    },
  ],
  locations: [],
  props: [],
};

const input: IdentitySheetInput = {
  jobId: "job_director_fixture",
  bible,
  characterId: "char_main",
  language: "zh",
};

function fakeProvider(): VideoProvider & {
  submit: ReturnType<typeof vi.fn<(request: never) => Promise<ProviderHandle>>>;
} {
  return {
    id: "grok",
    capabilities: () => ({
      modes: ["text_to_image"],
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p",
    }),
    submit: vi.fn(async () => ({
      providerId: "grok" as const,
      remoteUrl: "http://fixture.invalid/sheet.jpg",
    })),
    poll: vi.fn(),
  };
}

describe("identity sheet", () => {
  it("builds a prompt containing every identity lock", () => {
    const prompt = buildIdentitySheetPrompt(input);
    expect(prompt).toContain("林");
    expect(prompt).toContain("short black hair");
    expect(prompt).toContain("navy coat");
    expect(prompt).toContain("amber");
    expect(prompt).toContain("warm tungsten against cool rain light");
    expect(prompt).toContain("facial identity");
    expect(prompt).toContain("不要出现文字");
  });

  it("submits a 1:1 1k image request and returns the provider handle", async () => {
    const provider = fakeProvider();
    const result = await requestIdentitySheet(input, provider, "grok-imagine-image-2.0");
    expect(provider.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_director_fixture-sheet-0",
        mode: "text_to_image",
        model: "grok-imagine-image-2.0",
        aspectRatio: "1:1",
        imageResolution: "1k",
        generateAudio: false,
      }),
    );
    expect(result.characterId).toBe("char_main");
    expect(result.handle.remoteUrl).toContain("fixture.invalid");
  });

  it("rejects unknown characters and providers without image generation", async () => {
    expect(() => buildIdentitySheetPrompt({ ...input, characterId: "missing" })).toThrow("角色不存在");
    const provider = fakeProvider();
    provider.capabilities = () => ({
      modes: ["text_to_video"] as const,
      maxDurationSec: 15,
      supportsLastFrameLock: false,
      maxResolution: "1080p" as const,
    });
    await expect(requestIdentitySheet(input, provider, "grok-imagine-image-2.0")).rejects.toThrow("不支持角色表生成");
  });

  it("does not expose a moderation-rejected identity sheet", async () => {
    const provider = fakeProvider();
    provider.submit.mockResolvedValueOnce({
      providerId: "grok",
      respectModeration: false,
    });
    await expect(requestIdentitySheet(input, provider, "grok-imagine-image-2.0")).rejects.toThrow("角色表未通过安全审核");
  });

  it("works end-to-end against a local Sub2API-compatible endpoint", async () => {
    const previous = {
      apiKey: process.env.XAI_API_KEY,
      proxyKey: process.env.SUB2API_API_KEY,
      base: process.env.XAI_BASE_URL,
    };
    let requestPath = "";
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      requestPath = request.url ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [{ b64_json: "AQ==", respect_moderation: true }],
          usage: { cost_in_usd_ticks: 200000000 },
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind");
    delete process.env.XAI_API_KEY;
    process.env.SUB2API_API_KEY = "fixture-key";
    process.env.XAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    try {
      const result = await requestIdentitySheet(input, grokNativeProvider, MODEL_IMAGE);
      expect(result.handle.remoteUrl).toBe("data:image/jpeg;base64,AQ==");
      expect(requestPath).toBe("/v1/images/generations");
      expect(requestBody?.model).toBe("grok-imagine-image-2.0");
      expect(requestBody?.aspect_ratio).toBe("1:1");
      expect(requestBody?.resolution).toBe("1k");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previous.apiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previous.apiKey;
      if (previous.proxyKey === undefined) delete process.env.SUB2API_API_KEY;
      else process.env.SUB2API_API_KEY = previous.proxyKey;
      if (previous.base === undefined) delete process.env.XAI_BASE_URL;
      else process.env.XAI_BASE_URL = previous.base;
    }
  });
});
