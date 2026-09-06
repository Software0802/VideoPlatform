"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconBell, IconBolt, IconGlobe, IconKey, IconLogout, IconTag } from "@/components/genius/icons";
import { PasswordDialog } from "@/components/genius/PasswordDialog";
import { useShell } from "@/components/genius/ShellContext";
import { VIEW_TITLE, type ShellView } from "@/components/genius/views";

/*
  顶栏 56px（交接包 §2）。右侧簇：订阅胶囊 → 账户芯片（头像首字 · 账号名 · ⚡积分 · 基础版）
  → 语言（仅样式）/ 通知（真的）→ 头像（点开小菜单：邮箱 + 修改密码 + 退出）。
  全部 nowrap + flex:none，簇本身不加 overflow:hidden（交接包 §9.2）。

  阶段 B：铃铛接账号级事件流（`GET /api/events`）。红点 = 未读数（`.top__dot[data-count]`），
  点击清零并列出最近 10 条（`.notify` / `.notify__item[data-job-id]`）；点一条跳创作页。
*/

/** 顶栏只放 @ 前的部分；完整邮箱留在 title / 菜单里 */
const shortName = (email: string) => email.split("@")[0] || email;
const initial = (email: string) => (shortName(email)[0] ?? "·").toUpperCase();

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 点外面 / 按 Esc 就收起：菜单与通知面板共用一份。 */
function useDismiss(open: boolean, close: () => void) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return box;
}

export function TopBar({ view }: { view: ShellView }) {
  const { email, credits, signOut, signingOut, showToast, notices, unread, markNoticesRead, openNotice } = useShell();
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const [pwd, setPwd] = useState(false);
  const menuBox = useDismiss(menu, () => setMenu(false));
  const bellBox = useDismiss(bell, () => setBell(false));

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
        {/* 语言在窄屏上让位（`.top__icon--lang`）；铃铛不能一起藏——通知是真功能 */}
        <button type="button" className="top__icon top__icon--lang" aria-label="语言" onClick={() => showToast("即将上线")}>
          <IconGlobe size={17} />
        </button>

        <div className="top__bell" ref={bellBox}>
          <button
            type="button"
            className="top__icon"
            aria-label={unread ? `通知 ${unread} 条未读` : "通知"}
            aria-expanded={bell}
            onClick={() => {
              setBell((v) => !v);
              // 打开即已读：红点是「有没有新的」，不是待办数
              if (!bell) markNoticesRead();
            }}
          >
            <IconBell size={17} />
            {unread ? <span className="top__dot" data-count={unread} aria-hidden="true" /> : null}
          </button>
          {bell ? (
            <div className="notify" role="region" aria-label="通知">
              <span className="notify__title">通知</span>
              {notices.length ? (
                <ul className="notify__list">
                  {notices.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="notify__item"
                        data-job-id={n.jobId}
                        data-ok={n.ok}
                        onClick={() => {
                          setBell(false);
                          openNotice(n);
                        }}
                      >
                        <span className="notify__head">
                          <span className="notify__name">{n.title}</span>
                          <span className="notify__when">{clock(n.at)}</span>
                        </span>
                        <span className="notify__detail">{n.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="notify__empty">还没有新通知。任务完成时会出现在这里。</p>
              )}
            </div>
          ) : null}
        </div>

        <div className="top__me" ref={menuBox}>
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
              <button
                type="button"
                className="top__menu-item"
                onClick={() => {
                  setMenu(false);
                  setPwd(true);
                }}
              >
                <IconKey size={14} />
                修改密码
              </button>
              <button type="button" className="top__menu-item" disabled={signingOut} onClick={signOut}>
                <IconLogout size={14} />
                {signingOut ? "退出中" : "退出"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {pwd ? (
        <PasswordDialog
          onClose={() => setPwd(false)}
          onDone={(message) => {
            setPwd(false);
            showToast(message);
          }}
        />
      ) : null}
    </header>
  );
}
