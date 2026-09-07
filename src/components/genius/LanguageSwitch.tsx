"use client";

import { useEffect, useRef, useState } from "react";
import { IconGlobe } from "@/components/genius/icons";
import { useI18n } from "@/components/genius/i18n/I18nProvider";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n/locales";

/*
  语言切换（顶栏 + 登录页共用一份）。与头像菜单同款：**disclosure，不是 WAI-ARIA menu**
  ——没有方向键导航 / Home / End / typeahead，挂 role="menu" 只会让读屏用户按方向键落空。
  当前项用 `aria-current="true"` 标出（AGENTS.md 前端约定）。

  切换即时生效：`setLocale` 改 state（整棵树重渲染）+ 写 Cookie + 改 `<html lang>`，
  下一次服务端渲染读同一枚 Cookie，刷新后首屏与客户端一致，不会闪。
*/

export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={className ? `lang ${className}` : "lang"} ref={box}>
      <button
        type="button"
        className="lang__btn"
        aria-label={t("shell.lang.switch")}
        title={`${t("common.language")} · ${LOCALE_LABELS[locale]}`}
        aria-expanded={open}
        data-on={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconGlobe size={17} />
      </button>
      {open ? (
        <div className="lang__pop">
          <span className="lang__title">{t("common.language")}</span>
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              className="lang__item"
              data-locale={code}
              data-on={code === locale}
              aria-current={code === locale ? "true" : undefined}
              onClick={() => {
                setLocale(code);
                setOpen(false);
              }}
            >
              {LOCALE_LABELS[code]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
