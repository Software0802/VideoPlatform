import type { Metadata } from "next";
import { Manrope, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/components/genius/i18n/I18nProvider";
import { resolveLocale } from "@/lib/i18n/server";

/*
  字体：Manrope（400/500/600）+ Noto Sans SC（400/500）作 CJK 回退，见 globals.css 的字体栈。
  next/font 会自托管全部字重与 unicode-range 切片；subsets 只决定预加载哪些。
*/
const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-manrope" });
const noto = Noto_Sans_SC({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-noto", preload: false });

export const metadata: Metadata = {
  title: "Genius",
  description: "创建你的世界。文生视频 · 图生视频 · 文生图",
};

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
