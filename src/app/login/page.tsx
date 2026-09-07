import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginScreen } from "@/components/genius/LoginScreen";
import { MESSAGES } from "@/lib/i18n/messages";
import { resolveLocale } from "@/lib/i18n/server";
import { SESSION_COOKIE, sessionUserFromValue } from "@/lib/users/session";

export const dynamic = "force-dynamic";

/** 标题跟着 Cookie / `Accept-Language` 走，与页面里的文案同源。 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  return { title: MESSAGES[locale]["login.metaTitle"] };
}

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
