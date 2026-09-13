import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVITE_CODE_RE } from "@/lib/users/schema";

/**
 * `POST /api/admin/gift-codes`（R4.1）：`mint-gift-codes.mjs` 的 HTTP 形态。
 * 一张码就是一笔钱——只出现在响应体里，不进日志。
 */

const TOKEN = "route-test-admin-token-0123456789";
const SECRET = "route-test-session-secret-0123456789";

let dataRoot = "";
let POST: typeof import("./route").POST;
let readGiftCode: typeof import("@/lib/users/gift-codes").readGiftCode;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admin-gift-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_ADMIN_TOKEN = TOKEN;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ POST } = await import("./route"));
  ({ readGiftCode } = await import("@/lib/users/gift-codes"));
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
  return new Request("http://127.0.0.1:3000/api/admin/gift-codes", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/gift-codes", () => {
  it("mints codes carrying the requested face value", async () => {
    const res = await POST(req({ count: 2, amountCny: 20, note: "十一" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.codes).toHaveLength(2);
    expect(data.amountCny).toBe(20);
    for (const code of data.codes) {
      expect(code).toMatch(INVITE_CODE_RE);
      const record = await readGiftCode(code);
      expect(record?.amountCny).toBe(20);
      expect(record?.note).toBe("十一");
    }
  });

  it("401s without the token and 400s bad bodies", async () => {
    expect((await POST(req({ count: 1, amountCny: 5 }, { token: null }))).status).toBe(401);
    for (const body of [
      {},
      { count: 1 },
      { amountCny: 5 },
      { count: 1, amountCny: 0 },
      { count: 1, amountCny: 100001 },
      { count: 1, amountCny: 5, extra: 1 },
    ]) {
      expect((await POST(req(body))).status).toBe(400);
    }
  });
});
