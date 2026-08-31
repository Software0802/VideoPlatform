import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE, isAuthorized, presentedToken, tokensEqual } from "./auth";

afterEach(() => {
  delete process.env.LUMEN_ACCESS_TOKEN;
});

describe("tokensEqual", () => {
  it("rejects length mismatch", () => {
    expect(tokensEqual("ab", "abc")).toBe(false);
  });
  it("accepts exact match", () => {
    expect(tokensEqual("secret", "secret")).toBe(true);
  });
});

describe("isAuthorized", () => {
  it("allows all traffic when token is unset", () => {
    expect(isAuthorized(new Request("http://localhost/api/jobs"))).toBe(true);
  });

  it("accepts Bearer and cookie", () => {
    process.env.LUMEN_ACCESS_TOKEN = "gate-1";
    const bearer = new Request("http://localhost/api/jobs", {
      headers: { authorization: "Bearer gate-1" },
    });
    const cookie = new Request("http://localhost/api/jobs", {
      headers: { cookie: `${ACCESS_COOKIE}=gate-1` },
    });
    const bad = new Request("http://localhost/api/jobs", {
      headers: { authorization: "Bearer nope" },
    });
    expect(isAuthorized(bearer)).toBe(true);
    expect(isAuthorized(cookie)).toBe(true);
    expect(isAuthorized(bad)).toBe(false);
    expect(presentedToken(bearer)).toBe("gate-1");
  });
});
