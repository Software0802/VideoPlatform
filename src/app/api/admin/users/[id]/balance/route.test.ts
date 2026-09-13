import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

/**
 * `POST /api/admin/users/[id]/balance`（R4.1，D-4=b）：`grant-balance.mjs`
 * 的 HTTP 形态。重点是令牌判据（无 XFF + loopback host + Bearer 匹配）与
 * 幂等语义仍走 `applyBalanceChange` 的同一条链。
 */

const TOKEN = "route-test-admin-token-0123456789";
const SECRET = "route-test-session-secret-0123456789";

let dataRoot = "";
let POST: typeof import("./route").POST;
let writeUser: typeof import("@/lib/users/store").writeUser;
let readUser: typeof import("@/lib/users/store").readUser;
let readLedger: typeof import("@/lib/billing/ledger").readLedger;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admin-balance-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_ADMIN_TOKEN = TOKEN;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ POST } = await import("./route"));
  ({ writeUser, readUser } = await import("@/lib/users/store"));
  ({ readLedger } = await import("@/lib/billing/ledger"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_ADMIN_TOKEN;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

let seq = 0;
async function seedUser(balanceCny = 0): Promise<UserRecord> {
  seq += 1;
  const id = `usr_${String(seq).padStart(16, "0")}`;
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function req(
  id: string,
  body: unknown,
  opts: { token?: string | null; host?: string; xff?: boolean } = {},
): { request: Request; ctx: { params: Promise<{ id: string }> } } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: opts.host ?? "127.0.0.1:3000",
  };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.xff) headers["x-forwarded-for"] = "1.2.3.4";
  return {
    request: new Request(`http://127.0.0.1:3000/api/admin/users/${encodeURIComponent(id)}/balance`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

describe("POST /api/admin/users/[id]/balance", () => {
  it("grants by user id and returns before/after balances", async () => {
    const user = await seedUser(10);
    const { request, ctx } = req(user.id, { amountCny: 20, note: "内测" });
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.beforeCny).toBe(10);
    expect(data.afterCny).toBe(30);
    expect(data.user.id).toBe(user.id);
    expect((await readUser(user.id))?.balanceCny).toBe(30);
  });

  it("finds the user by (url-encoded) email too", async () => {
    const user = await seedUser(1);
    const { request, ctx } = req(user.email, { amountCny: 4 });
    const res = await POST(request, ctx);
    expect(res.status).toBe(200);
    expect((await readUser(user.id))?.balanceCny).toBe(5);
  });

  it("401s without an Authorization header (no session cookie in these tests)", async () => {
    const user = await seedUser();
    const { request, ctx } = req(user.id, { amountCny: 5 }, { token: null });
    const res = await POST(request, ctx);
    expect(res.status).toBe(401);
    expect((await readUser(user.id))?.balanceCny).toBe(0);
  });

  it("401s a wrong token and a forwarded (non-direct) request", async () => {
    const user = await seedUser();
    const wrong = req(user.id, { amountCny: 5 }, { token: "nope" });
    expect((await POST(wrong.request, wrong.ctx)).status).toBe(401);
    const forwarded = req(user.id, { amountCny: 5 }, { xff: true });
    expect((await POST(forwarded.request, forwarded.ctx)).status).toBe(401);
    expect((await readUser(user.id))?.balanceCny).toBe(0);
  });

  it("400s on a body that fails the strict schema", async () => {
    const user = await seedUser();
    for (const body of [{}, { amountCny: "5" }, { amountCny: 5, extra: true }, { amountCny: 0 }]) {
      const { request, ctx } = req(user.id, body);
      expect((await POST(request, ctx)).status).toBe(400);
    }
  });

  it("404s a user id/email that does not exist", async () => {
    const { request, ctx } = req("usr_ffffffffffffffff", { amountCny: 5 });
    const res = await POST(request, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("replays the same ref without double-counting, and 409s a ref reused with different input", async () => {
    const user = await seedUser(3);
    const first = req(user.id, { amountCny: 7, ref: "grant-1" });
    const r1 = await POST(first.request, first.ctx);
    expect(r1.status).toBe(200);
    const d1 = await r1.json();
    expect(d1.afterCny).toBe(10);

    const replay = req(user.id, { amountCny: 7, ref: "grant-1" });
    const r2 = await POST(replay.request, replay.ctx);
    expect(r2.status).toBe(200);
    const d2 = await r2.json();
    expect(d2.afterCny).toBe(10);
    expect((await readUser(user.id))?.balanceCny).toBe(10);
    expect((await readLedger(user.id)).entries).toHaveLength(1);

    const conflict = req(user.id, { amountCny: 8, ref: "grant-1" });
    const r3 = await POST(conflict.request, conflict.ctx);
    expect(r3.status).toBe(409);
    expect((await r3.json()).error.code).toBe("billing_idempotency_conflict");
  });
});
