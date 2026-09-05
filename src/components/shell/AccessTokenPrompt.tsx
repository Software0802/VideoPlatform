"use client";

import { useState } from "react";

/** Small first-party auth handoff for the optional single-user access token. */
export function AccessTokenPrompt({ onAuthorized }: { onAuthorized: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = token.trim();
    if (!value) {
      setError("请输入访问令牌");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(data?.error?.message ?? "令牌不正确");
      }
      setToken("");
      onAuthorized();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "令牌不正确");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="auth-prompt-title">
      <div className="dialog__backdrop" aria-hidden="true" />
      <form className="dialog__card" onSubmit={submit}>
        <h2 id="auth-prompt-title">需要访问令牌</h2>
        <p>当前实例启用了本地鉴权。令牌只会写入 HttpOnly Cookie，不会显示在页面或日志中。</p>
        <label className="field-label">
          <span>访问令牌</span>
          <input
            autoFocus
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            className="field"
            aria-describedby={error ? "auth-prompt-error" : undefined}
          />
        </label>
        {error ? (
          <p id="auth-prompt-error" role="alert" className="dialog__error">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy} className="btn btn--primary">
          {busy ? "验证中" : "进入工作室"}
        </button>
      </form>
    </div>
  );
}
