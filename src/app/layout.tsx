import type { Metadata } from "next";
import { Manrope, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${manrope.variable} ${noto.variable}`}>
      <body>{children}</body>
    </html>
  );
}
