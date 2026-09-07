import { access } from "node:fs/promises";
import { applyBalanceChangeLocked } from "@/lib/billing/ledger";
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
/** 新账号注册即送的余额（人民币元，用户 2026-09-07 决定）。¥5 ≈ 两条 5 秒 720p 视频或十张 1K 图。 */
export const SIGNUP_BONUS_CNY = 5;

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
    await writeUser({
      id,
      email,
      passwordHash,
      sessionEpoch: 1,
      plan: "free",
      // 余额先写 0，注册赠送（`SIGNUP_BONUS_CNY`）紧接着走流水入账，让这笔钱在
      // `data/ledger/` 里有一行可对账的凭据，而不是凭空出现在 user.json 里。
      balanceCny: 0,
      inviteCode: invite.code,
      createdAt: now,
      updatedAt: now,
    });
    await setIndexEntry(email, id);
    await markInviteUsed(invite, id);
    // 已在用户锁内，必须用 Locked 版本（外壳会死锁）。`ref:"signup"` 保证同一账号只送一次。
    return applyBalanceChangeLocked(id, SIGNUP_BONUS_CNY, {
      kind: "grant",
      amountCny: SIGNUP_BONUS_CNY,
      ref: "signup",
      note: "新用户赠送",
    });
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
 * `POST /api/auth/password` 走的是下面那层带旧密码校验的壳，这一层不校验任何东西，
 * 只给管理员 CLI（`scripts/reset-password.mjs` 的服务端等价物）与它复用。
 */
export async function changeUserPassword(userId: string, newPassword: string): Promise<UserRecord> {
  // Hash outside the lock: scrypt takes ~100 ms and the lock is process-wide.
  const passwordHash = await hashPassword(newPassword);
  return withUserLock(async () => {
    const user = await readUser(userId);
    if (!user) throw new ProviderHttpError(404, "not_found", "用户不存在");
    return rotate(user, passwordHash);
  });
}

/**
 * 换密码 + 踢掉所有旧会话，共用的那一次写。**必须在 `withUserLock` 里调用**：`sessionEpoch`
 * 是读改写，两个并发的改密各读到 1、各写 2，本该失效两次的旧 Cookie 只失效了一次。
 */
function rotate(user: UserRecord, passwordHash: string): Promise<UserRecord> {
  return writeUser({ ...user, passwordHash, sessionEpoch: user.sessionEpoch + 1 });
}

/**
 * 自助改密（方案 §3.4）：先验旧密码，再换新的。
 *
 * 旧密码是这条路径上唯一的凭据——会话 Cookie 可能是从一台没锁屏的电脑上顺来的，
 * 而改密会把其它设备全部踢掉，正是攻击者最想按的那个按钮。
 *
 * 计时与 `loginUser` 同款：用户不存在时照样烧掉一次 scrypt。这里其实已经有会话、
 * 账号存在与否不是秘密，但让两条验密路径在时序上一致，比论证「这一条为什么可以不
 * 一致」便宜，也免得日后被复制到别处。
 *
 * 返回改写后的记录（`sessionEpoch` 已 +1），路由据它签一张新 Cookie——本次会话不掉线，
 * 其它设备立刻掉线。
 *
 * 「读 → 验旧密码 → 写新密码」是一个临界区，不能拆成「锁外验、锁内写」：那样两条并发的
 * 改密会各自拿旧密码验过、再各自写一次，后到的那条把先到的新密码盖掉——攻击者手里的旧
 * 密码因此还能再改一次，而用户以为自己刚刚已经把号夺回来了。所以验密（包括不存在账号时
 * 那次防枚举的空烧）整段进锁，代价是改密期间 `withUserLock` 被一次 scrypt 占住 ~100 ms。
 * `withUserLock` 是进程级串行队列、不可重入，所以这里不能再调 `changeUserPassword`
 * （它自带一把锁，嵌套即死锁），共用的是锁内的 `rotate`。
 */
export async function changeUserPasswordWithCurrent(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.newPassword);
  return withUserLock(async () => {
    const user = await readUser(input.userId);
    if (!user) {
      await burnPasswordTiming(input.currentPassword);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw invalidCredentials();
    }
    return rotate(user, passwordHash);
  });
}

/**
 * 撤销这个账号的**所有**会话：`sessionEpoch` 加一，之前签发的每一张 Cookie 立刻失效
 * （`sessionUser` 每次请求都拿它与 `user.json` 对一次）。
 *
 * 登出走它（方案 §3.2「安全收口」）：只清浏览器里的 Cookie 挡不住已经泄漏出去的那一份，
 * 而「我在网吧登出了」这句话的意思正是「那张 Cookie 从此不许再用」。
 *
 * 用户不存在时返回 null 而不是抛：登出对没有会话的人也必须是成功的。
 */
export async function revokeUserSessions(userId: string): Promise<UserRecord | null> {
  return withUserLock(async () => {
    const user = await readUser(userId);
    if (!user) return null;
    return writeUser({ ...user, sessionEpoch: user.sessionEpoch + 1 });
  });
}
