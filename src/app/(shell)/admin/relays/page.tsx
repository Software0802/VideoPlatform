import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { RelayAdmin } from "@/components/genius/admin/RelayAdmin";
import { isAdminUser } from "@/lib/jobs/ownership";
import { SESSION_COOKIE, sessionUserFromValue } from "@/lib/users/session";

export const dynamic = "force-dynamic";

/**
 * `/admin/relays` 中转管理页（N3.5）。会话校验由 `(shell)/layout.tsx` 兜底
 * （未登录 307 到 `/login`）；这里再做一遍管理员判定——非管理员 `notFound()`，
 * 与 `/api/admin/*` 的 404 同一条口径：这个页面的存在本身不该泄露给普通用户。
 */
export default async function AdminRelaysPage() {
  const store = await cookies();
  const user = await sessionUserFromValue(store.get(SESSION_COOKIE)?.value);
  if (!user || !isAdminUser(user.id)) notFound();
  return <RelayAdmin />;
}
