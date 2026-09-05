import { access } from "node:fs/promises";
import { ProviderHttpError } from "@/lib/providers/types";
import { isInviteUsable, markInviteUsed, readInvite } from "@/lib/users/invites";
import { withUserLock } from "@/lib/users/lock";
import { burnPasswordTiming, hashPassword, verifyPassword } from "@/lib/users/password";
import { normalizeEmail, type UserRecord } from "@/lib/users/schema";
import {
  findUserByEmail,
  loadUserIndex,
  newUserId,
  readUser,
  setIndexEntry,
  userDir,
  writeUser,
} from "@/lib/users/store";

/**
 * Neither "unknown code" nor "already used" is distinguishable from the outside:
 * telling them apart would let anyone probe which codes exist (plan §4).
 */
function inviteInvalid(): ProviderHttpError {
  return new ProviderHttpError(400, "invite_invalid", "邀请码无效或已被使用");
}

async function pickFreeUserId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newUserId();
    const taken = await access(userDir(id)).then(
      () => true,
      () => false,
    );
    if (!taken) return id;
  }
  throw new Error("user id generation failed");
}

/**
 * Register inside the serial lock: the email check, the invite consumption and
 * both writes are one critical section, so concurrent requests can neither
 * create two accounts for one address nor spend one invite twice.
 *
 * Write order is fixed (§2): user.json (source of truth) → index.json (cache) →
 * invite write-back. A crash after the first write leaves an account the index
 * does not know about; the startup scan heals it.
 */
export async function registerUser(input: {
  email: string;
  password: string;
  inviteCode: string;
}): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  // Hash outside the lock: scrypt takes ~100 ms and must not serialize logins.
  const passwordHash = await hashPassword(input.password);

  return withUserLock(async () => {
    const index = await loadUserIndex();
    if (index.has(email)) {
      throw new ProviderHttpError(409, "email_taken", "该邮箱已注册");
    }
    const invite = await readInvite(input.inviteCode);
    if (!isInviteUsable(invite)) throw inviteInvalid();

    const now = new Date().toISOString();
    const id = await pickFreeUserId();
    const user = await writeUser({
      id,
      email,
      passwordHash,
      sessionEpoch: 1,
      plan: "free",
      inviteCode: invite.code,
      createdAt: now,
      updatedAt: now,
    });
    await setIndexEntry(email, id);
    await markInviteUsed(invite, id);
    return user;
  });
}

export async function loginUser(input: { email: string; password: string }): Promise<UserRecord> {
  const user = await findUserByEmail(input.email);
  if (!user) {
    // Same work as a real verification so timing cannot enumerate accounts.
    await burnPasswordTiming(input.password);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) throw invalidCredentials();
  // Only revealed once the password is right, so it is not an enumeration oracle.
  if (user.disabled) {
    throw new ProviderHttpError(403, "account_disabled", "账号已被停用，请联系管理员");
  }
  return user;
}

function invalidCredentials(): ProviderHttpError {
  return new ProviderHttpError(401, "invalid_credentials", "邮箱或密码不正确");
}

/**
 * Password change bumps `sessionEpoch`, which is part of the signed session
 * payload — every cookie issued before the change stops verifying (plan §3).
 * No endpoint exposes this yet; the mechanism belongs with the session design.
 */
export async function changeUserPassword(userId: string, newPassword: string): Promise<UserRecord> {
  const passwordHash = await hashPassword(newPassword);
  return withUserLock(async () => {
    const user = await readUser(userId);
    if (!user) throw new ProviderHttpError(404, "not_found", "用户不存在");
    return writeUser({ ...user, passwordHash, sessionEpoch: user.sessionEpoch + 1 });
  });
}
