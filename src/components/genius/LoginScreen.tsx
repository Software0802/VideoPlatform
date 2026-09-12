"use client";

import { useEffect, useId, useState } from "react";
import { login, register } from "@/lib/client/auth";
import { LanguageSwitch } from "@/components/genius/LanguageSwitch";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { errorText } from "@/lib/i18n/errorText";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  登录 / 注册。逻辑与旧 `lumen/LoginScreen` 完全一致（会话是服务端下发的 HttpOnly
  Cookie，本组件不持有任何令牌，成功后整页跳 `/`），只换成 Genius App 的配色：
  页面 #0a0a0b、卡片 #131316、描边 rgba(255,255,255,.09)、主按钮渐变。
  背景不再挂 WebGL（three 场景本轮不再被引用），改为一层静态径向光晕。

  多语言：右上角一枚与顶栏同款的语言切换——登录之前也得能换语言。服务端错误按
  `common.err.<code>` 出当前语言文案（H2）。
*/

type Tab = "login" | "register";
const TABS: { id: Tab; labelKey: MessageKey }[] = [
  { id: "login", labelKey: "login.tab.login" },
  { id: "register", labelKey: "login.tab.register" },
];

/** 只做一眼可见的格式判断；权威校验在服务端的 zod schema。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export function LoginScreen() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const panelId = useId();
  const errorId = useId();

  // data-ready 只由客户端 effect 写入，e2e 用它判断已水合
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const isRegister = tab === "register";

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setError(null);
  }

  /** 提交前的本地校验，避免为可预见的错误往返一次并白占限流额度。 */
  function localError(): string | null {
    if (!EMAIL_RE.test(email.trim())) return t("login.err.email");
    if (password.length < MIN_PASSWORD) return t("login.err.password", { n: MIN_PASSWORD });
    if (isRegister && !inviteCode.trim()) return t("login.err.invite");
    return null;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const invalid = localError();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isRegister) {
        await register({ email: email.trim(), password, inviteCode: inviteCode.trim() });
      } else {
        await login({ email: email.trim(), password });
      }
      // Cookie 刚由服务端下发，`/` 是 force-dynamic 的服务端渲染：整页跳转才能保证
      // SSR 这一次就带上会话。busy 不复位，页面正在离开。
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/");
    } catch (reason) {
      setError(errorText(t, reason));
      setBusy(false);
    }
  }

  return (
    // `shell` 只为共用「水合完成」这一个标记（方案 §7.1 #1）：登录页不在 (shell) 路由组里，
    // 布局仍由后写的 `.auth` 规则接管（display / overflow / background 都在它那边覆盖）。
    <div className="auth shell" data-ready={ready}>
      <div className="auth__glow" aria-hidden="true" />
      <header className="auth__top">
        <span className="side__mark" aria-hidden="true" />
        <span className="auth__brand">Genius</span>
        <LanguageSwitch className="lang--auth" />
      </header>

      <main className="auth__main">
        <form className="auth__card" onSubmit={submit} noValidate>
          <div className="auth__head">
            <h1 className="auth__title">{t("login.title")}</h1>
            <p className="auth__sub">{t("login.sub")}</p>
          </div>

          <div className="auth__tabs" role="tablist" aria-label={t("login.tabs.aria")}>
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className="auth__tab"
                data-on={tab === item.id}
                aria-selected={tab === item.id}
                aria-controls={panelId}
                onClick={() => switchTab(item.id)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>

          <div className="auth__fields" id={panelId} role="tabpanel">
            <label className="auth__label">
              <span>{t("login.email")}</span>
              <input
                className="auth__field"
                type="email"
                value={email}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={254}
                placeholder="you@example.com"
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <label className="auth__label">
              <span>{isRegister ? t("login.passwordWithMin", { n: MIN_PASSWORD }) : t("login.password")}</span>
              <input
                className="auth__field"
                type="password"
                value={password}
                autoComplete={isRegister ? "new-password" : "current-password"}
                maxLength={200}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {isRegister ? (
              <label className="auth__label">
                <span>{t("login.invite")}</span>
                <input
                  className="auth__field auth__field--code"
                  type="text"
                  value={inviteCode}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={64}
                  placeholder={t("login.invitePlaceholder")}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
              </label>
            ) : null}
          </div>

          {error ? (
            <p className="auth__error" id={errorId} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="auth__submit" disabled={busy}>
            {busy ? t("login.submitting") : isRegister ? t("login.tab.register") : t("login.tab.login")}
          </button>

          <p className="auth__hint">{isRegister ? t("login.hint.register") : t("login.hint.login")}</p>
        </form>
      </main>
    </div>
  );
}
