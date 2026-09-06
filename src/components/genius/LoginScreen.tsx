"use client";

import { useEffect, useId, useState } from "react";
import { authErrorMessage, login, register } from "@/lib/client/auth";

/*
  登录 / 注册。逻辑与旧 `lumen/LoginScreen` 完全一致（会话是服务端下发的 HttpOnly
  Cookie，本组件不持有任何令牌，成功后整页跳 `/`），只换成 Genius App 的配色：
  页面 #0a0a0b、卡片 #131316、描边 rgba(255,255,255,.09)、主按钮渐变。
  背景不再挂 WebGL（three 场景本轮不再被引用），改为一层静态径向光晕。
*/

type Tab = "login" | "register";
const TABS: { id: Tab; label: string }[] = [
  { id: "login", label: "登录" },
  { id: "register", label: "注册" },
];

/** 只做一眼可见的格式判断；权威校验在服务端的 zod schema。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export function LoginScreen() {
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
    const t = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(t);
  }, []);

  const isRegister = tab === "register";

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setError(null);
  }

  /** 提交前的本地校验，避免为可预见的错误往返一次并白占限流额度。 */
  function localError(): string | null {
    if (!EMAIL_RE.test(email.trim())) return "邮箱格式不正确";
    if (password.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
    if (isRegister && !inviteCode.trim()) return "请填写邀请码";
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
      setError(authErrorMessage(reason));
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
      </header>

      <main className="auth__main">
        <form className="auth__card" onSubmit={submit} noValidate>
          <div className="auth__head">
            <h1 className="auth__title">进入 Genius</h1>
            <p className="auth__sub">登录后继续创作；注册需要一枚一次性邀请码。</p>
          </div>

          <div className="auth__tabs" role="tablist" aria-label="登录或注册">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="auth__tab"
                data-on={tab === t.id}
                aria-selected={tab === t.id}
                aria-controls={panelId}
                onClick={() => switchTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="auth__fields" id={panelId} role="tabpanel">
            <label className="auth__label">
              <span>邮箱</span>
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
              <span>密码{isRegister ? `（至少 ${MIN_PASSWORD} 位）` : ""}</span>
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
                <span>邀请码</span>
                <input
                  className="auth__field auth__field--code"
                  type="text"
                  value={inviteCode}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={64}
                  placeholder="12 位字母数字"
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
            {busy ? "处理中" : isRegister ? "注册" : "登录"}
          </button>

          <p className="auth__hint">
            {isRegister ? "邀请码一码一号，用过即失效；没有码请联系管理员。" : "还没有账号？切到「注册」并填入邀请码。"}
          </p>
        </form>
      </main>
    </div>
  );
}
