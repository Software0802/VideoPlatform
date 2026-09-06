"use client";

import Link from "next/link";
import { IconAgent, IconCanvas, IconCreate, IconHome, IconSub } from "@/components/genius/icons";
import type { ShellView } from "@/components/genius/views";

/*
  侧栏 212px（交接包 §2）：品牌 + 五项导航 + 页脚。
  当前项 `background rgba(255,255,255,.07)` + inset 描边 + 图标转主题色，
  并带 `aria-current="page"`（DOM 契约 §7）。
*/

const NAV = [
  { id: "home", href: "/", label: "主页", Icon: IconHome },
  { id: "create", href: "/create", label: "创作", Icon: IconCreate },
  { id: "agent", href: "/agent", label: "智能体", Icon: IconAgent },
  { id: "canvas", href: "/canvas", label: "画布", Icon: IconCanvas },
  { id: "sub", href: "/subscription", label: "订阅", Icon: IconSub },
] as const;

export function Sidebar({ view }: { view: ShellView }) {
  return (
    <aside className="side">
      <div className="side__brand">
        <span className="side__mark" aria-hidden="true" />
        <span className="side__name">Genius</span>
      </div>
      <nav className="side__nav" aria-label="主导航">
        {NAV.map(({ id, href, label, Icon }) => {
          const on = view === id;
          return (
            <Link key={id} className="side__link" href={href} data-on={on} aria-current={on ? "page" : undefined}>
              <Icon size={17} />
              {/* 文字单独包一层：窄屏把侧栏收成 56px 图标栏时只藏文字，可访问名靠 title 兜住 */}
              <span className="side__label">{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="side__foot">
        <span>条款 · 隐私</span>
        <span>© Genius 2026</span>
      </div>
    </aside>
  );
}
