"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { formatMessage, type MessageParams } from "@/lib/i18n/format";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from "@/lib/i18n/locales";
import { MESSAGES, type MessageKey } from "@/lib/i18n/messages";

export type Translate = (key: MessageKey, params?: MessageParams) => string;

type I18nValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: Translate;
};

const I18nContext = createContext<I18nValue | null>(null);

/**
 * 语言上下文。挂在根布局（登录页与壳都在里面），`initialLocale` 由服务端按 Cookie /
 * `Accept-Language` 算好传进来，首屏与水合一致。切换时写 Cookie + 改 `<html lang>` +
 * 更新 state，整页文案即时切换，不刷新。
 */
export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const router = useRouter();

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      try {
        document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
        document.documentElement.lang = next;
      } catch {
        /* 非浏览器环境（测试）忽略 */
      }
      // 服务端渲染的部分（`<html lang>`、服务端组件里的文案）不会随客户端 state 变，重新拉一次 RSC。
      router.refresh();
    },
    [router],
  );

  const t = useCallback<Translate>(
    (key, params) => {
      const table = MESSAGES[locale];
      const template = table[key] ?? MESSAGES["zh-CN"][key] ?? key;
      return formatMessage(template, params);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return ctx;
}

/** 组件里最常用的形态：`const t = useT(); t("home.emptyTitle")`。 */
export function useT(): Translate {
  return useI18n().t;
}
