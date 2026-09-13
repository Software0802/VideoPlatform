import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVITE_CODE_RE } from "@/lib/users/schema";

/**
 * `POST /api/admin/invites`（R4.1）：`mint-invites.mjs` 的 HTTP 形态。
 * 码只出现在响应体里；令牌判据同其余管理路由（无 XFF + loopback + Bearer）。
 */

const TOKEN = "route-test-admin-token-0123456789";
const SECRET = "route-test-session-secret-0123456789";

let dataRoot = "";
let POST: typeof import("./route").POST;
let readInvite: typeof import("@/lib/users/invites").readInvite;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admin-invites-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_ADMIN_TOKEN = TOKEN;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ POST } = await import("./route"));
  ({ readInvite } = await import("@/lib/users/invites"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_ADMIN_TOKEN;
  delete process.env.LUMEN_SESSION_SECRET;
  await rm(dataRoot, { recursive: true, force: true });
});

function req(body: unknown, opts: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "127.0.0.1:3000",
  };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return new Request("http://127.0.0.1:3000/api/admin/invites", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/invites", () => {
  it("mints the requested count of usable invites", async () => {
    const res = await POST(req({ count: 3, note: "第一批" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.codes).toHaveLength(3);
    for (const code of data.codes) {
      expect(code).toMatch(INVITE_CODE_RE);
      const invite = await readInvite(code);
      expect(invite?.note).toBe("第一批");
      expect(invite?.usedBy).toBeUndefined();
    }
  });

  it("defaults count to 1", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(201);
    expect((await res.json()).codes).toHaveLength(1);
  });

  it("401s without the token and 400s bad bodies", async () => {
    expect((await POST(req({ count: 1 }, { token: null }))).status).toBe(401);
    expect((await POST(req({ count: 1 }, { token: "nope" }))).status).toBe(401);
    for (const body of [{ count: 0 }, { count: 501 }, { count: 1.5 }, { count: 1, extra: 1 }]) {
      expect((await POST(req(body))).status).toBe(400);
    }
  });
});
