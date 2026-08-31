import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  DIRECTOR_MODEL,
  createDirectorPlan,
  directorPlanSchema,
  type DirectorCompletionRequest,
} from "./director";

const validPlan = {
  targetDurationSec: 30,
  packing: {
    clips: [
      { kind: "generate", durationSec: 15 },
      { kind: "extend", durationSec: 10 },
      { kind: "generate", durationSec: 5 },
    ],
  },
  bible: {
    version: 1,
    logline: "一名摄影师在雨夜寻找旧电影院。",
    style: {
      palette: ["amber", "deep blue"],
      lighting: "warm tungsten against cool rain light",
      lens: "35mm",
      era: "contemporary",
      doNotChange: ["character identity", "navy coat"],
    },
    characters: [
      {
        id: "char_main",
        name: "林",
        lockedTraits: ["short black hair", "navy coat"],
        sheetAssetIds: [],
      },
    ],
    locations: [{ id: "loc_cinema", name: "old cinema", refAssetIds: [] }],
    props: [],
  },
  shots: [
    {
      id: "shot_0",
      index: 0,
      durationSec: 15,
      prompt: "林在雨夜走向旧电影院，镜头平稳跟拍。",
      characterIds: ["char_main"],
      locationId: "loc_cinema",
      route: "grok_i2v",
      continuity: "hard_cut",
      generateAudio: false,
    },
    {
      id: "shot_1",
      index: 1,
      durationSec: 10,
      prompt: "镜头跟随林穿过电影院门厅，保持动作和服装连续。",
      characterIds: ["char_main"],
      locationId: "loc_cinema",
      route: "grok_extend",
      continuity: "extend",
      generateAudio: false,
    },
    {
      id: "shot_2",
      index: 2,
      durationSec: 5,
      prompt: "林停在银幕前回望，暖色灯光落在脸上。",
      characterIds: ["char_main"],
      locationId: "loc_cinema",
      route: "grok_i2v",
      continuity: "tail_chain",
      generateAudio: false,
    },
  ],
  stitch: { transition: "hard_cut", settleLastFrame: false },
} as const;

function json(value: unknown) {
  return JSON.stringify(value);
}

describe("director", () => {
  it("requests a strict Grok JSON schema and parses a valid plan", async () => {
    const requests: DirectorCompletionRequest[] = [];
    const plan = await createDirectorPlan(
      { prompt: "雨夜电影院的连续短片", targetDurationSec: 30, language: "zh" },
      {
        complete: async (request) => {
          requests.push(request);
          expect(request.model).toBe(DIRECTOR_MODEL);
          expect(request.responseFormat).toMatchObject({
            type: "json_schema",
            json_schema: { name: "lumen_harness_plan", strict: true },
          });
          expect(request.messages[0]?.role).toBe("system");
          expect(request.messages[1]?.content).toContain("雨夜电影院");
          return json(validPlan);
        },
      },
    );

    expect(plan).toEqual(validPlan);
    expect(requests).toHaveLength(1);
  });

  it("retries malformed plans at most twice and succeeds on a later valid plan", async () => {
    let calls = 0;
    const plan = await createDirectorPlan(
      { prompt: "连续动作", targetDurationSec: 30 },
      {
        complete: async () => {
          calls += 1;
          return calls === 1
            ? json({ ...validPlan, packing: { clips: [{ kind: "generate", durationSec: 14 }] } })
            : json(validPlan);
        },
      },
    );

    expect(plan.targetDurationSec).toBe(30);
    expect(calls).toBe(2);
  });

  it("stops after three invalid outputs and does not accept unknown fields", async () => {
    let calls = 0;
    await expect(
      createDirectorPlan(
        { prompt: "无效规划", targetDurationSec: 45 },
        {
          complete: async () => {
            calls += 1;
            return json({ ...validPlan, targetDurationSec: 45, typo: true });
          },
        },
      ),
    ).rejects.toThrow("Director 输出无效");
    expect(calls).toBe(3);

    expect(() => directorPlanSchema.parse({ ...validPlan, typo: true })).toThrow();
  });

  it("rejects invalid director input before calling the model", async () => {
    let calls = 0;
    await expect(
      createDirectorPlan(
        { prompt: "", targetDurationSec: 31 as 30, language: "zh" },
        {
          complete: async () => {
            calls += 1;
            return json(validPlan);
          },
        },
      ),
    ).rejects.toThrow("Director 输入无效");
    expect(calls).toBe(0);
  });

  it("uses the configured local-compatible chat completion endpoint by default", async () => {
    const previousKey = process.env.SUB2API_API_KEY;
    const previousBase = process.env.XAI_BASE_URL;
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
          id: "chatcmpl-fixture",
          choices: [{ message: { role: "assistant", content: json(validPlan) } }],
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind");
    process.env.SUB2API_API_KEY = "fixture-key";
    process.env.XAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    try {
      const plan = await createDirectorPlan({ prompt: "本地协议测试", targetDurationSec: 30 });
      expect(plan.targetDurationSec).toBe(30);
      expect(requestPath).toBe("/v1/chat/completions");
      expect(requestBody?.model).toBe(DIRECTOR_MODEL);
      expect(requestBody?.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "lumen_harness_plan", strict: true },
      });
      expect(requestBody?.response_format).toMatchObject({
        json_schema: { schema: { type: "object", additionalProperties: false } },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previousKey === undefined) delete process.env.SUB2API_API_KEY;
      else process.env.SUB2API_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.XAI_BASE_URL;
      else process.env.XAI_BASE_URL = previousBase;
    }
  });
});
