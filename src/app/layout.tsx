import type { Metadata } from "next";
import { Courier_Prime, Jost, Libre_Bodoni, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

/*
  字体替身（真实字体优先，见 globals.css 的字体栈）：
  Bodoni 72 → Libre Bodoni · Courier New → Courier Prime · Avenir Next → Jost · PingFang SC → Noto Sans SC
*/
const bodoni = Libre_Bodoni({ subsets: ["latin"], weight: ["400", "700"], style: ["normal", "italic"], variable: "--font-bodoni" });
const courier = Courier_Prime({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-courier" });
const jost = Jost({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jost" });
const noto = Noto_Sans_SC({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-noto", preload: false });

export const metadata: Metadata = {
  title: "流光 · Lumen",
  description: "写下一个镜头，看它转起来。文生视频 · 图生视频 · 文生图",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${bodoni.variable} ${courier.variable} ${jost.variable} ${noto.variable}`}>
      <body>{children}</body>
    </html>
  );
}
