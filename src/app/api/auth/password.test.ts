import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `POST /api/auth/password`（方案 §3.4「账号闭环」）：旧密码校验、成功后旧 Cookie 失效 /
 * 新 Cookie 有效（`sessionEpoch` 递增，走 `changeUserPasswordWithCurrent`），以及自己的
 * 限流桶（5 次/分钟，比登录更紧）。
 *
 * 路由文件在 `./password/route.ts`（Next App Router 的目录即路由段），这份测试与
 * `media-route.test.ts` 同样的做法——测试文件放在父目录，用相对子路径 import 路由。
 */

const SESSION_SECRET = "auth-password-test-secret-0123456789";

let dataRoot = "";
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;
let resetRateLimits: typeof import("@/lib/users/rate-limit").resetRateLimits;
let POST: typeof import("./password/route").POST;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-auth-password-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  ({ writeUser, readUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
  ({ resetRateLimits } = await import("@/lib/users/rate-limit"));
  ({ POST } = await import("./password/route"));
});

beforeEach(() => {
  // The rate-limit bucket is a process-global map keyed by (action, ip, user); every
  // request in this file shares the same "unknown" ip (no x-forwarded-for header), so
  // without a reset the tests above the rate-limit test would themselves start tripping
  // 429 once their combined call count crosses PASSWORD_RATE_LIMIT.
  resetRateLimits();
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

/** USER_ID_RE requires usr_ + exactly 16 lowercase-hex chars, so an arbitrary tag
 * (letters like "p" are not hex digits) can't just be padded — hex-encode it. */
function userId(tag: string): string {
  return `usr_${Buffer.from(tag, "utf8").toString("hex").padStart(16, "0").slice(-16)}`;
}

async function seedUser(tag: string, password = "hunter2-hunter2") {
  const { hashPassword } = await import("@/lib/users/password");
  const id = userId(tag);
  const user = await writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: await hashPassword(password),
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { user, password };
}

/** Builds the request and actually invokes the route handler, returning its Response. */
async function send(cookieValue: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/auth/password", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${cookieValue}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

function setCookieValue(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (!match) throw new Error(`no ${SESSION_COOKIE} in Set-Cookie: ${raw}`);
  return match[1];
}

describe("POST /api/auth/password", () => {
  it("401s invalid_credentials for the wrong current password, and changes nothing", async () => {
    const { user, password } = await seedUser("p1");
    const cookie = issueSessionValue(user);

    const res = await send(cookie, { currentPassword: "totally-wrong-pw", newPassword: "new-password-999" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_credentials");

    // Nothing rotated: the same old cookie, with the same original password, still works.
    const retry = await send(cookie, { currentPassword: password, newPassword: "new-password-999" });
    expect(retry.status).toBe(200);
  });

  it("on success: rotates sessionEpoch so the old cookie 401s, and the new cookie in Set-Cookie authenticates", async () => {
    const { user, password } = await seedUser("p2");
    const oldCookie = issueSessionValue(user);

    const res = await send(oldCookie, { currentPassword: password, newPassword: "brand-new-password-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stored = await readUser(user.id);
    expect(stored?.sessionEpoch).toBe(user.sessionEpoch + 1);

    // Old cookie: sessionEpoch no longer matches -> requireUser rejects with 401.
    const withOldCookie = await send(oldCookie, {
      currentPassword: "brand-new-password-1",
      newPassword: "yet-another-password-2",
    });
    expect(withOldCookie.status).toBe(401);

    // New cookie from Set-Cookie: authenticates fine (using the now-current password).
    const newCookie = setCookieValue(res);
    const withNewCookie = await send(newCookie, {
      currentPassword: "brand-new-password-1",
      newPassword: "yet-another-password-2",
    });
    expect(withNewCookie.status).toBe(200);
  });

  it("401s an unauthenticated request (no session cookie)", async () => {
    const bare = new Request("http://localhost/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "x", newPassword: "new-password-999" }),
    });
    expect((await POST(bare)).status).toBe(401);
  });

  it("400s a new password shorter than 8 characters, and a missing field", async () => {
    const { user, password } = await seedUser("p3");
    const cookie = issueSessionValue(user);

    expect((await send(cookie, { currentPassword: password, newPassword: "short" })).status).toBe(400);
    expect((await send(cookie, { newPassword: "new-password-999" })).status).toBe(400);
  });

  it("400s an unknown extra field (strict schema)", async () => {
    const { user, password } = await seedUser("p4");
    const cookie = issueSessionValue(user);
    const res = await send(cookie, {
      currentPassword: password,
      newPassword: "new-password-999",
      extra: "nope",
    });
    expect(res.status).toBe(400);
  });

  it("429s rate_limited after 5 attempts in a minute for the same account", async () => {
    const { user } = await seedUser("p5");
    const cookie = issueSessionValue(user);

    let last: Response | undefined;
    for (let i = 0; i < 6; i += 1) {
      // Wrong current password each time: failures still consume the bucket (the gate
      // runs before the credential check), and this keeps sessionEpoch from rotating
      // mid-loop, which would otherwise 401 the cookie for an unrelated reason.
      last = await send(cookie, { currentPassword: "wrong-on-purpose", newPassword: "new-password-999" });
    }
    expect(last?.status).toBe(429);
    expect(((await last!.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });
});
