import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * `POST /api/admin/users/[id]/password`（R4.1）：`reset-password.mjs` 的
 * HTTP 形态——新口令只回在响应体里一次，sessionEpoch 递增让全设备掉线。
 */

const TOKEN = "route-test-admin-token-0123456789";
const SECRET = "route-test-session-secret-0123456789";

let dataRoot = "";
let POST: typeof import("./route").POST;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;
let verifyPassword: typeof import("@/lib/users/password").verifyPassword;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admin-password-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_ADMIN_TOKEN = TOKEN;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ POST } = await import("./route"));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
  ({ verifyPassword } = await import("@/lib/users/password"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_ADMIN_TOKEN;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

let seq = 0;
async function seedUser(): Promise<UserRecord> {
  seq += 1;
  const id = `usr_${String(seq).padStart(16, "0")}`;
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function req(
  id: string,
  body: unknown,
  opts: { token?: string | null } = {},
): { request: Request; ctx: { params: Promise<{ id: string }> } } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "127.0.0.1:3000",
  };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return {
    request: new Request(`http://127.0.0.1:3000/api/admin/users/${encodeURIComponent(id)}/password`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

describe("POST /api/admin/users/[id]/password", () => {
  it("generates a password, stores a valid hash, and bumps sessionEpoch", async () => {
    const user = await seedUser();
    const { request, ctx } = req(user.id, {});
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.password).toBe("string");
    expect(data.password.length).toBeGreaterThanOrEqual(12);
    const next = await readUser(user.id);
    expect(next?.sessionEpoch).toBe(2);
    expect(await verifyPassword(data.password, next!.passwordHash)).toBe(true);
  });

  it("accepts an explicit password", async () => {
    const user = await seedUser();
    const { request, ctx } = req(user.email, { password: "chosen-pass-123" });
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);
    const next = await readUser(user.id);
    expect(await verifyPassword("chosen-pass-123", next!.passwordHash)).toBe(true);
  });

  it("401s without the token, 404s unknown users, 400s bad bodies", async () => {
    const user = await seedUser();
    const noAuth = req(user.id, {}, { token: null });
    expect((await POST(noAuth.request, noAuth.ctx)).status).toBe(401);

    const missing = req("nobody@example.com", {});
    expect((await POST(missing.request, missing.ctx)).status).toBe(404);

    for (const body of [{ password: "short" }, { password: 123 }, { wat: true }]) {
      const bad = req(user.id, body);
      expect((await POST(bad.request, bad.ctx)).status).toBe(400);
    }
    // 上面的 400/401/404 都不该动到记录。
    expect((await readUser(user.id))?.sessionEpoch).toBe(1);
  });
});
