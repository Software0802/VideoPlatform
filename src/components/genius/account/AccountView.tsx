"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { logoutAll, type SubscriptionSummary } from "@/lib/client/auth";
import { LanguageSwitch } from "@/components/genius/LanguageSwitch";
import { PasswordDialog } from "@/components/genius/PasswordDialog";
import { IconKey, IconLogout } from "@/components/genius/icons";
import { creditsOf, useShell } from "@/components/genius/ShellContext";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import { errorText } from "@/lib/i18n/errorText";
import { LOCALE_LABELS } from "@/lib/i18n/locales";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  账户视图（/account，H3，方案 `docs/plan-h-account-notifications-2026-09-12.md` §4）。
  三张卡：账号（邮箱 / 注册时间 / 界面语言）、余额（已购 / 会员 / 在途预留 / 可用 +
  订阅摘要 + 流水入口）、安全（修改密码 / 退出全部设备）。文案命名空间 `account.*`。

  DOM 契约：`.account-card[data-card="profile"|"balance"|"security"]`；订阅摘要
  `.account-sub__plan[data-plan]`（无订阅时 `data-plan="none"`）；「退出全部设备」的
  二次确认是页内 disclosure `.account-confirm[role="alertdialog"]`（不引 `confirm()`）。

  视觉与订阅页「我的方案」同语言：卡片 #131316 + rgba(255,255,255,.07) 描边。
  `PasswordDialog` 是 position:fixed 的浮层，必须留在带 transform 动画的
  `.account-view__body` **外面**（动画祖先会成为 fixed 的包含块），与订阅页同理。
*/

/** 档位 id → 显示名的 i18n 键（与 `SubscriptionView` 的 PLAN_NAME_KEYS 同一张表）。 */
const PLAN_NAME_KEYS: Record<string, MessageKey> = {
  standard: "subscription.plan.standard",
  pro: "subscription.plan.pro",
  premium: "subscription.plan.premium",
  ultimate: "subscription.plan.ultimate",
};

/** 只到日：注册时间与到期日都不需要精确到分（与订阅页 `day()` 同格式，避开 locale 差异）。 */
function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 订阅摘要那一行：「标准版 · 月付 · 2026-10-12 到期」，没订阅时退回「未订阅」。 */
function subscriptionLine(
  t: ReturnType<typeof useT>,
  sub: SubscriptionSummary,
): string {
  const nameKey = PLAN_NAME_KEYS[sub.planId];
  const name = nameKey ? t(nameKey) : sub.planId;
  const cycle = t(sub.cycle === "yearly" ? "subscription.mine.cycleYearly" : "subscription.mine.cycleMonthly");
  const expires = sub.expiresAt ? t("subscription.mine.expiresAt", { date: day(sub.expiresAt) }) : "";
  return [name, cycle, expires].filter(Boolean).join(" · ");
}

export default function AccountView() {
  const { me, email, showToast } = useShell();
  const { locale } = useI18n();
  const t = useT();
  const [pwd, setPwd] = useState(false);

  /* 「退出全部设备」的页内二次确认（disclosure）：确认前不发出任何请求。 */
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveErr, setLeaveErr] = useState<string | null>(null);

  /* Esc 收二次确认（H4）：与「取消」按钮同一条路径。 */
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirming(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming]);

  const balance = me?.balance;
  const sub = me?.subscription ?? null;

  const signOutEverywhere = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    setLeaveErr(null);
    void logoutAll().then(
      () => {
        // 自己的会话也一并失效了：整页重来，丢掉全部客户端状态（与 signOut 同理）。
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      },
      (e: unknown) => {
        setLeaving(false);
        setLeaveErr(errorText(t, e));
      },
    );
  }, [leaving, t]);

  /** 余额数字：`/api/me` 还没回来时不显示假数，统一摆「—」。 */
  const creditsCell = (cny: number | undefined) => (
    <span className="account-row__value account-row__value--num">
      {cny === undefined ? "—" : creditsOf(cny)}
    </span>
  );

  return (
    <div className="account-view">
      <div className="account-view__body">
        {/* ── 账号 ── */}
        <section className="account-card" data-card="profile">
          <div className="account-card__head">
            <span className="account-card__title">{t("account.profile.title")}</span>
          </div>
          <div className="account-rows">
            <div className="account-row">
              <span className="account-row__label">{t("account.profile.email")}</span>
              <span className="account-row__value">{email}</span>
            </div>
            <div className="account-row">
              <span className="account-row__label">{t("account.profile.joined")}</span>
              <span className="account-row__value">{me?.createdAt ? day(me.createdAt) : "—"}</span>
            </div>
            <div className="account-row">
              <span className="account-row__label">{t("account.profile.language")}</span>
              <span className="account-row__value account-row__value--lang">
                {LOCALE_LABELS[locale]}
                <LanguageSwitch className="lang--account" />
              </span>
            </div>
          </div>
        </section>

        {/* ── 余额与订阅 ── */}
        <section className="account-card" data-card="balance">
          <div className="account-card__head">
            <span className="account-card__title">{t("account.balance.title")}</span>
            <Link className="account-card__link" href="/subscription#ledger">
              {t("account.balance.ledger")}
            </Link>
            <Link className="account-card__link account-card__link--end" href="/subscription">
              {t("account.balance.topup")}
            </Link>
          </div>
          <div className="account-rows">
            <div className="account-row">
              <span className="account-row__label">{t("account.balance.purchased")}</span>
              {creditsCell(balance?.balanceCny)}
            </div>
            <div className="account-row">
              <span className="account-row__label">{t("account.balance.member")}</span>
              {creditsCell(balance?.memberCreditsCny)}
            </div>
            <div className="account-row">
              <span className="account-row__label">{t("account.balance.reserved")}</span>
              {creditsCell(balance?.reservedCny)}
            </div>
            <div className="account-row">
              <span className="account-row__label">{t("account.balance.available")}</span>
              {creditsCell(balance?.availableCny)}
            </div>
            <div className="account-row">
              <span className="account-row__label">{t("account.balance.subscription")}</span>
              <span className="account-row__value account-sub__plan" data-plan={sub?.planId ?? "none"}>
                {sub ? subscriptionLine(t, sub) : t("subscription.mine.none")}
              </span>
            </div>
          </div>
          <p className="account-note">{t("account.balance.unitNote")}</p>
        </section>

        {/* ── 安全 ── */}
        <section className="account-card" data-card="security">
          <div className="account-card__head">
            <span className="account-card__title">{t("account.security.title")}</span>
          </div>
          <div className="account-actions">
            <button type="button" className="account-btn" onClick={() => setPwd(true)}>
              <IconKey size={14} />
              {t("account.security.changePassword")}
            </button>
            <button
              type="button"
              className="account-btn"
              disabled={confirming || leaving}
              onClick={() => {
                setLeaveErr(null);
                setConfirming(true);
              }}
            >
              <IconLogout size={14} />
              {t("account.security.logoutAll")}
            </button>
          </div>
          {confirming ? (
            <div
              className="account-confirm"
              role="alertdialog"
              aria-label={t("account.security.logoutAll")}
            >
              <span className="account-confirm__text">{t("account.security.logoutAllText")}</span>
              {leaveErr ? (
                <p className="account-confirm__err" role="alert">
                  {leaveErr}
                </p>
              ) : null}
              <button
                type="button"
                className="account-btn"
                disabled={leaving}
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="account-btn account-btn--danger"
                disabled={leaving}
                onClick={signOutEverywhere}
              >
                {leaving ? t("account.security.loggingOut") : t("account.security.logoutAllConfirm")}
              </button>
            </div>
          ) : null}
        </section>
      </div>

      {/* fixed 弹层放在动画层外面（见文件头注释） */}
      {pwd ? (
        <PasswordDialog
          onClose={() => setPwd(false)}
          onDone={(message) => {
            setPwd(false);
            showToast(message);
          }}
        />
      ) : null}
    </div>
  );
}
