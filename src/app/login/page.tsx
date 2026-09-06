import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginScreen } from "@/components/lumen/LoginScreen";
import { SESSION_COOKIE, sessionUserFromValue } from "@/lib/users/session";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "登录 · Genius",
};

/**
 * `/login` is a page, not `/api/*`, so `src/proxy.ts` never gates it — it is the
 * one screen a signed-out visitor is allowed to see (plan §7). Someone who
 * already has a session has no business here, so send them back to the studio;
 * `sessionUserFromValue` is the same check `/` uses, `disabled` and
 * `sessionEpoch` included.
 */
export default async function LoginPage() {
  const store = await cookies();
  const user = await sessionUserFromValue(store.get(SESSION_COOKIE)?.value);
  if (user) redirect("/");
  return <LoginScreen />;
}
