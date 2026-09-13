import { requireAdmin } from "@/lib/admin";
import { isLocalAdminRequest } from "@/lib/admin-token";
import { ProviderHttpError } from "@/lib/providers/types";
import { USER_ID_RE, type UserRecord } from "@/lib/users/schema";
import { findUserByEmail, readUser } from "@/lib/users/store";

/**
 * `/api/admin/*` 调用方身份（R4.1）：本机管理令牌优先，否则回到管理员会话。
 *
 * 令牌判据全部在 `isLocalAdminRequest` 里复查（Bearer 匹配 + XFF 缺失或
 * 全 loopback + loopback host）——proxy 那条只是提前放行，授权不能依赖
 * 它的覆盖面。
 */
export type AdminActor = { kind: "token" } | { kind: "user"; user: UserRecord };

export async function requireAdminActor(request: Request): Promise<AdminActor> {
  if (isLocalAdminRequest(request)) return { kind: "token" };
  const user = await requireAdmin(request);
  return { kind: "user", user };
}

/** 日志用的调用方标识：令牌通道记 `admin-token`，会话通道记用户 id。 */
export function actorLabel(actor: AdminActor): string {
  return actor.kind === "token" ? "admin-token" : actor.user.id;
}

/**
 * `[id]` 段同时接受 `usr_*` 与邮箱（CLI 的参数习惯是按邮箱找人）。
 * Next 已把路径段 decode 过；找不到返 null，路由统一 404。
 */
export async function findAdminTargetUser(raw: string): Promise<UserRecord | null> {
  const id = raw.trim();
  if (USER_ID_RE.test(id)) return readUser(id);
  return findUserByEmail(id);
}

export function adminUserNotFound(): ProviderHttpError {
  return new ProviderHttpError(404, "not_found", "用户不存在");
}
