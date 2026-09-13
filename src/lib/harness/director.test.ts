import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createDirectorPlan,
  directorModel,
  directorPlanSchema,
  type DirectorCompletionRequest,
} from "./director";

const validPlan = {
  targetDurationSec: 30,
  packing: {
    clips: [
      { kind: "generate", durationSec: 10 },
      { kind: "generate", durationSec: 10 },
      { kind: "generate", durationSec: 10 },
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
      durationSec: 10,
      prompt: "林在雨夜走向旧电影院，镜头平稳跟拍。",
      characterIds: ["char_main"],
      locationId: "loc_cinema",
      route: "t2v",
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
      route: "i2v",
      continuity: "tail_chain",
      generateAudio: false,
    },
    {
      id: "shot_2",
      index: 2,
      durationSec: 10,
      prompt: "林停在银幕前回望，暖色灯光落在脸上。",
      characterIds: ["char_main"],
      locationId: "loc_cinema",
      route: "i2v",
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
  it("requests a JSON object with the schema in the system prompt and parses a valid plan", async () => {
    const requests: DirectorCompletionRequest[] = [];
    const plan = await createDirectorPlan(
      { prompt: "雨夜电影院的连续短片", targetDurationSec: 30, language: "zh" },
      {
        complete: async (request) => {
          requests.push(request);
          expect(request.responseFormat).toEqual({ type: "json_object" });
          expect(request.messages[0]?.role).toBe("system");
          expect(request.messages[0]?.content).toContain('"targetDurationSec"');
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

  it("wraps upstream timeout/error into HarnessFailure llm_upstream_failed — retryable, not internal", async () => {
    let calls = 0;
    await expect(
      createDirectorPlan(
        { prompt: "连续动作", targetDurationSec: 30 },
        {
          complete: async () => {
            calls += 1;
            throw new Error("Request timed out.");
          },
        },
      ),
    ).rejects.toMatchObject({ name: "HarnessFailure", code: "llm_upstream_failed" });
    // 上游传输错误不重发：补一次调用就是再付一次模型费。
    expect(calls).toBe(1);
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

  it("uses the configured agent chat completion endpoint by default", async () => {
    const previousKey = process.env.AGENT_API_KEY;
    const previousBase = process.env.AGENT_BASE_URL;
    const previousModel = process.env.AGENT_CHAT_MODEL;
    const previousMock = process.env.LUMEN_FORCE_MOCK;
    const previousXai = process.env.XAI_API_KEY;
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
    process.env.AGENT_API_KEY = "fixture-key";
    process.env.AGENT_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    delete process.env.AGENT_CHAT_MODEL;
    delete process.env.LUMEN_FORCE_MOCK;
    // 没有任何 key 时 isMockMode() 为真、agent 配置落 mock；塞一把让实例脱离 mock。
    process.env.XAI_API_KEY = "fixture-xai";
    try {
      const plan = await createDirectorPlan({ prompt: "本地协议测试", targetDurationSec: 30 });
      expect(plan.targetDurationSec).toBe(30);
      expect(requestPath).toBe("/v1/chat/completions");
      expect(requestBody?.model).toBe(directorModel());
      expect(requestBody?.response_format).toEqual({ type: "json_object" });
      // Schema 文本走 system prompt（json_object 通道不携带结构化字段）。
      const system = (requestBody as { messages: { role: string; content: string }[] }).messages[0].content;
      expect(system).toContain('"targetDurationSec"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (previousKey === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.AGENT_BASE_URL;
      else process.env.AGENT_BASE_URL = previousBase;
      if (previousModel === undefined) delete process.env.AGENT_CHAT_MODEL;
      else process.env.AGENT_CHAT_MODEL = previousModel;
      if (previousMock === undefined) delete process.env.LUMEN_FORCE_MOCK;
      else process.env.LUMEN_FORCE_MOCK = previousMock;
      if (previousXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousXai;
    }
  });
});
