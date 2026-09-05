import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW_MS,
  authRateKeys,
  clientIp,
  consumeRateLimit,
  resetRateLimits,
} from "./rate-limit";

beforeEach(() => {
  resetRateLimits();
});

describe("auth rate limit", () => {
  it("allows the first 10 attempts in a minute and blocks the 11th", () => {
    const now = 1_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      expect(consumeRateLimit(["login:ip:1.2.3.4"], { now: now + i }).allowed).toBe(true);
    }
    const blocked = consumeRateLimit(["login:ip:1.2.3.4"], { now: now + AUTH_RATE_LIMIT });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(AUTH_RATE_WINDOW_MS / 1000);
  });

  it("lets the window slide", () => {
    const now = 2_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      consumeRateLimit(["login:ip:5.6.7.8"], { now });
    }
    expect(consumeRateLimit(["login:ip:5.6.7.8"], { now }).allowed).toBe(false);
    expect(
      consumeRateLimit(["login:ip:5.6.7.8"], { now: now + AUTH_RATE_WINDOW_MS + 1 }).allowed,
    ).toBe(true);
  });

  it("keeps a rejected attempt from extending the lockout", () => {
    const now = 3_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) consumeRateLimit(["k"], { now });
    // Hammering during the window must not push the reset time out.
    for (let i = 0; i < 50; i += 1) {
      consumeRateLimit(["k"], { now: now + AUTH_RATE_WINDOW_MS - 10 });
    }
    expect(consumeRateLimit(["k"], { now: now + AUTH_RATE_WINDOW_MS + 1 }).allowed).toBe(true);
  });

  it("gives the address and the account independent budgets", () => {
    const now = 4_000_000;
    // One IP exhausts its budget across ten different accounts …
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      expect(
        consumeRateLimit(["login:ip:9.9.9.9", `login:email:user${i}@example.com`], { now })
          .allowed,
      ).toBe(true);
    }
    expect(
      consumeRateLimit(["login:ip:9.9.9.9", "login:email:fresh@example.com"], { now }).allowed,
    ).toBe(false);
    // … while a different address can still reach an account it has not hit.
    expect(
      consumeRateLimit(["login:ip:9.9.9.10", "login:email:fresh@example.com"], { now }).allowed,
    ).toBe(true);
  });

  it("counts a blocked attempt against neither key", () => {
    const now = 5_000_000;
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      consumeRateLimit(["login:ip:7.7.7.7"], { now });
    }
    // Blocked by the IP key; the email key must stay untouched.
    expect(
      consumeRateLimit(["login:ip:7.7.7.7", "login:email:spare@example.com"], { now }).allowed,
    ).toBe(false);
    expect(
      consumeRateLimit(["login:ip:8.8.8.8", "login:email:spare@example.com"], { now }).allowed,
    ).toBe(true);
  });

  it("separates login from register and derives keys from the request", () => {
    const request = new Request("http://localhost/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
    expect(authRateKeys(request, "login", "a@example.com")).toEqual([
      "login:ip:203.0.113.7",
      "login:email:a@example.com",
    ]);
    expect(authRateKeys(request, "register", "a@example.com")[0]).toBe("register:ip:203.0.113.7");
    expect(clientIp(new Request("http://localhost/api/auth/login"))).toBe("unknown");
  });
});
