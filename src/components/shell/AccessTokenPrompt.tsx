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
    <div className="auth-prompt" role="dialog" aria-modal="true" aria-labelledby="auth-prompt-title">
      <div className="auth-prompt__backdrop" aria-hidden="true" />
      <form className="auth-prompt__card" onSubmit={submit}>
        <p className="readout text-accent/75">私密会话</p>
        <h2 id="auth-prompt-title" className="mt-2 text-lg font-medium text-ink">
          需要访问令牌
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          当前实例启用了本地鉴权。令牌只会写入 HttpOnly Cookie，不会显示在页面或日志中。
        </p>
        <label className="mt-5 block space-y-2">
          <span className="readout text-muted">访问令牌</span>
          <input
            autoFocus
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            className="field px-3.5 py-3 text-sm"
            aria-describedby={error ? "auth-prompt-error" : undefined}
          />
        </label>
        {error ? (
          <p id="auth-prompt-error" role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy} className="btn btn-primary mt-5 min-h-11 w-full px-5 py-2.5 text-sm">
          {busy ? "验证中…" : "进入工作室"}
        </button>
      </form>
    </div>
  );
}
