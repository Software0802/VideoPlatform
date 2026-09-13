import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * `src/proxy.ts`（方案 §3.2「安全收口」）：会话签名门（既有行为）+ 两件新事——每个请求
 * 打 `x-request-id`，以及对一切会改变状态的请求做同源校验（`Origin`/`Referer` 与
 * `x-forwarded-host`/`host` 比对，不匹配 403 `bad_origin`）。
 *
 * proxy 本身是 I/O-free 的纯函数（只验签名，不读 `user.json`），所以这里全程不碰磁盘——
 * 一个内存里签好的 `UserRecord` 字面量就够构造一张能通过签名校验的 Cookie。
 */

const SECRET = "proxy-test-session-secret-0123456789";
let proxy: typeof import("./proxy").proxy;
let issueSessionValue: typeof import("@/lib/users/session-token").issueSessionValue;
let SESSION_COOKIE: string;

const USER = {
  id: "usr_00000000000000a1",
  email: "proxy-test@example.com",
  passwordHash: "hash",
  sessionEpoch: 1,
  plan: "free",
  balanceCny: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as UserRecord;

beforeAll(async () => {
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ proxy } = await import("./proxy"));
  ({ issueSessionValue, SESSION_COOKIE } = await import("@/lib/users/session-token"));
});

afterAll(() => {
  delete process.env.LUMEN_SESSION_SECRET;
});

function validCookie(): string {
  return `${SESSION_COOKIE}=${issueSessionValue(USER)}`;
}

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; authed?: boolean } = {},
): NextRequest {
  const headers = new Headers(opts.headers ?? {});
  if (opts.authed) headers.set("cookie", validCookie());
  return new NextRequest(`http://localhost:3000${path}`, { method: opts.method ?? "GET", headers });
}

describe("session gate (existing behavior)", () => {
  it("401s a protected path with no cookie at all", async () => {
    const res = proxy(req("/api/jobs"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("401s a protected path whose cookie fails signature verification", async () => {
    const res = proxy(req("/api/jobs", { headers: { cookie: `${SESSION_COOKIE}=garbage.not.a.token` } }));
    expect(res.status).toBe(401);
  });

  it("passes a protected path with a validly signed cookie", async () => {
    const res = proxy(req("/api/jobs", { authed: true }));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it.each(["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/health"])(
    "lets %s through with no cookie at all",
    (path) => {
      const res = proxy(req(path));
      expect(res.status).not.toBe(401);
    },
  );

  it("still requires a cookie for /api/me, which is not in the public list", async () => {
    const res = proxy(req("/api/me"));
    expect(res.status).toBe(401);
  });

  it("treats a trailing slash the same as the bare path for the public list", () => {
    const res = proxy(req("/api/health/"));
    expect(res.status).not.toBe(401);
  });
});

describe("x-request-id", () => {
  it("stamps a response header shaped like 8 lowercase hex chars on a passing request", () => {
    const res = proxy(req("/api/health"));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("still stamps a request id on a 401 refusal", () => {
    const res = proxy(req("/api/jobs"));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("still stamps a request id on a 403 bad_origin refusal", () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: { origin: "https://evil.example.com", "x-forwarded-host": "localhost:3000" },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("generates a fresh id rather than trusting one the client already sent", () => {
    const res = proxy(req("/api/health", { headers: { "x-request-id": "deadbeef" } }));
    // proxy.ts always calls newRequestId() unconditionally — a client-supplied id must
    // never be the one that ends up in the logs (it would let a caller write arbitrary
    // strings into structured logs, or collide with another request's real id).
    expect(res.headers.get("x-request-id")).not.toBe("deadbeef");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("same-origin check on non-GET requests", () => {
  it("never checks Origin on a safe method (GET/HEAD/OPTIONS), even with a hostile Origin", () => {
    const res = proxy(
      req("/api/jobs", {
        method: "GET",
        authed: true,
        headers: { origin: "https://evil.example.com", "x-forwarded-host": "localhost:3000" },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("passes when Origin's host matches x-forwarded-host (the real deployment: behind Caddy)", () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: { origin: "https://genius.example.com", "x-forwarded-host": "genius.example.com" },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("403s bad_origin when Origin's host does not match x-forwarded-host", async () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: { origin: "https://evil.example.com", "x-forwarded-host": "genius.example.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("bad_origin");
  });

  it("prefers x-forwarded-host over a mismatching raw Host header (proxy hop must win)", () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: {
          origin: "https://genius.example.com",
          host: "127.0.0.1:3000",
          "x-forwarded-host": "genius.example.com",
        },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("403s an opaque Origin: null (e.g. a sandboxed iframe), never treating it as a pass", async () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: { origin: "null", "x-forwarded-host": "localhost:3000" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows a non-GET request with neither Origin nor Referer (deploy scripts, curl — no CSRF exposure)", () => {
    const res = proxy(req("/api/jobs", { method: "POST", authed: true, headers: { "x-forwarded-host": "localhost:3000" } }));
    expect(res.status).not.toBe(403);
  });

  it("falls back to Referer's host when Origin is absent", async () => {
    const blocked = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: { referer: "https://evil.example.com/page", "x-forwarded-host": "genius.example.com" },
      }),
    );
    expect(blocked.status).toBe(403);

    const allowed = proxy(
      req("/api/jobs", {
        method: "POST",
        authed: true,
        headers: { referer: "https://genius.example.com/studio", "x-forwarded-host": "genius.example.com" },
      }),
    );
    expect(allowed.status).not.toBe(403);
  });

  it("checks Origin before the session cookie: a bad-origin POST 403s even with no cookie at all", async () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        headers: { origin: "https://evil.example.com", "x-forwarded-host": "genius.example.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("bad_origin");
  });

  it("still enforces the session gate once Origin passes", () => {
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        headers: { origin: "https://genius.example.com", "x-forwarded-host": "genius.example.com" },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("admin token (R4.1: loopback-only bearer for /api/admin/*)", () => {
  const TOKEN = "test-admin-token-0123456789abcdef";

  function adminPost(headers: Record<string, string>): NextRequest {
    return req("/api/admin/invites", { method: "POST", headers });
  }

  afterEach(() => {
    delete process.env.LUMEN_ADMIN_TOKEN;
  });

  it("passes /api/admin/* with no cookie when the token matches on a loopback direct hit", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(adminPost({ authorization: `Bearer ${TOKEN}`, host: "127.0.0.1:3000" }));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("accepts localhost as the loopback host too", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(adminPost({ authorization: `Bearer ${TOKEN}`, host: "localhost:3000" }));
    expect(res.status).not.toBe(401);
  });

  it("401s the right token once x-forwarded-for carries a non-loopback hop (the request came through a proxy)", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(
      adminPost({
        authorization: `Bearer ${TOKEN}`,
        host: "127.0.0.1:3000",
        "x-forwarded-for": "1.2.3.4",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts an all-loopback XFF chain (next dev injects ::ffff:127.0.0.1 for direct hits)", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    for (const xff of ["127.0.0.1", "::ffff:127.0.0.1", "::1", "127.0.0.1, ::ffff:127.0.0.1"]) {
      const res = proxy(
        adminPost({
          authorization: `Bearer ${TOKEN}`,
          host: "127.0.0.1:3000",
          "x-forwarded-for": xff,
        }),
      );
      expect(res.status, `xff=${xff}`).not.toBe(401);
    }
  });

  it("401s a mixed XFF chain whose tail is loopback (spoofed suffix must not pass)", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(
      adminPost({
        authorization: `Bearer ${TOKEN}`,
        host: "127.0.0.1:3000",
        "x-forwarded-for": "1.2.3.4, 127.0.0.1",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401s the right token on a non-loopback host", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(adminPost({ authorization: `Bearer ${TOKEN}`, host: "genius.example.com" }));
    expect(res.status).toBe(401);
  });

  it("401s a wrong token even on loopback", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(adminPost({ authorization: "Bearer wrong-token", host: "127.0.0.1:3000" }));
    expect(res.status).toBe(401);
  });

  it("401s when no token is configured at all", () => {
    delete process.env.LUMEN_ADMIN_TOKEN;
    const res = proxy(adminPost({ authorization: "Bearer anything", host: "127.0.0.1:3000" }));
    expect(res.status).toBe(401);
  });

  it("does not bypass the session gate outside /api/admin/*", () => {
    process.env.LUMEN_ADMIN_TOKEN = TOKEN;
    const res = proxy(
      req("/api/jobs", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1:3000" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("a valid session cookie still reaches /api/admin/* without any token", () => {
    const res = proxy(req("/api/admin/relays", { authed: true }));
    expect(res.status).not.toBe(401);
  });
});
