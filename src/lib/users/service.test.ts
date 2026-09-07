import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderHttpError } from "@/lib/providers/types";
import { createInvite, readInvite } from "./invites";
import { verifyPassword } from "./password";
import { INVITE_CODE_RE } from "./schema";
import { issueSessionValue, sessionUser } from "./session";
import { changeUserPassword, changeUserPasswordWithCurrent, loginUser, registerUser, SIGNUP_BONUS_CNY } from "./service";
import { readLedger } from "@/lib/billing/ledger";
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
    // 注册赠送 ¥5：余额与流水各一份，流水带 `ref:"signup"` 幂等键。
    expect(user.balanceCny).toBe(SIGNUP_BONUS_CNY);
    const ledger = await readLedger(user.id);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ kind: "grant", amountCny: SIGNUP_BONUS_CNY, ref: "signup" });

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

  it("changeUserPassword 404s not_found for a user id that does not exist", async () => {
    const reason = await changeUserPassword("usr_ffffffffffffff00", "brand-new-password").catch(
      (e: unknown) => e,
    );
    expect(errorCode(reason)).toBe("not_found");
    expect((reason as ProviderHttpError).status).toBe(404);
  });

  describe("changeUserPasswordWithCurrent (POST /api/auth/password's service call)", () => {
    it("rejects the wrong current password with invalid_credentials, and changes nothing", async () => {
      const invite = await createInvite();
      const user = await registerUser({
        email: "changepw@example.com",
        password: "original-password-1",
        inviteCode: invite.code,
      });

      const reason = await changeUserPasswordWithCurrent({
        userId: user.id,
        currentPassword: "not-the-current-password",
        newPassword: "would-be-new-password",
      }).catch((e: unknown) => e);
      expect(errorCode(reason)).toBe("invalid_credentials");
      expect((reason as ProviderHttpError).status).toBe(401);

      // Untouched: the original password still logs in, and the epoch never moved.
      const logged = await loginUser({ email: "changepw@example.com", password: "original-password-1" });
      expect(logged.sessionEpoch).toBe(user.sessionEpoch);
    });

    it("gives the same invalid_credentials answer for a user id that does not exist", async () => {
      const reason = await changeUserPasswordWithCurrent({
        userId: "usr_ffffffffffffff01",
        currentPassword: "anything",
        newPassword: "would-be-new-password",
      }).catch((e: unknown) => e);
      expect(errorCode(reason)).toBe("invalid_credentials");
    });

    it("on the right current password, rotates the password and bumps sessionEpoch", async () => {
      const invite = await createInvite();
      const user = await registerUser({
        email: "changepw2@example.com",
        password: "original-password-2",
        inviteCode: invite.code,
      });

      const rotated = await changeUserPasswordWithCurrent({
        userId: user.id,
        currentPassword: "original-password-2",
        newPassword: "shiny-new-password-2",
      });
      expect(rotated.sessionEpoch).toBe(user.sessionEpoch + 1);
      expect(
        (await loginUser({ email: "changepw2@example.com", password: "shiny-new-password-2" })).id,
      ).toBe(user.id);
      await expect(
        loginUser({ email: "changepw2@example.com", password: "original-password-2" }),
      ).rejects.toThrow();
    });

    /**
     * 「读 → 验旧密码 → 写新密码 + epoch」必须是一个临界区。拆开的话两条并发请求会各自
     * 拿同一个旧密码验过、再各自写一次，后到的把先到的新密码盖掉——攻击者手里的旧密码
     * 因此还能再改一次，而受害者以为号已经夺回来了。
     */
    it("lets only one of two concurrent changes win; the loser 401s on the now-stale current password", async () => {
      const invite = await createInvite();
      const user = await registerUser({
        email: "changepw-race@example.com",
        password: "original-password-3",
        inviteCode: invite.code,
      });

      const results = await Promise.allSettled(
        ["winner-password-a", "winner-password-b"].map((newPassword) =>
          changeUserPasswordWithCurrent({
            userId: user.id,
            currentPassword: "original-password-3",
            newPassword,
          }),
        ),
      );

      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const lost of results.filter((r) => r.status === "rejected")) {
        expect(errorCode(lost.reason)).toBe("invalid_credentials");
        expect((lost.reason as ProviderHttpError).status).toBe(401);
      }

      // 只发生了一次轮换：epoch 恰好 +1，且盘上的密码就是赢家写的那个。
      const rotated = (won[0] as PromiseFulfilledResult<{ id: string; sessionEpoch: number }>).value;
      expect(rotated.sessionEpoch).toBe(user.sessionEpoch + 1);
      const onDisk = await findUserByEmail("changepw-race@example.com");
      expect(onDisk!.sessionEpoch).toBe(user.sessionEpoch + 1);
      expect(await verifyPassword("original-password-3", onDisk!.passwordHash)).toBe(false);
      const winners = await Promise.all(
        ["winner-password-a", "winner-password-b"].map((p) => verifyPassword(p, onDisk!.passwordHash)),
      );
      expect(winners.filter(Boolean)).toHaveLength(1);
    });
  });
});
