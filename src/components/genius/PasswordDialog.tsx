"use client";

import { useCallback, useState } from "react";
import { changePassword, passwordErrorMessage } from "@/lib/client/auth";
import { useT } from "@/components/genius/i18n/I18nProvider";

/*
  修改密码弹窗（阶段 B）：旧密码 / 新密码 / 确认新密码 → `POST /api/auth/password`。

  成功后提示「其它设备已下线」——服务端会作废这个账号的其它会话；当前这一个留着，
  所以这里不跳登录页。真要是连当前会话也失效了，下一次 `/api/*` 的 401 会被
  `http.ts` 接住并整页跳 `/login`，不需要在这里再猜一遍。

  DOM 契约：`.pwd[role="dialog"]`，三个输入框按 `aria-label` 取（当前密码 / 新密码 /
  确认新密码），错误行 `.pwd__err[role="alert"]`。服务端回的错误文案（`passwordErrorMessage`）
  仍是中文，不在本轮多语言范围内。
*/

/** 与 `LoginScreen` 同一条下限（服务端才是事实源，这里只是不让必被 400 的请求出门）。 */
const MIN_LEN = 8;

export function PasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy) return;
    if (!current || !next) {
      setErr(t("shell.pwd.err.required"));
      return;
    }
    if (next.length < MIN_LEN) {
      setErr(t("shell.pwd.err.short", { n: MIN_LEN }));
      return;
    }
    if (next !== again) {
      setErr(t("shell.pwd.err.mismatch"));
      return;
    }
    if (next === current) {
      setErr(t("shell.pwd.err.same"));
      return;
    }
    setBusy(true);
    setErr(null);
    void changePassword({ currentPassword: current, newPassword: next }).then(
      () => {
        setBusy(false);
        onDone(t("shell.pwd.done"));
      },
      (e: unknown) => {
        setBusy(false);
        setErr(passwordErrorMessage(e));
      },
    );
  }, [again, busy, current, next, onDone, t]);

  return (
    <div className="pwd" role="dialog" aria-modal="true" aria-label={t("shell.pwd.title")} onClick={onClose}>
      <form
        className="pwd__panel"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="pwd__title">{t("shell.pwd.title")}</span>
        <p className="pwd__hint">{t("shell.pwd.hint")}</p>
        <input
          className="pwd__input"
          type="password"
          aria-label={t("shell.pwd.current")}
          autoComplete="current-password"
          placeholder={t("shell.pwd.current")}
          value={current}
          autoFocus
          maxLength={200}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="pwd__input"
          type="password"
          aria-label={t("shell.pwd.next")}
          autoComplete="new-password"
          placeholder={t("shell.pwd.nextPlaceholder", { n: MIN_LEN })}
          value={next}
          maxLength={200}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className="pwd__input"
          type="password"
          aria-label={t("shell.pwd.again")}
          autoComplete="new-password"
          placeholder={t("shell.pwd.againPlaceholder")}
          value={again}
          maxLength={200}
          onChange={(e) => setAgain(e.target.value)}
        />
        {err ? (
          <p className="pwd__err" role="alert">
            {err}
          </p>
        ) : null}
        <div className="pwd__actions">
          <button type="button" className="pwd__btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="pwd__btn pwd__btn--go" disabled={busy}>
            {busy ? t("shell.pwd.submitting") : t("shell.pwd.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
