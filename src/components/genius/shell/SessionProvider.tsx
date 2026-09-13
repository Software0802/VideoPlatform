"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchMe, logout, type MePublic } from "@/lib/client/auth";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { errorText } from "@/lib/i18n/errorText";
import { creditsOf, type ShellCaps } from "./shared";

/*
  会话 / 账号域：`/api/me` 是唯一来源，`caps` 是 SSR 下发的能力表。
  `error` / `setError` 是面板错误行的公共状态——写它的不只是面板（`signOut` 失败、
  任务动作失败都会写），所以放在最外层，三个下层域都拿得到。
*/

export type SessionShell = {
  caps: ShellCaps;
  me: MePublic | null;
  email: string;
  credits: number | null;
  refreshMe: () => void;
  signOut: () => void;
  signingOut: boolean;
  error: string | null;
  setError: (value: string | null) => void;
};

const Ctx = createContext<SessionShell | null>(null);

export function useSession(): SessionShell {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession 必须在 SessionProvider 内使用");
  return value;
}

/** 仅供下层壳域调用（JobsProvider / ComposerProvider），视图组件请用 `useSession()`。 */
export function useSessionBridge(): SessionShell {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSessionBridge 必须在 SessionProvider 内使用");
  return value;
}

export function SessionProvider({ caps, children }: { caps: ShellCaps; children: ReactNode }) {
  // `t` 随语言变，所以凡是把文案存进 state 的回调都要把它列进依赖。
  const t = useT();

  const [me, setMe] = useState<MePublic | null>(null);
  const [meTick, setMeTick] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── 账号：/api/me 是唯一来源 ── */
  const refreshMe = useCallback(() => setMeTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    void fetchMe().then(
      (next) => {
        if (alive) setMe(next);
      },
      () => {
        // 401 已由 client 层跳登录页；其它错误不该打断正在进行的出图
      },
    );
    return () => {
      alive = false;
    };
  }, [meTick]);

  const email = me?.email ?? caps.initialEmail;
  const balance = me?.balance;
  const credits = balance ? creditsOf(balance.availableCny) : null;

  const signOut = useCallback(() => {
    if (signingOut) return;
    setSigningOut(true);
    void logout().then(
      () => {
        // 整页跳转：会话没了，客户端缓存里的任务数据也该一起丢掉
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      },
      (e: unknown) => {
        setSigningOut(false);
        setError(errorText(t, e));
      },
    );
  }, [signingOut, t]);

  const value = useMemo<SessionShell>(
    () => ({
      caps,
      me,
      email,
      credits,
      refreshMe,
      signOut,
      signingOut,
      error,
      setError,
    }),
    [caps, me, email, credits, refreshMe, signOut, signingOut, error],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
