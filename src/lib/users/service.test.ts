import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderHttpError } from "@/lib/providers/types";
import { createInvite, readInvite } from "./invites";
import { verifyPassword } from "./password";
import { INVITE_CODE_RE } from "./schema";
import { issueSessionValue, sessionUser } from "./session";
import { changeUserPassword, loginUser, registerUser } from "./service";
import { findUserByEmail, loadUserIndex, resetUserIndexCache, writeUser } from "./store";

let dataRoot = "";

async function userDirs(): Promise<string[]> {
  const names = await readdir(path.join(dataRoot, "users"));
  return names.filter((name) => name.startsWith("usr_"));
}

function errorCode(reason: unknown): string {
  return reason instanceof ProviderHttpError ? reason.code : `unexpected:${String(reason)}`;
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-user-service-test-"));
  process.env.DATA_DIR = dataRoot;
  process.env.LUMEN_SESSION_SECRET = "unit-test-session-secret-0123456789";
  resetUserIndexCache();
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.LUMEN_SESSION_SECRET;
  resetUserIndexCache();
});

describe("registration", () => {
  it("creates an account, consumes the invite and logs in", async () => {
    const invite = await createInvite("first tester");
    expect(invite.code).toMatch(INVITE_CODE_RE);

    const user = await registerUser({
      email: " First@Example.COM ",
      password: "hunter2-hunter2",
      inviteCode: invite.code,
    });

    expect(user.email).toBe("first@example.com");
    expect(user.plan).toBe("free");
    expect(user.sessionEpoch).toBe(1);
    expect(user.inviteCode).toBe(invite.code);
    expect(await verifyPassword("hunter2-hunter2", user.passwordHash)).toBe(true);

    const consumed = await readInvite(invite.code);
    expect(consumed?.usedBy).toBe(user.id);
    expect(consumed?.usedAt).toBeTruthy();
    expect(consumed?.note).toBe("first tester");

    const logged = await loginUser({ email: "first@example.com", password: "hunter2-hunter2" });
    expect(logged.id).toBe(user.id);
  });

  it("rejects an unknown, malformed or already-used code with one indistinguishable error", async () => {
    const used = await createInvite();
    await registerUser({
      email: "burned@example.com",
      password: "hunter2-hunter2",
      inviteCode: used.code,
    });

    for (const code of [used.code, "ZZZZZZZZZZZZ", "not-a-code", ""]) {
      const reason = await registerUser({
        email: `probe-${Math.random().toString(36).slice(2)}@example.com`,
        password: "hunter2-hunter2",
        inviteCode: code,
      }).catch((e: unknown) => e);
      expect(errorCode(reason)).toBe("invite_invalid");
      expect((reason as ProviderHttpError).status).toBe(400);
    }
  });

  it("does not spend an invite when the email is already taken", async () => {
    const invite = await createInvite();
    const reason = await registerUser({
      email: "first@example.com",
      password: "hunter2-hunter2",
      inviteCode: invite.code,
    }).catch((e: unknown) => e);

    expect(errorCode(reason)).toBe("email_taken");
    expect((await readInvite(invite.code))?.usedBy).toBeUndefined();
  });

  it("creates exactly one account when the same email registers concurrently", async () => {
    const invites = await Promise.all([1, 2, 3, 4, 5].map(() => createInvite()));
    const before = (await userDirs()).length;

    const results = await Promise.allSettled(
      invites.map((invite) =>
        registerUser({
          email: "race@example.com",
          password: "hunter2-hunter2",
          inviteCode: invite.code,
        }),
      ),
    );

    const created = results.filter((r) => r.status === "fulfilled");
    expect(created).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect(errorCode(rejected.reason)).toBe("email_taken");
    }
    expect((await userDirs()).length).toBe(before + 1);
    expect((await loadUserIndex()).get("race@example.com")).toBe(
      (created[0] as PromiseFulfilledResult<{ id: string }>).value.id,
    );
    // The four losers must not have burned their codes.
    const unused = await Promise.all(invites.map(async (i) => (await readInvite(i.code))?.usedBy));
    expect(unused.filter(Boolean)).toHaveLength(1);
  });

  it("lets only one registration consume a shared invite code", async () => {
    const invite = await createInvite();
    const before = (await userDirs()).length;

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) =>
        registerUser({
          email: `shared-${n}@example.com`,
          password: "hunter2-hunter2",
          inviteCode: invite.code,
        }),
      ),
    );

    const created = results.filter((r) => r.status === "fulfilled");
    expect(created).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect(errorCode(rejected.reason)).toBe("invite_invalid");
    }
    expect((await userDirs()).length).toBe(before + 1);
    expect((await readInvite(invite.code))?.usedBy).toBe(
      (created[0] as PromiseFulfilledResult<{ id: string }>).value.id,
    );
  });
});

describe("login", () => {
  it("rejects a wrong password and an unknown email the same way", async () => {
    const wrong = await loginUser({
      email: "first@example.com",
      password: "wrong-password-x",
    }).catch((e: unknown) => e);
    const missing = await loginUser({
      email: "nobody@example.com",
      password: "hunter2-hunter2",
    }).catch((e: unknown) => e);

    expect(errorCode(wrong)).toBe("invalid_credentials");
    expect(errorCode(missing)).toBe("invalid_credentials");
    expect((wrong as ProviderHttpError).status).toBe(401);
    expect((wrong as ProviderHttpError).message).toBe(
      (missing as ProviderHttpError).message,
    );
  });

  it("reports a disabled account only after the password checks out", async () => {
    const user = await findUserByEmail("burned@example.com");
    await writeUser({ ...user!, disabled: true });

    const wrongPassword = await loginUser({
      email: "burned@example.com",
      password: "not-the-password",
    }).catch((e: unknown) => e);
    expect(errorCode(wrongPassword)).toBe("invalid_credentials");

    const disabled = await loginUser({
      email: "burned@example.com",
      password: "hunter2-hunter2",
    }).catch((e: unknown) => e);
    expect(errorCode(disabled)).toBe("account_disabled");

    await writeUser({ ...user!, disabled: false });
  });
});

describe("password change", () => {
  it("bumps the session epoch so old cookies stop verifying", async () => {
    const user = await findUserByEmail("first@example.com");
    const oldCookie = issueSessionValue(user!);
    const request = (value: string) =>
      new Request("http://localhost/api/me", { headers: { cookie: `lumen_session=${value}` } });
    expect(await sessionUser(request(oldCookie))).not.toBeNull();

    const rotated = await changeUserPassword(user!.id, "brand-new-password");
    expect(rotated.sessionEpoch).toBe(user!.sessionEpoch + 1);
    expect(await sessionUser(request(oldCookie))).toBeNull();
    expect(await sessionUser(request(issueSessionValue(rotated)))).not.toBeNull();

    expect((await loginUser({ email: "first@example.com", password: "brand-new-password" })).id).toBe(
      user!.id,
    );
    await expect(
      loginUser({ email: "first@example.com", password: "hunter2-hunter2" }),
    ).rejects.toThrow();
  });
});
