import { isAdminUser } from "@/lib/jobs/ownership";
import { ProviderHttpError } from "@/lib/providers/types";
import { requireUser } from "@/lib/users/session";
import type { UserRecord } from "@/lib/users/schema";

/**
 * 管理接口的统一门槛：登录 + `LUMEN_ADMIN_USER_ID` 点名。
 *
 * 非管理员回 404 而不是 403——`/api/admin/*` 的存在本身不该泄露给普通用户，
 * 与 ownership.ts 里「非本人的任务一律 404」同一条口径。
 */
export async function requireAdmin(request: Request): Promise<UserRecord> {
  const user = await requireUser(request);
  if (!isAdminUser(user.id)) {
    throw new ProviderHttpError(404, "not_found", "接口不存在");
  }
  return user;
}
