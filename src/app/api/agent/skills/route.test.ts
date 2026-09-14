import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRecord } from "@/lib/users/schema";

const SESSION_SECRET = "agent-skills-route-test-secret-0123456789";

let dataRoot = "";
let GET: typeof import("./route").GET;
let PATCH: typeof import("./route").PATCH;
let writeUser: typeof import("@/lib/users/store").writeUser;
let SESSION_COOKIE: string;
let issueSessionValue: typeof import("@/lib/users/session").issueSessionValue;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-agent-skills-route-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SESSION_SECRET;
  process.env.LUMEN_FORCE_MOCK = "1";
  ({ GET, PATCH } = await import("./route"));
  ({ writeUser } = await import("@/lib/users/store"));
  ({ SESSION_COOKIE, issueSessionValue } = await import("@/lib/users/session"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  delete process.env.LUMEN_FORCE_MOCK;
  await rm(dataRoot, { recursive: true, force: true });
});

async function seedUser(id: string): Promise<UserRecord> {
  const now = new Date().toISOString();
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "scrypt$16384$8$1$00$00",
    sessionEpoch: 1,
    plan: "free",
    balanceCny: 10,
    createdAt: now,
    updatedAt: now,
  });
}

function request(user?: UserRecord, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.cookie = `${SESSION_COOKIE}=${issueSessionValue(user)}`;
  return new Request("http://localhost/api/agent/skills", {
    method: body === undefined ? "GET" : "PATCH",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/agent/skills prefs", () => {
  it("GET includes the account's off list", async () => {
    const user = await seedUser("usr_0000000000000301");
    const response = await GET(request(user));
    expect(response.status).toBe(200);
    expect((await response.json()).off).toEqual([]);
  });

  it("rejects unknown skill ids and strict-body extras", async () => {
    const user = await seedUser("usr_0000000000000302");
    expect((await PATCH(request(user, { skillId: "not-a-skill", off: true }))).status).toBe(400);
    expect(
      (await PATCH(request(user, { skillId: "car-ad", off: true, extra: true }))).status,
    ).toBe(400);
  });

  it("PATCH persists and the next GET reflects it", async () => {
    const user = await seedUser("usr_0000000000000303");
    const patched = await PATCH(request(user, { skillId: "car-ad", off: true }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).off).toEqual(["car-ad"]);

    const listed = await GET(request(user));
    expect((await listed.json()).off).toEqual(["car-ad"]);
  });

  it("requires a session for GET and PATCH", async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await PATCH(request(undefined, { skillId: "car-ad", off: true }))).status).toBe(401);
  });
});
