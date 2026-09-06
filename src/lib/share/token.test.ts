import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySessionValue } from "@/lib/users/session-token";

/**
 * 分享令牌（方案 §1.4「分享链接」）：`issueShareToken` 签发、`verifyShareToken` 验签 +
 * 判过期。密钥从 `LUMEN_SESSION_SECRET` 派生（`shareKey()` 用固定上下文串做 HMAC 一次），
 * 所以每个用例都要先把它摆好；`SHARE_TTL_HOURS` 控制默认有效期（`shareTtlHours()`,
 * 默认 24 小时）。
 */

const SECRET = "share-token-test-secret-0123456789";
const OWNER = "usr_00000000000000a1";
const OTHER_OWNER = "usr_00000000000000b2";
const JOB_ID = "job_share_test_0001";

let signShareToken: typeof import("./token").signShareToken;
let issueShareToken: typeof import("./token").issueShareToken;
let verifyShareToken: typeof import("./token").verifyShareToken;

beforeEach(async () => {
  process.env.LUMEN_SESSION_SECRET = SECRET;
  delete process.env.SHARE_TTL_HOURS;
  ({ signShareToken, issueShareToken, verifyShareToken } = await import("./token"));
});

afterEach(() => {
  delete process.env.LUMEN_SESSION_SECRET;
  delete process.env.SHARE_TTL_HOURS;
});

describe("issueShareToken / verifyShareToken roundtrip", () => {
  it("verifies its own token and returns the original claims", () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const { token, expiresAt } = issueShareToken(JOB_ID, OWNER, now);

    const claims = verifyShareToken(token, now);
    expect(claims).toEqual({ jobId: JOB_ID, ownerId: OWNER, exp: Math.floor(now / 1000) + 24 * 3600 });
    expect(expiresAt).toBe(new Date(Math.floor(now / 1000) * 1000 + 24 * 3600_000).toISOString());
  });

  it("honors SHARE_TTL_HOURS instead of the 24h default", () => {
    process.env.SHARE_TTL_HOURS = "1";
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const { token } = issueShareToken(JOB_ID, OWNER, now);

    // Still valid one second before the 1h mark, expired one second after.
    expect(verifyShareToken(token, now + 3600_000 - 1000)).not.toBeNull();
    expect(verifyShareToken(token, now + 3600_000 + 1000)).toBeNull();
  });

  it("expires at exactly its exp instant (the boundary itself counts as expired)", () => {
    const now = 1_800_000_000_000;
    const token = signShareToken({ jobId: JOB_ID, ownerId: OWNER, exp: Math.floor(now / 1000) + 10 });

    expect(verifyShareToken(token, now + 9_999)).not.toBeNull();
    expect(verifyShareToken(token, now + 10_000)).toBeNull();
  });
});

describe("verifyShareToken rejects tampering", () => {
  it("rejects a flipped signature", () => {
    const { token } = issueShareToken(JOB_ID, OWNER);
    const [payload, signature] = token.split(".");
    const flipped = signature[0] === "a" ? "b" : "a";
    expect(verifyShareToken(`${payload}.${flipped}${signature.slice(1)}`)).toBeNull();
  });

  it("rejects a payload edited to point at a different job, even though the old signature is attached", () => {
    const { token } = issueShareToken(JOB_ID, OWNER);
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      j: string;
      o: string;
      e: number;
    };
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, j: "job_someone_elses_video" }),
      "utf8",
    ).toString("base64url");
    expect(verifyShareToken(`${forgedPayload}.${signature}`)).toBeNull();
  });

  it("stops verifying every previously issued token once the session secret rotates", () => {
    const { token } = issueShareToken(JOB_ID, OWNER);
    expect(verifyShareToken(token)).not.toBeNull();
    process.env.LUMEN_SESSION_SECRET = "a-completely-different-secret-000";
    expect(verifyShareToken(token)).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["no dot", "not-a-valid-token"],
    ["too many parts", "a.b.c"],
    ["non-base64url payload", "not base64url!.signature"],
    ["absurdly long", `${"a".repeat(600)}.sig`],
  ])("rejects malformed input: %s", (_label, value) => {
    expect(verifyShareToken(value)).toBeNull();
  });
});

describe("signShareToken validates its claims before signing", () => {
  it("throws for a job id outside the id shape jobs are actually minted with", () => {
    expect(() => signShareToken({ jobId: "../etc/passwd", ownerId: OWNER, exp: 9_999_999_999 })).toThrow();
  });

  it("throws for an owner id that is not a usr_ id", () => {
    expect(() => signShareToken({ jobId: JOB_ID, ownerId: "not-a-user-id", exp: 9_999_999_999 })).toThrow();
  });

  it.each([0, -1, 1.5])("throws for a non-positive-integer expiry (%s)", (exp) => {
    expect(() => signShareToken({ jobId: JOB_ID, ownerId: OWNER, exp })).toThrow();
  });
});

/**
 * 硬约束（`token.ts` 头部注释）：分享令牌与会话 Cookie 必须来自域分离的密钥，任何一份
 * 都不能被当成另一份验过。会话是 `userId.expiresAt.epoch.sig`（4 段），分享是
 * `payload.sig`（2 段）——形状本身就不同，但这条测试钉的是「谁也别想把这两条路径的
 * 验签函数换错」这件事本身，而不是钉一个实现细节。
 */
describe("domain separation from session cookies", () => {
  it("never lets a share token verify as a session value, or vice versa", () => {
    const { token: shareToken } = issueShareToken(JOB_ID, OWNER);
    expect(verifySessionValue(shareToken)).toBeNull();
  });

  it("keeps ownerId as part of the signed claim, so a stolen link cannot be replayed for a different owner", () => {
    const { token } = issueShareToken(JOB_ID, OWNER);
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      j: string;
      o: string;
      e: number;
    };
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, o: OTHER_OWNER }), "utf8").toString(
      "base64url",
    );
    expect(verifyShareToken(`${forgedPayload}.${signature}`)).toBeNull();
  });
});
