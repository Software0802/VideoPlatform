"use client";

import Link from "next/link";
import { IconAgent, IconCanvas, IconCreate, IconHome, IconSub } from "@/components/genius/icons";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { VIEW_TITLE, type ShellView } from "@/components/genius/views";

/*
  侧栏 212px（交接包 §2）：品牌 + 五项导航 + 页脚。
  当前项 `background rgba(255,255,255,.07)` + inset 描边 + 图标转主题色，
  并带 `aria-current="page"`（DOM 契约 §7）。

  文案与顶栏标题同源（`VIEW_TITLE` 存的是键名），切语言时两处一起变。
*/

const NAV = [
  { id: "home", href: "/", Icon: IconHome },
  { id: "create", href: "/create", Icon: IconCreate },
  { id: "agent", href: "/agent", Icon: IconAgent },
  { id: "canvas", href: "/canvas", Icon: IconCanvas },
  { id: "sub", href: "/subscription", Icon: IconSub },
] as const;

export function Sidebar({ view }: { view: ShellView }) {
  const t = useT();
  return (
    <aside className="side">
      <div className="side__brand">
        <span className="side__mark" aria-hidden="true" />
        <span className="side__name">Genius</span>
      </div>
      <nav className="side__nav" aria-label={t("shell.nav.aria")}>
        {NAV.map(({ id, href, Icon }) => {
          const on = view === id;
          return (
            <Link key={id} className="side__link" href={href} data-on={on} aria-current={on ? "page" : undefined}>
              <Icon size={17} />
              {/* 文字单独包一层：窄屏把侧栏收成 56px 图标栏时只藏文字，可访问名靠 title 兜住 */}
              <span className="side__label">{t(VIEW_TITLE[id])}</span>
            </Link>
          );
        })}
      </nav>
      <div className="side__foot">
        <span>{t("shell.foot.legal")}</span>
        <span>© Genius 2026</span>
      </div>
    </aside>
  );
}
