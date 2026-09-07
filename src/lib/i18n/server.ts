import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, localeFromAcceptLanguage, type Locale } from "./locales";

/**
 * 服务端组件里解析当前语言：Cookie 优先，其次 `Accept-Language`。
 * 只在 `src/app/layout.tsx` 这类服务端入口调用（依赖 `next/headers`）。
 */
export async function resolveLocale(): Promise<Locale> {
  const store = await cookies();
  const fromCookie = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const h = await headers();
  return localeFromAcceptLanguage(h.get("accept-language"));
}
