"use client";

import { useCallback, useState } from "react";
import { changePassword, passwordErrorMessage } from "@/lib/client/auth";

/*
  修改密码弹窗（阶段 B）：旧密码 / 新密码 / 确认新密码 → `POST /api/auth/password`。

  成功后提示「其它设备已下线」——服务端会作废这个账号的其它会话；当前这一个留着，
  所以这里不跳登录页。真要是连当前会话也失效了，下一次 `/api/*` 的 401 会被
  `http.ts` 接住并整页跳 `/login`，不需要在这里再猜一遍。

  DOM 契约：`.pwd[role="dialog"]`，三个输入框按 `aria-label` 取（当前密码 / 新密码 /
  确认新密码），错误行 `.pwd__err[role="alert"]`。
*/

/** 与 `LoginScreen` 同一条下限（服务端才是事实源，这里只是不让必被 400 的请求出门）。 */
const MIN_LEN = 8;

export function PasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy) return;
    if (!current || !next) {
      setErr("请填写当前密码与新密码");
      return;
    }
    if (next.length < MIN_LEN) {
      setErr(`新密码至少 ${MIN_LEN} 位`);
      return;
    }
    if (next !== again) {
      setErr("两次输入的新密码不一致");
      return;
    }
    if (next === current) {
      setErr("新密码不能与当前密码相同");
      return;
    }
    setBusy(true);
    setErr(null);
    void changePassword({ currentPassword: current, newPassword: next }).then(
      () => {
        setBusy(false);
        onDone("密码已修改，其它设备已下线");
      },
      (e: unknown) => {
        setBusy(false);
        setErr(passwordErrorMessage(e));
      },
    );
  }, [again, busy, current, next, onDone]);

  return (
    <div className="pwd" role="dialog" aria-modal="true" aria-label="修改密码" onClick={onClose}>
      <form
        className="pwd__panel"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="pwd__title">修改密码</span>
        <p className="pwd__hint">修改成功后，其它设备上的登录会被下线。</p>
        <input
          className="pwd__input"
          type="password"
          aria-label="当前密码"
          autoComplete="current-password"
          placeholder="当前密码"
          value={current}
          autoFocus
          maxLength={200}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="pwd__input"
          type="password"
          aria-label="新密码"
          autoComplete="new-password"
          placeholder={`新密码（至少 ${MIN_LEN} 位）`}
          value={next}
          maxLength={200}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className="pwd__input"
          type="password"
          aria-label="确认新密码"
          autoComplete="new-password"
          placeholder="再输一次新密码"
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
            取消
          </button>
          <button type="submit" className="pwd__btn pwd__btn--go" disabled={busy}>
            {busy ? "提交中…" : "确认修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
