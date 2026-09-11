import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLedger } from "@/lib/billing/ledger";
import { ProviderHttpError } from "@/lib/providers/types";
import { createGiftCode, readGiftCode, redeemGiftCode } from "./gift-codes";
import { INVITE_CODE_RE } from "./schema";
import { readUser, writeUser } from "./store";

/**
 * 契约 A2：礼品码是无支付网关时唯一的自助充值方式，机制照搬邀请码
 * （同一套码型、同一把 `withUserLock`），多的是认领 + 入账两步在同一临界区完成。
 * 参照 `src/lib/users/service.test.ts`（邀请码流程）与
 * `src/lib/billing/ledger.test.ts` 的隔离 DATA_DIR 写法。
 */

let dataRoot = "";

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-gift-codes-test-"));
  process.env.DATA_DIR = dataRoot;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function userId(tag: string): string {
  return `usr_${tag.padStart(16, "0")}`;
}

async function seedUser(id: string, balanceCny = 0) {
  return writeUser({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    sessionEpoch: 1,
    plan: "free",
    balanceCny,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function errorCode(reason: unknown): string {
  return reason instanceof ProviderHttpError ? reason.code : `unexpected:${String(reason)}`;
}

describe("createGiftCode / readGiftCode", () => {
  it("mints a code in the same shape as an invite code, readable back with its face value", async () => {
    const gift = await createGiftCode(50, "测试面额");
    expect(gift.code).toMatch(INVITE_CODE_RE);
    expect(gift.amountCny).toBe(50);
    expect(gift.note).toBe("测试面额");
    expect(gift.usedBy).toBeUndefined();
    expect(gift.creditedAt).toBeUndefined();

    const reread = await readGiftCode(gift.code);
    expect(reread).toEqual(gift);
  });

  it("rounds the amount to 2 decimals and rejects zero or negative face values", async () => {
    const rounded = await createGiftCode(19.995);
    expect(rounded.amountCny).toBe(20);

    await expect(createGiftCode(0)).rejects.toThrow("礼品码面额必须是正数");
    await expect(createGiftCode(-5)).rejects.toThrow("礼品码面额必须是正数");
  });

  it("readGiftCode returns null for an unknown or malformed code, same as a missing invite", async () => {
    expect(await readGiftCode("ZZZZZZZZZZZZ")).toBeNull();
    expect(await readGiftCode("not-a-code")).toBeNull();
    expect(await readGiftCode("")).toBeNull();
  });
});

describe("redeemGiftCode — normal path", () => {
  it("credits the user's balance, records a grant ledger row keyed by the code, and marks the code used", async () => {
    const id = userId("1");
    await seedUser(id, 10);
    const gift = await createGiftCode(30, "首次兑换");

    const redemption = await redeemGiftCode(gift.code, id);
    // alreadyCredited=false：这一次是真的入账（补入账分支才是 true，见下面的崩溃恢复块）
    expect(redemption).toMatchObject({
      code: gift.code,
      amountCny: 30,
      balanceCny: 40,
      alreadyCredited: false,
    });
    expect((await readUser(id))?.balanceCny).toBe(40);

    const record = await readGiftCode(gift.code);
    expect(record?.usedBy).toBe(id);
    expect(record?.usedAt).toBeTruthy();
    expect(record?.creditedAt).toBeTruthy();

    const ledger = await readLedger(id);
    const grantRow = ledger.entries.find((e) => e.giftCode === gift.code);
    expect(grantRow).toMatchObject({ kind: "grant", amountCny: 30, balanceAfterCny: 40 });
  });

  it("accepts a code typed with stray spaces/dashes/lowercase, mirroring invite-code normalization", async () => {
    const id = userId("2");
    await seedUser(id, 0);
    const gift = await createGiftCode(15);
    const messy = `${gift.code.slice(0, 4)}-${gift.code.slice(4, 8)}-${gift.code.slice(8)}`.toLowerCase();

    const redemption = await redeemGiftCode(messy, id);
    expect(redemption.amountCny).toBe(15);
    expect((await readUser(id))?.balanceCny).toBe(15);
  });
});

describe("redeemGiftCode — invalid / already-used codes", () => {
  it("rejects an unknown or malformed code with 404 gift_code_invalid", async () => {
    const id = userId("3");
    await seedUser(id, 0);
    for (const code of ["ZZZZZZZZZZZZ", "not-a-code", ""]) {
      const reason = await redeemGiftCode(code, id).catch((e: unknown) => e);
      expect(errorCode(reason)).toBe("gift_code_invalid");
      expect((reason as ProviderHttpError).status).toBe(404);
    }
    expect((await readUser(id))?.balanceCny).toBe(0);
  });

  it("rejects a second redemption by a different user with 409 gift_code_used, and does not credit them", async () => {
    const first = userId("4");
    const second = userId("5");
    await seedUser(first, 0);
    await seedUser(second, 0);
    const gift = await createGiftCode(25);

    await redeemGiftCode(gift.code, first);
    const reason = await redeemGiftCode(gift.code, second).catch((e: unknown) => e);

    expect(errorCode(reason)).toBe("gift_code_used");
    expect((reason as ProviderHttpError).status).toBe(409);
    expect((await readUser(second))?.balanceCny).toBe(0);
    expect((await readUser(first))?.balanceCny).toBe(25);
  });

  it("rejects the same user redeeming an already-fully-credited code a second time", async () => {
    const id = userId("6");
    await seedUser(id, 0);
    const gift = await createGiftCode(10);
    await redeemGiftCode(gift.code, id);

    const reason = await redeemGiftCode(gift.code, id).catch((e: unknown) => e);
    expect(errorCode(reason)).toBe("gift_code_used");
    expect((await readUser(id))?.balanceCny).toBe(10); // unchanged, not credited twice
  });

  it("throws 401 for a session whose account no longer exists", async () => {
    const gift = await createGiftCode(10);
    const reason = await redeemGiftCode(gift.code, userId("ghost")).catch((e: unknown) => e);
    expect(errorCode(reason)).toBe("unauthorized");
    expect((reason as ProviderHttpError).status).toBe(401);
  });
});

/**
 * 崩溃语义（`redeemGiftCode` 注释）：认领（写 `usedBy`）→ 入账 → 写 `creditedAt`
 * 三步在同一个 `withUserLock` 临界区内，但**跨进程重启**的崩溃可能落在「入账已经
 * 发生（流水已经写了这一行）、`creditedAt` 还没来得及写盘」这一刻。下一次同一个人
 * 再兑换，必须补上 `creditedAt`、但绝不能靠 `applyBalanceChangeLocked` 的
 * `giftCode` 幂等去重再入账一次。
 *
 * 注意这与「同一个人重复调用 `redeemGiftCode`」不同：一次正常调用会在同一个临界区
 * 里把 `creditedAt` 也写完，所以事后再调用同一个已完成的码，答案是 409
 * `gift_code_used`（见下面「concurrency」块），补入账分支只在 `creditedAt`
 * 缺失时才会走到。
 */
describe("redeemGiftCode — crash recovery (credited but creditedAt never landed)", () => {
  it("completes the missing creditedAt write without paying out a second time", async () => {
    const id = userId("7");
    await seedUser(id, 0);
    const gift = await createGiftCode(40);

    // Simulate a crash *after* the ledger write but *before* creditedAt was persisted:
    // usedBy/usedAt present, the grant already landed in the ledger (so a naive re-credit
    // would double-pay), creditedAt still absent.
    const { writeGiftCode } = await import("./gift-codes");
    const { applyBalanceChange } = await import("@/lib/billing/ledger");
    await writeGiftCode({ ...gift, usedBy: id, usedAt: new Date().toISOString() });
    // 输入必须与 redeemGiftCode 自己的入账调用逐字相同（含 note）：新协议下同 giftCode
    // 但输入不同的重放会判 billing_idempotency_conflict，而不是被当重复入账跳掉。
    await applyBalanceChange(id, gift.amountCny, {
      kind: "grant",
      amountCny: gift.amountCny,
      giftCode: gift.code,
      note: `礼品码 ${gift.code}`,
    });
    expect((await readUser(id))?.balanceCny).toBe(40); // the pre-crash credit already landed

    const redemption = await redeemGiftCode(gift.code, id);
    expect(redemption.balanceCny).toBe(40); // unchanged: not credited a second time
    // 调用方要能把「刚到账」和「上次就到账了、这次只补写 creditedAt」分开，否则界面
    // 会第二次报「到账 ¥40」，用户以为充了两次。
    expect(redemption.alreadyCredited).toBe(true);
    expect((await readUser(id))?.balanceCny).toBe(40);

    const record = await readGiftCode(gift.code);
    expect(record?.creditedAt).toBeTruthy(); // recovery completed the missing write
  });

  it("still rejects a stranger while the code sits in this claimed-but-uncredited state", async () => {
    const owner = userId("7b");
    const stranger = userId("7c");
    await seedUser(owner, 0);
    await seedUser(stranger, 0);
    const gift = await createGiftCode(18);
    const { writeGiftCode } = await import("./gift-codes");
    await writeGiftCode({ ...gift, usedBy: owner, usedAt: new Date().toISOString() });

    const reason = await redeemGiftCode(gift.code, stranger).catch((e: unknown) => e);
    expect(errorCode(reason)).toBe("gift_code_used");
    expect((await readUser(stranger))?.balanceCny).toBe(0);
  });
});

describe("redeemGiftCode — concurrency", () => {
  it("lets only one of two concurrent redemptions by different users succeed", async () => {
    const winner = userId("8");
    const loser = userId("9");
    await seedUser(winner, 0);
    await seedUser(loser, 0);
    const gift = await createGiftCode(20);

    const results = await Promise.allSettled([
      redeemGiftCode(gift.code, winner),
      redeemGiftCode(gift.code, loser),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]!.reason)).toBe("gift_code_used");

    // Exactly one of the two accounts got the 20 元, never both and never neither.
    const balances = [(await readUser(winner))?.balanceCny ?? 0, (await readUser(loser))?.balanceCny ?? 0];
    expect(balances.sort((a, b) => a - b)).toEqual([0, 20]);
  });

  /**
   * `withUserLock` serializes the *entire* claim+credit+creditedAt sequence into one
   * atomic unit (it is not split into a separate claim-lock and credit-lock), so only
   * the very first of five simultaneous callers ever observes an uncredited record —
   * by the time the second one acquires the lock, the code already carries
   * `creditedAt`, and `redeemGiftCode` does not special-case "it's the same caller
   * again" once that field is set. The safety property that matters (never paying out
   * twice) holds either way; this test pins the actual, slightly less friendly shape
   * of that guarantee so a UI that double-fires "redeem" on a fast click shows
   * "already used" rather than a second success.
   */
  it("serializes 5 concurrent first-time redemptions of the same code by the same user into exactly one success", async () => {
    const id = userId("a");
    await seedUser(id, 0);
    const gift = await createGiftCode(12);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => redeemGiftCode(gift.code, id)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(errorCode(r.reason)).toBe("gift_code_used");

    expect((await readUser(id))?.balanceCny).toBe(12);
    const ledger = await readLedger(id);
    expect(ledger.entries.filter((e) => e.giftCode === gift.code)).toHaveLength(1);
  });
});
