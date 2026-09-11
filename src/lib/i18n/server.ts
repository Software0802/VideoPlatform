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

/**
 * Route handler 版：`next/headers` 的 `cookies()` 只在请求域里可用（测试里直接调
 * handler 会抛），这里从 `Request` 的 cookie / accept-language 头自己解析，口径相同。
 */
export function localeFromRequest(request: Request): Locale {
  const raw = /(?:^|;\s*)lumen_locale=([^\s;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (isLocale(raw)) return raw;
  return localeFromAcceptLanguage(request.headers.get("accept-language"));
}
