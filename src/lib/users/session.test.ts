import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "./password";
import type { UserRecord } from "./schema";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  assertSessionSecret,
  issueSessionValue,
  sessionUser,
  signSession,
  verifySessionValue,
} from "./session";
import { resetUserIndexCache, writeUser } from "./store";

const SECRET = "unit-test-session-secret-0123456789";
const OTHER_ID = "usr_ffffffffffffffff";
let dataRoot = "";
let user: UserRecord;

function request(value: string): Request {
  return new Request("http://localhost/api/me", {
    headers: { cookie: `${SESSION_COOKIE}=${value}` },
  });
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-session-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = SECRET;
  resetUserIndexCache();
  user = await writeUser({
    id: "usr_00112233445566aa",
    email: "session@example.com",
    passwordHash: await hashPassword("password-1234"),
    sessionEpoch: 1,
    plan: "free",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  resetUserIndexCache();
});

beforeEach(() => {
  process.env.LUMEN_SESSION_SECRET = SECRET;
});

describe("session secret", () => {
  it("refuses to start without a usable secret", () => {
    delete process.env.LUMEN_SESSION_SECRET;
    expect(() => assertSessionSecret()).toThrow(/LUMEN_SESSION_SECRET/);
    process.env.LUMEN_SESSION_SECRET = "too-short";
    expect(() => assertSessionSecret()).toThrow(/LUMEN_SESSION_SECRET/);
    process.env.LUMEN_SESSION_SECRET = SECRET;
    expect(() => assertSessionSecret()).not.toThrow();
  });

  it("never verifies a cookie while the secret is missing", () => {
    const value = issueSessionValue(user);
    delete process.env.LUMEN_SESSION_SECRET;
    expect(verifySessionValue(value)).toBeNull();
  });

  it("invalidates every cookie when the secret is rotated", () => {
    const value = issueSessionValue(user);
    process.env.LUMEN_SESSION_SECRET = "rotated-session-secret-98765";
    expect(verifySessionValue(value)).toBeNull();
  });
});

describe("session signature", () => {
  it("accepts its own cookie", () => {
    const claims = verifySessionValue(issueSessionValue(user));
    expect(claims?.userId).toBe(user.id);
    expect(claims?.epoch).toBe(1);
  });

  it("rejects a forged signature", () => {
    const value = issueSessionValue(user);
    const [id, exp, epoch] = value.split(".");
    expect(verifySessionValue(`${id}.${exp}.${epoch}.forged-signature`)).toBeNull();
    expect(verifySessionValue(`${id}.${exp}.${epoch}.`)).toBeNull();
    expect(verifySessionValue(`${id}.${exp}.${epoch}`)).toBeNull();
    expect(verifySessionValue("")).toBeNull();
  });

  it("rejects a swapped userId, expiry or epoch", () => {
    const value = issueSessionValue(user);
    const [, exp, epoch, sig] = value.split(".");
    expect(verifySessionValue(`${OTHER_ID}.${exp}.${epoch}.${sig}`)).toBeNull();
    expect(verifySessionValue(`${user.id}.${Number(exp) + 86_400}.${epoch}.${sig}`)).toBeNull();
    expect(verifySessionValue(`${user.id}.${exp}.${Number(epoch) + 1}.${sig}`)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const now = Date.now();
    const value = issueSessionValue(user, now);
    expect(verifySessionValue(value, now + (SESSION_MAX_AGE_SEC - 60) * 1000)).not.toBeNull();
    expect(verifySessionValue(value, now + (SESSION_MAX_AGE_SEC + 1) * 1000)).toBeNull();
  });

  it("rejects a cookie the attacker minted for a well-formed but unknown id", async () => {
    const value = signSession({
      userId: OTHER_ID,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      epoch: 1,
    });
    // Correctly signed, so the pure check passes …
    expect(verifySessionValue(value)).not.toBeNull();
    // … but there is no such user on disk.
    expect(await sessionUser(request(value))).toBeNull();
  });
});

describe("sessionUser", () => {
  it("resolves the signed-in user", async () => {
    const found = await sessionUser(request(issueSessionValue(user)));
    expect(found?.id).toBe(user.id);
    expect(found?.email).toBe("session@example.com");
  });

  it("returns null without a cookie", async () => {
    expect(await sessionUser(new Request("http://localhost/api/me"))).toBeNull();
  });

  it("drops a disabled user immediately", async () => {
    const value = issueSessionValue(user);
    expect(await sessionUser(request(value))).not.toBeNull();
    await writeUser({ ...user, disabled: true });
    expect(await sessionUser(request(value))).toBeNull();
    await writeUser({ ...user, disabled: false });
    expect(await sessionUser(request(value))).not.toBeNull();
  });

  it("invalidates cookies issued before a password change", async () => {
    const value = issueSessionValue(user);
    const rotated = await writeUser({
      ...user,
      passwordHash: await hashPassword("password-5678"),
      sessionEpoch: user.sessionEpoch + 1,
    });
    expect(await sessionUser(request(value))).toBeNull();
    expect(await sessionUser(request(issueSessionValue(rotated)))).not.toBeNull();
    await writeUser(user);
  });
});
