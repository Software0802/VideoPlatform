import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyBalanceChangeLocked, hasGiftGrantFor } from "@/lib/billing/ledger";
import { dataDir } from "@/lib/env";
import { ProviderHttpError } from "@/lib/providers/types";
import { writeJsonAtomic } from "@/lib/storage/atomic-json";
import { withUserLock } from "@/lib/users/lock";
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_RE,
  giftCodeRecordSchema,
  normalizeInviteCode,
  type GiftCodeRecord,
} from "@/lib/users/schema";
import { readUser } from "@/lib/users/store";

/**
 * 礼品码：没有支付网关时唯一的自助充值方式（方案 §1.7）。
 *
 * 机制照搬邀请码（`invites.ts`）——同一套码型、同一个原子写、同一把 `withUserLock`——
 * 只多了一件事：认领之后要把钱记进余额。这一步让「认领」从一次写盘变成「写盘 + 入账」
 * 两步，于是有了 `creditedAt`：见下面 `redeemGiftCode` 的崩溃语义。
 */

export function giftCodesDir(): string {
  return path.join(dataDir(), "gift-codes");
}

export function giftCodePath(code: string): string {
  if (!INVITE_CODE_RE.test(code)) throw new Error("invalid gift code");
  return path.join(giftCodesDir(), `${code}.json`);
}

/** 与邀请码同款：32 字母表取 12 位（60 bit），256 % 32 === 0 所以掩码后仍是均匀分布。 */
export function generateGiftCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let out = "";
  for (const byte of bytes) out += INVITE_ALPHABET[byte & 31];
  return out;
}

export async function readGiftCode(rawCode: string): Promise<GiftCodeRecord | null> {
  const code = normalizeInviteCode(rawCode);
  if (!INVITE_CODE_RE.test(code)) return null;
  try {
    const raw = await readFile(giftCodePath(code), "utf8");
    const parsed = giftCodeRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.code !== code) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeGiftCode(record: GiftCodeRecord): Promise<GiftCodeRecord> {
  const parsed = giftCodeRecordSchema.parse(record);
  await writeJsonAtomic(giftCodePath(parsed.code), parsed);
  return parsed;
}

/** 铸一张没用过的码。调用方只许把它打到管理员自己的终端上。 */
export async function createGiftCode(amountCny: number, note?: string): Promise<GiftCodeRecord> {
  const amount = round2(amountCny);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("礼品码面额必须是正数");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateGiftCode();
    if (await readGiftCode(code)) continue;
    return writeGiftCode({
      code,
      amountCny: amount,
      createdAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    });
  }
  throw new Error("gift code generation failed");
}

export type GiftRedemption = {
  code: string;
  amountCny: number;
  /** 兑换后的余额（`user.json` 的事实源值，不含在途预留）。 */
  balanceCny: number;
  /**
   * 这次只是补完崩溃留下的半步（钱在上一次就已经到账），不是一次新的入账。
   *
   * 调用方据它决定怎么说话：`amountCny` 在两种情况下都是这张码的面额，但只有
   * `alreadyCredited === false` 时余额才真的涨了这么多——照样报「已到账 ¥20」会让
   * 用户以为充了两次，然后来问为什么余额对不上。
   */
  alreadyCredited: boolean;
};

/**
 * 「不存在」和「格式不对」给同一个答案，这样码空间不能被探测——与邀请码
 * (`invite_invalid`) 同一条纪律。
 */
function giftInvalid(): ProviderHttpError {
  return new ProviderHttpError(404, "gift_code_invalid", "礼品码无效");
}

function giftUsed(): ProviderHttpError {
  return new ProviderHttpError(409, "gift_code_used", "礼品码已被使用");
}

/**
 * 兑换：认领码 + 入账，**一个临界区**。
 *
 * 顺序是「先认领（写 `usedBy`）→ 再入账 → 最后写 `creditedAt`」，三步都在同一次
 * `withUserLock` 里，所以别的请求永远看不到中间状态。崩溃语义：
 *
 *  - 崩在认领之前：码原封不动，重来即可。
 *  - 崩在认领之后、入账之前：记录上有 `usedBy` 没有 `creditedAt`。**同一个人**再兑换
 *    一次会走补入账分支（跳过认领、直接入账），别人来仍然是 409——码已经归他了。
 *  - 崩在入账之后、写 `creditedAt` 之前：同上走补入账，但 `applyBalanceChangeLocked`
 *    按 `giftCode` 幂等去重，钱不会给第二次，只是补上 `creditedAt`；返回值里的
 *    `alreadyCredited` 为真，好让调用方别再报一次「已到账 ¥x」。
 *
 * 入账走 `applyBalanceChangeLocked` 而不是 `applyBalanceChange`：后者自己要拿
 * `withUserLock`，在锁里再拿就是死锁（那把锁是一条串行队列）。内核只有一份，
 * 幂等与流水格式都不会和别处走偏。
 */
export async function redeemGiftCode(rawCode: string, userId: string): Promise<GiftRedemption> {
  const code = normalizeInviteCode(rawCode);
  if (!INVITE_CODE_RE.test(code)) throw giftInvalid();

  return withUserLock(async () => {
    const user = await readUser(userId);
    // 会话有效但账号没了：先挡住，否则码会被一张已经不存在的账号烧掉。
    if (!user) throw new ProviderHttpError(401, "unauthorized", "请先登录");

    const record = await readGiftCode(code);
    if (!record) throw giftInvalid();
    // 别人的码、或者自己已经兑换完成的码，都是 409：这张码的钱已经落袋。
    if (record.usedBy && (record.usedBy !== userId || record.creditedAt)) throw giftUsed();

    const claimed = record.usedBy
      ? record
      : await writeGiftCode({ ...record, usedBy: userId, usedAt: new Date().toISOString() });

    // 在锁内、入账之前问一次流水：这张码在这个人名下是不是已经有入账行了。有就说明
    // 这次走的是补入账分支，下面的 `applyBalanceChangeLocked` 会按 `giftCode` 去重、
    // 余额一分不动——调用方必须能把这件事和「刚刚到账」区分开。
    const alreadyCredited = await hasGiftGrantFor(userId, claimed.code);

    const next = await applyBalanceChangeLocked(userId, claimed.amountCny, {
      kind: "grant",
      amountCny: claimed.amountCny,
      giftCode: claimed.code,
      note: `礼品码 ${claimed.code}`,
    });
    await writeGiftCode({ ...claimed, creditedAt: new Date().toISOString() });

    return {
      code: claimed.code,
      amountCny: claimed.amountCny,
      balanceCny: next.balanceCny,
      alreadyCredited,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
