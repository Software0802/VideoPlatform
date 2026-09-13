import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/admin/alerts/test`（R7）：真实触发一条 `test` 告警。
 * webhook 外发用 stub 的 fetch 观察；令牌判据同其余管理路由。
 */

const TOKEN = "route-test-admin-token-0123456789";
const SECRET = "route-test-session-secret-0123456789";
const HOOK = "https://hooks.example.test/robot";

let dataRoot = "";
let POST: typeof import("./route").POST;
let resetAlertDedupe: typeof import("@/lib/alerts").resetAlertDedupe;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-admin-alerts-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_ADMIN_TOKEN = TOKEN;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  ({ POST } = await import("./route"));
  ({ resetAlertDedupe } = await import("@/lib/alerts"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_ADMIN_TOKEN;
  delete process.env.LUMEN_SESSION_SECRET;
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_WEBHOOK_FORMAT;
  await rm(dataRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAlertDedupe();
});

function req(body: unknown, opts: { token?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "127.0.0.1:3000",
  };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return new Request("http://127.0.0.1:3000/api/admin/alerts/test", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/alerts/test", () => {
  it("令牌成功：2xx 回显 sent=true 与 format，外发正文是渠道形状", async () => {
    process.env.ALERT_WEBHOOK_URL = HOOK;
    process.env.ALERT_WEBHOOK_FORMAT = "wecom";
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(req({ note: "上线验证" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, format: "wecom" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(HOOK);
    const body = JSON.parse(init.body);
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("[Lumen] test");
    expect(body.text.content).toContain("note: 上线验证");
    expect(body.text.content).toContain("actor: admin-token");
  });

  it("webhook 未配置或拒绝时 sent=false 但仍是 200", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    process.env.ALERT_WEBHOOK_FORMAT = "generic";
    const res = await POST(req({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, format: "generic" });

    process.env.ALERT_WEBHOOK_URL = HOOK;
    const fetchMock = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const res2 = await POST(req({}));
    expect(res2.status).toBe(200);
    expect((await res2.json()).sent).toBe(false);
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it("401s without/错令牌，400s 非法 body", async () => {
    expect((await POST(req({}, { token: null }))).status).toBe(401);
    expect((await POST(req({}, { token: "nope" }))).status).toBe(401);
    for (const body of [{ note: "" }, { note: 1 }, { extra: true }]) {
      expect((await POST(req(body))).status).toBe(400);
    }
  });
});
