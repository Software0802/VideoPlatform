import { createHmac, timingSafeEqual } from "node:crypto";
import { shareTtlHours } from "@/lib/env";
import { USER_ID_RE } from "@/lib/users/schema";
import { sessionSecret } from "@/lib/users/session-token";

/**
 * 分享链接的签名令牌（方案 §1.4「作品详情：分享链接」）。
 *
 * 令牌**就是**权限：`/s/<token>` 与 `/api/share/<token>` 完全公开，没有会话、没有
 * Cookie，谁拿到链接谁能看。所以这里只做一件事——证明这串东西是我们签发的、没被改
 * 过、还没到期。
 *
 * 密钥不是 `LUMEN_SESSION_SECRET` 本身，而是从它派生出来的一把（HMAC 一次固定上下文
 * 串）。域分离是硬要求：同一把密钥同时签会话和分享，一旦某天两种载荷的字节格式撞上，
 * 一个分享令牌就能被当成会话 Cookie 使。派生之后，就算分享这条链路上的签名逻辑写错，
 * 也换不出一个能通过 `verifySessionValue` 的串。
 *
 * 令牌里带 `ownerId` 而不只是 `jobId`：换主人（管理员重试了一条无主老任务）或 id 被
 * 复用时，旧链接自动失效，而不是继续指向一份现在属于别人的成片。
 */

const SHARE_KEY_CONTEXT = "lumen.share.v1";
/** 与 `create.ts` 里 `job_${randomBytes(6).toString("hex")}` 同源的形状约束。 */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
/** 载荷是三个短字段，正常令牌 ~120 字节；给个上限，免得对超长输入做 JSON.parse。 */
const MAX_TOKEN_LENGTH = 512;

export type ShareClaims = {
  jobId: string;
  ownerId: string;
  /** 过期时刻，Unix 秒。 */
  exp: number;
};

type Payload = { j: string; o: string; e: number };

function shareKey(): Buffer {
  // `sessionSecret()` 缺失时抛（启动守卫 `assertSessionSecret` 早就拦下了）——与会话
  // 同一个失败姿势：宁可 500，也不用一把可猜的密钥签发一条公开链接。每次现取而不是
  // 模块级缓存，进程内改环境变量（测试）才不会拿到旧密钥。
  return createHmac("sha256", sessionSecret()).update(SHARE_KEY_CONTEXT).digest();
}

function encodePayload(claims: ShareClaims): string {
  const payload: Payload = { j: claims.jobId, o: claims.ownerId, e: claims.exp };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", shareKey()).update(payload).digest("base64url");
}

export function signShareToken(claims: ShareClaims): string {
  if (!JOB_ID_RE.test(claims.jobId)) throw new Error("invalid job id");
  if (!USER_ID_RE.test(claims.ownerId)) throw new Error("invalid owner id");
  if (!Number.isInteger(claims.exp) || claims.exp <= 0) throw new Error("invalid expiry");
  const payload = encodePayload(claims);
  return `${payload}.${sign(payload)}`;
}

/** 签一条新链接。TTL 由 `SHARE_TTL_HOURS` 控制（默认 24 小时）。 */
export function issueShareToken(
  jobId: string,
  ownerId: string,
  nowMs: number = Date.now(),
): { token: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + shareTtlHours() * 3600;
  return { token: signShareToken({ jobId, ownerId, exp }), expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * 验签 + 判过期。任何一步不对都返回 null，调用方一律回 404——把「签名错了」和「任务
 * 不存在」分开回答，等于告诉扫链接的人「这条 id 是真的，接着爆破签名吧」。
 */
export function verifyShareToken(token: string, nowMs: number = Date.now()): ShareClaims | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, provided] = parts;
  if (!BASE64URL_RE.test(payload) || !BASE64URL_RE.test(provided)) return null;

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { j, o, e } = parsed as Partial<Payload>;
  if (typeof j !== "string" || !JOB_ID_RE.test(j)) return null;
  if (typeof o !== "string" || !USER_ID_RE.test(o)) return null;
  if (typeof e !== "number" || !Number.isFinite(e)) return null;
  if (e * 1000 <= nowMs) return null;
  return { jobId: j, ownerId: o, exp: e };
}
