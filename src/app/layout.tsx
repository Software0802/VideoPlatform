import type { Metadata } from "next";
import { Manrope, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/components/genius/i18n/I18nProvider";
import { MESSAGES } from "@/lib/i18n/messages";
import { resolveLocale } from "@/lib/i18n/server";

/*
  字体：Manrope（400/500/600）+ Noto Sans SC（400/500）作 CJK 回退，见 globals.css 的字体栈。
  next/font 会自托管全部字重与 unicode-range 切片；subsets 只决定预加载哪些。
*/
const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-manrope" });
const noto = Noto_Sans_SC({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-noto", preload: false });

/**
 * 站点标题与描述跟着 Cookie / `Accept-Language` 走（review 2026-09-15 U-08）。
 *
 * 原来是一个写死中文的 `metadata` 常量：英文界面下分享到社交平台、加到书签栏拿到的
 * 仍是中文描述。写法与 `s/[token]/page.tsx` 的 `generateMetadata()` 一致——这一段在
 * `I18nProvider` 之外，取不到 `useT()`，直接按 `resolveLocale()` 读字典。
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  return {
    title: MESSAGES[locale]["common.metaTitle"],
    description: MESSAGES[locale]["common.metaDescription"],
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // 语言由 Cookie / Accept-Language 决定（`src/lib/i18n`），`<html lang>` 与首屏字典同源。
  const locale = await resolveLocale();
  return (
    <html lang={locale} className={`${manrope.variable} ${noto.variable}`}>
      <body>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
