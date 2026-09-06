"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLedger,
  redeemErrorMessage,
  redeemGiftCode,
  type LedgerEntry,
} from "@/lib/client/auth";
import { creditsOf, useShell } from "@/components/genius/ShellContext";

type Plan = {
  name: string;
  off: string;
  monthly: number;
  yearly: number;
  popular?: boolean;
  features: string[];
};

/** 四档方案（原型 PLANS）。价格为原型占位值，未与后端人民币计费对齐。 */
const PLANS: Plan[] = [
  {
    name: "标准版",
    off: "立减 20%",
    monthly: 9,
    yearly: 7,
    features: [
      "每日更新积分 60",
      "1200 积分每 30 天重置",
      "无水印 · 无广告",
      "最高 720P 输出",
      "3 路并发生成",
      "预览模式节省 20% 积分",
    ],
  },
  {
    name: "专业版",
    off: "立减 20%",
    monthly: 29,
    yearly: 23,
    features: [
      "每日更新积分 60",
      "6000 积分每 30 天重置",
      "无水印 · 无广告",
      "最高 4K 输出",
      "5 路并发生成",
      "错峰模式节省 30% 积分",
      "批量生成",
    ],
  },
  {
    name: "尊享版",
    off: "立减 20%",
    monthly: 59,
    yearly: 47,
    features: [
      "每日更新积分 60",
      "15000 积分每 30 天重置",
      "无水印 · 无广告",
      "最高 4K 输出",
      "8 路并发生成",
      "错峰模式节省 50% 积分",
      "批量生成 · 优先队列",
    ],
  },
  {
    name: "至尊版",
    off: "立减 40%",
    monthly: 149,
    yearly: 89,
    popular: true,
    features: [
      "每日更新积分 60",
      "25000 积分每 30 天重置",
      "无水印 · 无广告",
      "最高 4K 输出",
      "8 路并发生成",
      "错峰模式无限次生成",
      "批量生成 · 专属支持",
    ],
  },
];

/** 方案名的渐变文字（原型 NAME_GRAD）。 */
const NAME_GRADS = [
  "linear-gradient(90deg,#f0f0f2,#a9abb4)",
  "linear-gradient(90deg,#8ec5ff,#5b8cff)",
  "linear-gradient(90deg,#ffc48a,#ff8a3d)",
  "linear-gradient(90deg,#ff8a3d,#ff4d8d 60%,#a855f7)",
];

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

/** 流水条目的 `kind` → 中文（`src/lib/billing/ledger.ts` 的三种）。认不出的码原样显示。 */
const LEDGER_KIND: Record<string, string> = {
  grant: "充值 / 兑换",
  charge: "任务扣款",
  adjust: "人工调整",
};

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 抽屉的两种口径：全部流水（积分使用详情）/ 只看充值（账单记录）。 */
type Drawer = null | { title: string; kind?: string };

/**
 * 订阅视图（交接包 §7，原型图 16-subscription）。
 * 我的方案卡的 ⚡ 读真实积分；「兑换礼品码」「积分使用详情」「账单记录」接真后端
 * （阶段 A §7），四档订阅卡仍是占位，按钮只弹「即将上线」。
 */
export default function SubscriptionView({ credits }: { credits: number }) {
  const { refreshMe } = useShell();
  const [yearly, setYearly] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const notify = useCallback((text: string) => {
    setToast(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2200);
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
      (e: unknown) => {
        setLoading(false);
        setLedgerErr(e instanceof Error ? e.message : "读取失败，请稍后再试");
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
        notify(`兑换成功，到账 ⚡${creditsOf(result.amountCny)}`);
      },
      (e: unknown) => {
        setRedeeming(false);
        setRedeemErr(redeemErrorMessage(e));
      },
    );
  }, [code, notify, redeeming, refreshMe]);

  return (
    <div className="sub-view">
      {/* 内容单独包一层承载入场动画：动画会让 .sub-view 成为 fixed 的包含块，轻提示就飘不到视口底部了 */}
      <div className="sub-view__body">
        <section className="sub-mine">
          <div className="sub-mine__head">
            <span className="sub-mine__title">我的方案</span>
            <button
              type="button"
              className="sub-mine__link"
              onClick={() => openDrawer({ title: "积分使用详情" })}
            >
              积分使用详情
            </button>
            <button
              type="button"
              className="sub-mine__link sub-mine__link--end"
              // 账单只看充值 / 兑换那一类（消费明细在「积分使用详情」里）
              onClick={() => openDrawer({ title: "账单记录", kind: "grant" })}
            >
              账单记录
            </button>
          </div>
          <div className="sub-mine__body">
            <span className="sub-mine__plan">基础版</span>
            <div className="sub-mine__stack">
              <span className="sub-mine__credits" aria-label={`积分 ${credits}`}>
                <BoltIcon />
                {credits}
              </span>
              <div className="sub-mine__breakdown">
                <span>
                  每日积分 <span className="sub-mine__num">0</span>
                </span>
                <span>
                  会员积分 <span className="sub-mine__num">0</span>
                </span>
                <span>
                  已购积分 <span className="sub-mine__num">{credits}</span>
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
            兑换礼品码
          </button>
        </section>

        <div className="sub-plans__head">
          <h2 className="sub-plans__title">订阅方案</h2>
          <div className="sub-cycle" role="group" aria-label="计费周期">
            <button
              type="button"
              className="sub-cycle__btn"
              aria-pressed={yearly}
              data-on={yearly ? "true" : undefined}
              onClick={() => setYearly(true)}
            >
              按年支付
              <span className="sub-cycle__badge">立减 40%</span>
            </button>
            <button
              type="button"
              className="sub-cycle__btn"
              aria-pressed={!yearly}
              data-on={!yearly ? "true" : undefined}
              onClick={() => setYearly(false)}
            >
              按月支付
            </button>
          </div>
        </div>

        <div className="sub-grid">
          {PLANS.map((p, i) => {
            const price = yearly ? p.yearly : p.monthly;
            return (
              <div className="sub-card" key={p.name} data-popular={p.popular ? "true" : undefined}>
                {p.popular ? <span className="sub-card__popular">最受欢迎</span> : null}
                <div className="sub-card__top">
                  <div className="sub-card__name-row">
                    <span className="sub-card__name" style={{ backgroundImage: NAME_GRADS[i] }}>
                      {p.name}
                    </span>
                    {yearly ? <span className="sub-card__off">{p.off}</span> : null}
                  </div>
                  {/*
                    用户可见的价格一律人民币（AGENTS.md：售价是 CNY，¥1 = 100 积分）。
                    原型这几个数字是 $ 占位，符号换成 ¥ 但数值原样留着——真实档位由用户定，
                    在这里替他编一个人民币价才是更大的错。
                  */}
                  <div className="sub-card__price-row">
                    <span className="sub-card__price">¥{price}</span>
                    <span className="sub-card__unit">/月</span>
                    {yearly ? <span className="sub-card__was">¥{p.monthly}</span> : null}
                  </div>
                  <span className="sub-card__total">
                    {yearly ? `年付费用为 ¥${price * 12}` : "按月支付，可随时取消"}
                  </span>
                </div>
                <button
                  type="button"
                  className="sub-card__cta"
                  onClick={() => notify(`${p.name}订阅即将上线`)}
                >
                  订阅
                </button>
                <div className="sub-card__features">
                  {p.features.map((f) => (
                    <span className="sub-feature" key={f}>
                      <CheckIcon />
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {redeemOpen ? (
        <div
          className="redeem"
          role="dialog"
          aria-modal="true"
          aria-label="兑换礼品码"
          onClick={() => setRedeemOpen(false)}
        >
          <div className="redeem__panel" onClick={(e) => e.stopPropagation()}>
            <span className="redeem__title">兑换礼品码</span>
            <p className="redeem__hint">输入礼品码，积分立即到账（¥1 = 100 积分）。</p>
            <input
              className="redeem__input"
              aria-label="礼品码"
              placeholder="例如 GIFT-XXXX-XXXX"
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
                取消
              </button>
              <button
                type="button"
                className="redeem__btn redeem__btn--go"
                disabled={redeeming || !code.trim()}
                onClick={redeem}
              >
                {redeeming ? "兑换中…" : "兑换"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {drawer ? (
        <div className="ledger" role="dialog" aria-modal="true" aria-label={drawer.title} onClick={() => setDrawer(null)}>
          <div className="ledger__panel" onClick={(e) => e.stopPropagation()}>
            <div className="ledger__head">
              <span className="ledger__title">{drawer.title}</span>
              <button type="button" className="ledger__close" aria-label="关闭" onClick={() => setDrawer(null)}>
                ✕
              </button>
            </div>
            <div className="ledger__body">
              {entries.length ? (
                <ul className="ledger__list">
                  {entries.map((e, i) => {
                    const n = creditsOf(e.amountCny);
                    return (
                      <li className="ledger__item" key={`${e.at}-${i}`} data-kind={e.kind}>
                        <span className="ledger__when">{clock(e.at)}</span>
                        <span className="ledger__kind">{LEDGER_KIND[e.kind] ?? e.kind}</span>
                        <span className="ledger__note">{e.note ?? e.jobId ?? ""}</span>
                        <span className="ledger__amount" data-sign={n >= 0 ? "plus" : "minus"}>
                          {n >= 0 ? `+${n}` : n}
                        </span>
                        <span className="ledger__after">余 {creditsOf(e.balanceAfterCny)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : loading ? null : (
                <p className="ledger__empty">还没有记录。</p>
              )}
              {ledgerErr ? (
                <p className="ledger__err" role="alert">
                  {ledgerErr}
                </p>
              ) : null}
              {loading ? <p className="ledger__empty">读取中…</p> : null}
              {nextBefore && !loading ? (
                <button type="button" className="ledger__more" onClick={() => loadLedger(drawer, nextBefore)}>
                  加载更多
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
