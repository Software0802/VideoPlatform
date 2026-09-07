"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLedger,
  redeemErrorMessage,
  redeemGiftCode,
  type LedgerEntry,
} from "@/lib/client/auth";
import { newIdempotencyKey } from "@/lib/client/jobs";
import {
  fetchSubscription,
  purchaseSubscription,
  subscriptionErrorCode,
  subscriptionErrorFallback,
  type MySubscription,
  type PlanCycle,
  type SubscriptionPlan,
  type SubscriptionState,
} from "@/lib/client/subscription";
import { creditsOf, useShell } from "@/components/genius/ShellContext";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/**
 * 订阅视图（方案 `docs/plan-agent-i18n-subscription-2026-09.md` §3.3）。
 *
 * 四档价格不再是原型的美元占位：它们由 `GET /api/subscription` 按平台成本加固定毛利率
 * 实时算出来（`src/lib/billing/plans.ts`），所以这一页必须先取数再渲染卡片。脚注只说
 * 「价格是这么来的」，**不摆**成本比例与毛利率的数字——那是进货价，不下发到浏览器。
 *
 * 两个池的区别是这一页最要讲清楚的事：订阅**只能用已购积分**买（礼品码 / 管理员充值
 * 进来的那些），订阅送的会员积分只能用于生成、期末清零。混为一谈就会有人问「我明明
 * 有 3000 积分为什么买不了订阅」。
 */

/** 方案名的渐变文字（原型 NAME_GRAD），按卡片次序取。 */
const NAME_GRADS = [
  "linear-gradient(90deg,#f0f0f2,#a9abb4)",
  "linear-gradient(90deg,#8ec5ff,#5b8cff)",
  "linear-gradient(90deg,#ffc48a,#ff8a3d)",
  "linear-gradient(90deg,#ff8a3d,#ff4d8d 60%,#a855f7)",
];

/**
 * 档位 id → 显示名的 i18n 键。服务端只下发 id 与一个中文兜底名（它不翻译文案），
 * 认得的 id 走字典，认不出的（服务端加了新档而前端还没更新）原样用兜底名。
 */
const PLAN_NAME_KEYS: Record<string, MessageKey> = {
  standard: "subscription.plan.standard",
  pro: "subscription.plan.pro",
  premium: "subscription.plan.premium",
  ultimate: "subscription.plan.ultimate",
};

/** 服务端下发的功能行键名白名单（与 `plans.ts` 的 `PLAN_FEATURE_KEYS` 同一张表）。 */
const FEATURE_KEYS = [
  "subscription.featureCredits",
  "subscription.featureDaily",
  "subscription.featureMemberFirst",
  "subscription.featureAllProducts",
] as const satisfies readonly MessageKey[];

type FeatureKey = (typeof FEATURE_KEYS)[number];

function isFeatureKey(key: string): key is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(key);
}

/** 流水条目的 `kind` → i18n 键（`src/lib/billing/ledger.ts` 的三种）。 */
const LEDGER_KIND_KEYS: Record<string, MessageKey> = {
  grant: "subscription.ledger.grant",
  charge: "subscription.ledger.charge",
  adjust: "subscription.ledger.adjust",
};

function BoltIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#f0d9a8" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#8b8b91"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="sub-feature__tick"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

/** ¥ 金额：整数不带小数点，其余一位小数（价格本来就向上取到 0.1 元）。 */
function money(n: number): string {
  const value = Number.isFinite(n) ? n : 0;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 只到日：到期日不需要精确到分。 */
function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 抽屉的两种口径：全部流水（积分使用详情）/ 只看充值（账单记录）。 */
type Drawer = null | { titleKey: MessageKey; kind?: string };

export default function SubscriptionView({ credits }: { credits: number }) {
  const { me, refreshMe } = useShell();
  const t = useT();
  const [yearly, setYearly] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 订阅档位与我的订阅 */
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [stateErr, setStateErr] = useState<string | null>(null);
  const [pending, setPending] = useState<SubscriptionPlan | null>(null);
  const [buying, setBuying] = useState(false);
  /**
   * 一次购买一个幂等键（与 `ShellContext` 的提交同一套路）。带上 `planId`/`cycle` 一起记，
   * 是因为换了档位或周期就是**另一次**购买——沿用同一个 key 会被服务端判成重放，用户
   * 会拿回上一档的订阅而不是他刚点的那档。提交成功才清空。
   */
  const purchaseKey = useRef<{ key: string; planId: string; cycle: PlanCycle } | null>(null);

  /* 兑换礼品码 */
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemErr, setRedeemErr] = useState<string | null>(null);

  /* 流水抽屉 */
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [ledgerErr, setLedgerErr] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // 取一次档位。失败不致命：我的方案卡照常显示（它读的是壳里的 `/api/me`）。
  useEffect(() => {
    let alive = true;
    void fetchSubscription().then(
      (next) => {
        if (alive) setState(next);
      },
      () => {
        if (alive) setStateErr("failed");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const notify = useCallback((text: string) => {
    setToast(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /** 拉一页流水。`before` 为空是第一页（换口径时要把上一次的结果丢掉）。 */
  const loadLedger = useCallback((next: Drawer, before?: string) => {
    if (!next) return;
    setLoading(true);
    setLedgerErr(null);
    void fetchLedger({ before, limit: 20, kind: next.kind }).then(
      (page) => {
        setLoading(false);
        setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
        setNextBefore(page.nextBefore);
      },
      () => {
        setLoading(false);
        setLedgerErr("failed");
      },
    );
  }, []);

  const openDrawer = useCallback(
    (next: NonNullable<Drawer>) => {
      setDrawer(next);
      setEntries([]);
      setNextBefore(undefined);
      loadLedger(next);
    },
    [loadLedger],
  );

  const redeem = useCallback(() => {
    const value = code.trim();
    if (!value || redeeming) return;
    setRedeeming(true);
    setRedeemErr(null);
    void redeemGiftCode(value).then(
      (result) => {
        setRedeeming(false);
        setRedeemOpen(false);
        setCode("");
        // 余额是壳的 `/api/me` 说了算：兑换回执只用来报数，真读数等重拉回来
        refreshMe();
        notify(t("subscription.redeem.success", { credits: creditsOf(result.amountCny) }));
      },
      (e: unknown) => {
        setRedeeming(false);
        setRedeemErr(redeemErrorMessage(e));
      },
    );
  }, [code, notify, redeeming, refreshMe, t]);

  const buy = useCallback(
    (plan: SubscriptionPlan) => {
      if (buying) return;
      setBuying(true);
      const cycle: PlanCycle = yearly ? "yearly" : "monthly";
      const held = purchaseKey.current;
      const key =
        held && held.planId === plan.id && held.cycle === cycle ? held.key : newIdempotencyKey();
      purchaseKey.current = { key, planId: plan.id, cycle };
      void purchaseSubscription(plan.id, cycle, key).then(
        (result) => {
          setBuying(false);
          setPending(null);
          purchaseKey.current = null;
          setState((prev) => (prev ? { ...prev, mine: result.mine } : prev));
          // 余额与会员积分都由壳的 `/api/me` 说了算，回执只是顺手带的。
          refreshMe();
          notify(t("subscription.toast.success"));
        },
        (e: unknown) => {
          setBuying(false);
          setPending(null);
          const code = subscriptionErrorCode(e);
          if (code === "insufficient_balance") notify(t("subscription.toast.insufficient"));
          else if (code === "subscription_active") notify(t("subscription.toast.active"));
          else notify(subscriptionErrorFallback(e) || t("subscription.toast.failed"));
        },
      );
    },
    [buying, notify, refreshMe, t, yearly],
  );

  const mine: MySubscription | null = state?.mine ?? null;
  const balance = me?.balance;
  const memberCredits = creditsOf(balance?.memberCreditsCny ?? mine?.memberCreditsCny ?? 0);
  const purchasedCredits = creditsOf(balance?.balanceCny ?? 0);
  const planName = (plan: { id: string; name: string }): string => {
    const key = PLAN_NAME_KEYS[plan.id];
    return key ? t(key) : plan.name;
  };
  const minePlan = state?.plans.find((p) => p.id === mine?.planId);

  return (
    <div className="sub-view">
      {/* 内容单独包一层承载入场动画：动画会让 .sub-view 成为 fixed 的包含块，轻提示就飘不到视口底部了 */}
      <div className="sub-view__body">
        <section className="sub-mine">
          <div className="sub-mine__head">
            <span className="sub-mine__title">{t("subscription.mine.title")}</span>
            <button
              type="button"
              className="sub-mine__link"
              onClick={() => openDrawer({ titleKey: "subscription.mine.usage" })}
            >
              {t("subscription.mine.usage")}
            </button>
            <button
              type="button"
              className="sub-mine__link sub-mine__link--end"
              // 账单只看充值 / 兑换那一类（消费明细在「积分使用详情」里）
              onClick={() => openDrawer({ titleKey: "subscription.mine.bills", kind: "grant" })}
            >
              {t("subscription.mine.bills")}
            </button>
          </div>
          <div className="sub-mine__body">
            <div className="sub-mine__ident">
              <span className="sub-mine__plan" data-plan={mine?.planId ?? "none"}>
                {mine ? (minePlan ? planName(minePlan) : planName({ id: mine.planId, name: mine.planId })) : t("subscription.mine.none")}
              </span>
              {mine ? (
                <span className="sub-mine__meta">
                  {t(
                    mine.cycle === "yearly"
                      ? "subscription.mine.cycleYearly"
                      : "subscription.mine.cycleMonthly",
                  )}
                  {" · "}
                  {t("subscription.mine.expiresAt", { date: day(mine.expiresAt) })}
                </span>
              ) : null}
            </div>
            <div className="sub-mine__stack">
              <span
                className="sub-mine__credits"
                aria-label={t("subscription.mine.creditsAria", { n: credits })}
              >
                <BoltIcon />
                {credits}
              </span>
              <div className="sub-mine__breakdown">
                <span>
                  {t("subscription.mine.daily")}{" "}
                  <span className="sub-mine__num">
                    {mine
                      ? t(
                          mine.dailyGrantedToday
                            ? "subscription.mine.dailyGranted"
                            : "subscription.mine.dailyPending",
                        )
                      : 0}
                  </span>
                </span>
                <span>
                  {t("subscription.mine.member")}{" "}
                  <span className="sub-mine__num" data-member-credits={memberCredits}>
                    {memberCredits}
                  </span>
                </span>
                <span>
                  {t("subscription.mine.purchased")}{" "}
                  <span className="sub-mine__num">{purchasedCredits}</span>
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="sub-mine__redeem"
            onClick={() => {
              setRedeemErr(null);
              setRedeemOpen(true);
            }}
          >
            {t("subscription.mine.redeem")}
          </button>
        </section>

        <div className="sub-plans__head">
          <h2 className="sub-plans__title">{t("subscription.plans.title")}</h2>
          <div className="sub-cycle" role="group" aria-label={t("subscription.plans.cycleAria")}>
            <button
              type="button"
              className="sub-cycle__btn"
              aria-pressed={yearly}
              data-cycle="yearly"
              data-on={yearly ? "true" : undefined}
              onClick={() => setYearly(true)}
            >
              {t("subscription.plans.yearly")}
            </button>
            <button
              type="button"
              className="sub-cycle__btn"
              aria-pressed={!yearly}
              data-cycle="monthly"
              data-on={!yearly ? "true" : undefined}
              onClick={() => setYearly(false)}
            >
              {t("subscription.plans.monthly")}
            </button>
          </div>
        </div>

        {state ? (
          <div className="sub-grid">
            {state.plans.map((plan, i) => {
              const current = mine?.planId === plan.id;
              return (
                <div
                  className="sub-card"
                  key={plan.id}
                  data-plan={plan.id}
                  data-popular={plan.popular ? "true" : undefined}
                >
                  {plan.popular ? (
                    <span className="sub-card__popular">{t("subscription.plan.popular")}</span>
                  ) : null}
                  <div className="sub-card__top">
                    <div className="sub-card__name-row">
                      <span
                        className="sub-card__name"
                        style={{ backgroundImage: NAME_GRADS[i % NAME_GRADS.length] }}
                      >
                        {planName(plan)}
                      </span>
                    </div>
                    {/* 价格恒定是「折合每月」：年付不打折，所以两个周期的月度数字相同，
                        差别写在下面那行（年付总额）与确认弹窗里的实扣金额上。 */}
                    <div className="sub-card__price-row">
                      <span className="sub-card__price">¥{money(plan.monthlyCny)}</span>
                      <span className="sub-card__unit">{t("subscription.card.perMonth")}</span>
                    </div>
                    <span className="sub-card__total">
                      {yearly
                        ? t("subscription.card.yearlyNote", {
                            total: money(plan.yearlyCny),
                            monthly: money(plan.monthlyCny),
                          })
                        : t("subscription.card.monthlyNote")}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="sub-card__cta"
                    disabled={buying || current}
                    onClick={() => setPending(plan)}
                  >
                    {current
                      ? t("subscription.card.current")
                      : buying
                        ? t("subscription.card.busy")
                        : t("subscription.card.subscribe")}
                  </button>
                  <div className="sub-card__features">
                    {plan.features.map((key) => (
                      <span className="sub-feature" key={key}>
                        <CheckIcon />
                        {isFeatureKey(key)
                          ? t(key, { credits: plan.credits, daily: plan.dailyCredits })
                          : key}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sub-plans__hint" role="status">
            {stateErr ? t("subscription.plans.error") : t("subscription.plans.loading")}
          </p>
        )}

        <p className="sub-basis">
          <span>{t("subscription.basis.note")}</span>
          <span>{t("subscription.basis.payFrom")}</span>
        </p>
      </div>

      {pending ? (
        <div
          className="redeem sub-confirm"
          role="dialog"
          aria-modal="true"
          aria-label={t("subscription.confirm.title")}
          onClick={() => (buying ? undefined : setPending(null))}
        >
          <div className="redeem__panel" onClick={(e) => e.stopPropagation()}>
            <span className="redeem__title">{t("subscription.confirm.title")}</span>
            <p className="redeem__hint">
              {t("subscription.confirm.body", {
                plan: planName(pending),
                cycle: t(
                  yearly ? "subscription.mine.cycleYearly" : "subscription.mine.cycleMonthly",
                ),
                price: money(yearly ? pending.yearlyCny : pending.monthlyCny),
              })}
            </p>
            <p className="redeem__hint">
              {t("subscription.confirm.credits", { credits: pending.credits })}{" "}
              {t("subscription.confirm.balance", { credits: purchasedCredits })}
            </p>
            <div className="redeem__actions">
              <button
                type="button"
                className="redeem__btn"
                disabled={buying}
                onClick={() => setPending(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="redeem__btn redeem__btn--go"
                disabled={buying}
                onClick={() => buy(pending)}
              >
                {buying ? t("subscription.card.busy") : t("subscription.confirm.go")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {redeemOpen ? (
        <div
          className="redeem"
          role="dialog"
          aria-modal="true"
          aria-label={t("subscription.redeem.title")}
          onClick={() => setRedeemOpen(false)}
        >
          <div className="redeem__panel" onClick={(e) => e.stopPropagation()}>
            <span className="redeem__title">{t("subscription.redeem.title")}</span>
            <p className="redeem__hint">{t("subscription.redeem.hint")}</p>
            <input
              className="redeem__input"
              aria-label={t("subscription.redeem.label")}
              placeholder={t("subscription.redeem.placeholder")}
              value={code}
              autoFocus
              maxLength={64}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  redeem();
                }
              }}
            />
            {redeemErr ? (
              <p className="redeem__err" role="alert">
                {redeemErr}
              </p>
            ) : null}
            <div className="redeem__actions">
              <button type="button" className="redeem__btn" onClick={() => setRedeemOpen(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="redeem__btn redeem__btn--go"
                disabled={redeeming || !code.trim()}
                onClick={redeem}
              >
                {redeeming ? t("subscription.redeem.busy") : t("subscription.redeem.go")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {drawer ? (
        <div
          className="ledger"
          role="dialog"
          aria-modal="true"
          aria-label={t(drawer.titleKey)}
          onClick={() => setDrawer(null)}
        >
          <div className="ledger__panel" onClick={(e) => e.stopPropagation()}>
            <div className="ledger__head">
              <span className="ledger__title">{t(drawer.titleKey)}</span>
              <button
                type="button"
                className="ledger__close"
                aria-label={t("common.close")}
                onClick={() => setDrawer(null)}
              >
                ✕
              </button>
            </div>
            <div className="ledger__body">
              {entries.length ? (
                <ul className="ledger__list">
                  {entries.map((e, i) => {
                    const n = creditsOf(e.amountCny);
                    const kindKey = LEDGER_KIND_KEYS[e.kind];
                    return (
                      <li className="ledger__item" key={`${e.at}-${i}`} data-kind={e.kind}>
                        <span className="ledger__when">{clock(e.at)}</span>
                        <span className="ledger__kind">{kindKey ? t(kindKey) : e.kind}</span>
                        <span className="ledger__note">{e.note ?? e.jobId ?? ""}</span>
                        <span className="ledger__amount" data-sign={n >= 0 ? "plus" : "minus"}>
                          {n >= 0 ? `+${n}` : n}
                        </span>
                        <span className="ledger__after">
                          {t("subscription.ledger.after", { credits: creditsOf(e.balanceAfterCny) })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : loading ? null : (
                <p className="ledger__empty">{t("subscription.ledger.empty")}</p>
              )}
              {ledgerErr ? (
                <p className="ledger__err" role="alert">
                  {t("subscription.ledger.error")}
                </p>
              ) : null}
              {loading ? <p className="ledger__empty">{t("subscription.ledger.loading")}</p> : null}
              {nextBefore && !loading ? (
                <button
                  type="button"
                  className="ledger__more"
                  onClick={() => loadLedger(drawer, nextBefore)}
                >
                  {t("subscription.ledger.more")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="sub-toast" role="status" aria-live="polite">
        {toast ? <span className="sub-toast__pill">{toast}</span> : null}
      </div>
    </div>
  );
}
