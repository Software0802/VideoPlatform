"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconBell, IconBolt, IconGlobe, IconLogout, IconTag } from "@/components/genius/icons";
import { useShell } from "@/components/genius/ShellContext";
import { VIEW_TITLE, type ShellView } from "@/components/genius/views";

/*
  顶栏 56px（交接包 §2）。右侧簇：订阅胶囊 → 账户芯片（头像首字 · 账号名 · ⚡积分 · 基础版）
  → 语言 / 通知（仅样式）→ 头像（点开小菜单：邮箱 + 退出）。
  全部 nowrap + flex:none，簇本身不加 overflow:hidden（交接包 §9.2）。
*/

/** 顶栏只放 @ 前的部分；完整邮箱留在 title / 菜单里 */
const shortName = (email: string) => email.split("@")[0] || email;
const initial = (email: string) => (shortName(email)[0] ?? "·").toUpperCase();

export function TopBar({ view }: { view: ShellView }) {
  const { email, credits, signOut, signingOut, showToast } = useShell();
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <header className="top">
      <span className="top__title">{VIEW_TITLE[view]}</span>
      <div className="top__cluster">
        <Link className="top__sub" href="/subscription">
          <IconTag size={13} />
          订阅
        </Link>
        <div className="top__account">
          <span className="top__chip-avatar" aria-hidden="true">
            {initial(email)}
          </span>
          <span className="top__who" title={email}>
            {shortName(email)}
          </span>
          <span className="top__sep" aria-hidden="true" />
          <span className="top__credits" aria-label={`积分 ${credits}`}>
            <IconBolt size={12} />
            {credits}
          </span>
          <span className="top__plan">基础版</span>
        </div>
        <button type="button" className="top__icon" aria-label="语言" onClick={() => showToast("即将上线")}>
          <IconGlobe size={17} />
        </button>
        <button type="button" className="top__icon" aria-label="通知" onClick={() => showToast("即将上线")}>
          <IconBell size={17} />
          <span className="top__dot" aria-hidden="true" />
        </button>
        <div className="top__me" ref={box}>
          <button
            type="button"
            className="top__avatar"
            aria-label="账户"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            {initial(email)}
          </button>
          {/*
            这是一个 disclosure，不是 WAI-ARIA 的 menu：没有实现方向键导航、Home/End 与
            typeahead，挂 role="menu"/"menuitem" 只会让读屏用户按方向键落空，而且「退出」
            也就不再是按钮了（契约 §7 要的正是「菜单内按钮 退出」）。
          */}
          {menu ? (
            <div className="top__menu">
              <span className="top__menu-email">{email}</span>
              <button type="button" className="top__menu-item" disabled={signingOut} onClick={signOut}>
                <IconLogout size={14} />
                {signingOut ? "退出中" : "退出"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
