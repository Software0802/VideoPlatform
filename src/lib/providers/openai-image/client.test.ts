import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiPost } from "./client";

/**
 * `normalizeImageUpstreamError` (client.ts): a relay's "no money left" answer comes back in
 * more than one shape, and it must always become the one code `switchAwayFromExhausted`
 * (jobs/runner.ts) looks for — `ProviderHttpError(429, "quota_exhausted")` — so the job gets
 * `markExhausted` + a same-request failover instead of either a dead-end 4xx failure or a
 * 15/30/60s backoff against a wall that will not move until someone tops up the account.
 *
 * Judged purely from the upstream response (status + `error.code`), independent of which
 * channel (OpenAI official / a compatible relay / YMan) is calling — these tests exercise the
 * default `OPENAI_IMAGE_CONFIG` channel via the exported `openaiPost`, which is the one call
 * every image submit actually makes and bills.
 */

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("openaiPost — upstream quota/credit exhaustion normalizes to 429 quota_exhausted", () => {
  it("maps a plain HTTP 402 to 429 quota_exhausted regardless of the error code it carries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-402");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "some_billing_code", message: "Your card was declined" } }, 402),
      ),
    );

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 429,
      code: "quota_exhausted",
    });
  });

  it("maps a 402 with no error envelope at all to 429 quota_exhausted", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-402-empty");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 402)));

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "quota_exhausted",
    });
  });

  it("maps a 429 whose error.code names insufficient_quota to 429 quota_exhausted", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-quota");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, 429),
      ),
    );

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "quota_exhausted",
    });
  });

  it("maps a 429 whose error.code names credits, case-insensitively, to 429 quota_exhausted", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-credits");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "INSUFFICIENT_CREDITS", message: "余额不足" } }, 429)),
    );

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "quota_exhausted",
    });
  });

  it("also matches on error.type when a relay names the quota condition there instead of error.code", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-type");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { type: "quota_exceeded", message: "no quota left" } }, 429)),
    );

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "quota_exhausted",
    });
  });

  it("leaves a real rate-limit 429 alone — no quota/credit wording anywhere in the code", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-ratelimit");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "rate_limit_exceeded", message: "Too many requests" } }, 429)),
    );

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
    });
  });

  it("leaves a plain HTTP 400 untouched — content-policy and other client errors are not quota exhaustion", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-400");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: "content_policy_violation", message: "Your request was rejected" } },
          400,
        ),
      ),
    );

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 400,
      code: "content_policy_violation",
    });
  });

  it("leaves an unrelated 5xx untouched — an upstream outage is not the account running out of money", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-500");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "internal error" } }, 500)));

    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.toMatchObject({
      status: 500,
    });
    await expect(openaiPost("/images/generations", { prompt: "p" })).rejects.not.toMatchObject({
      code: "quota_exhausted",
    });
  });

  it("never leaks the API key into the normalized error's message or stack", async () => {
    const key = "sk-should-not-leak-anywhere";
    vi.stubEnv("OPENAI_API_KEY", key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "insufficient_quota", message: "no money" } }, 402)),
    );

    let thrown: unknown;
    try {
      await openaiPost("/images/generations", { prompt: "p" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 429, code: "quota_exhausted" });
    const serialized = `${(thrown as Error).message} ${(thrown as Error).stack ?? ""}`;
    expect(serialized).not.toContain(key);
  });
});
