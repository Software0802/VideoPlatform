import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * `POST /api/admin/users/[id]/disabled`（R4.1）：`disable-user.mjs` 的
 * HTTP 形态——停用与恢复都递增 `sessionEpoch`；恢复时删掉 `disabled` 字段。
 */

const TOKEN = "route-test-admin-token-0123456789";
const SECRET = "route-test-session-secret-0123456789";

let dataRoot = "";
let POST: typeof import("./route").POST;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admin-disabled-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_ADMIN_TOKEN = TOKEN;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ POST } = await import("./route"));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
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
    request: new Request(`http://127.0.0.1:3000/api/admin/users/${encodeURIComponent(id)}/disabled`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

describe("POST /api/admin/users/[id]/disabled", () => {
  it("disables and re-enables, bumping sessionEpoch and deleting the flag on re-enable", async () => {
    const user = await seedUser();

    const off = req(user.id, { disabled: true });
    const r1 = await POST(off.request, off.ctx);
    expect(r1.status).toBe(200);
    const d1 = await r1.json();
    expect(d1).toMatchObject({ disabled: true, sessionEpoch: 2, noop: false });
    expect((await readUser(user.id))?.disabled).toBe(true);

    const again = req(user.id, { disabled: true });
    const r2 = await POST(again.request, again.ctx);
    const d2 = await r2.json();
    expect(d2.noop).toBe(true);
    expect(d2.sessionEpoch).toBe(3);

    const on = req(user.id, { disabled: false });
    const r3 = await POST(on.request, on.ctx);
    const d3 = await r3.json();
    expect(d3.disabled).toBe(false);
    expect((await readUser(user.id))?.disabled).toBeUndefined();
    expect(d3.sessionEpoch).toBe(4);
  });

  it("401s without the token, 404s unknown users, 400s bad bodies", async () => {
    const user = await seedUser();
    const noAuth = req(user.id, { disabled: true }, { token: null });
    expect((await POST(noAuth.request, noAuth.ctx)).status).toBe(401);

    const missing = req("usr_ffffffffffffffff", { disabled: true });
    expect((await POST(missing.request, missing.ctx)).status).toBe(404);

    for (const body of [{}, { disabled: "yes" }, { disabled: true, extra: 1 }]) {
      const bad = req(user.id, body);
      expect((await POST(bad.request, bad.ctx)).status).toBe(400);
    }
    expect((await readUser(user.id))?.sessionEpoch).toBe(1);
  });
});
