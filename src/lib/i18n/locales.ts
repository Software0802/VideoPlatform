/**
 * 多语言（2026-09-06）。支持的语言与默认值是写死的常量：新增语言 = 在这里加一项 +
 * 在 `messages/<locale>/` 下补一整套字典（类型会逼你补全每个键）。
 *
 * 偏好只存一枚普通 Cookie（非 HttpOnly，浏览器端切换时直接改写），服务端渲染读它决定
 * `<html lang>` 与首屏字典，没有 Cookie 时看 `Accept-Language`。不进 user.json：语言是
 * 「这台浏览器」的偏好，不是账号属性。
 */
export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh-CN";
export const LOCALE_COOKIE = "lumen_locale";
/** 一年，秒。 */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简体中文",
  en: "English",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Cookie / 任意字符串 → 支持的语言；认不出回默认。 */
export function parseLocale(raw: string | undefined | null): Locale {
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/**
 * 没有 Cookie 时按 `Accept-Language` 猜：`zh*` → 简体中文，`en*` → English，其余默认。
 * 只看第一个能认出的语言，不做权重解析——这是首访兜底，用户点一次切换就会写 Cookie。
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(",")) {
    const tag = part.trim().split(";")[0]?.toLowerCase() ?? "";
    if (!tag) continue;
    if (tag.startsWith("zh")) return "zh-CN";
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}
