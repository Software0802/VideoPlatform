"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

/**
 * 订阅视图（交接包 §7，原型图 16-subscription）。
 * 我的方案卡的 ⚡ 读真实积分；订阅相关按钮全部只弹「即将上线」轻提示，不发请求。
 */
export default function SubscriptionView({ credits }: { credits: number }) {
  const [yearly, setYearly] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <div className="sub-view">
      {/* 内容单独包一层承载入场动画：动画会让 .sub-view 成为 fixed 的包含块，轻提示就飘不到视口底部了 */}
      <div className="sub-view__body">
        <section className="sub-mine">
          <div className="sub-mine__head">
            <span className="sub-mine__title">我的方案</span>
            <button type="button" className="sub-mine__link" onClick={() => notify("积分使用详情即将上线")}>
              积分使用详情
            </button>
            <button
              type="button"
              className="sub-mine__link sub-mine__link--end"
              onClick={() => notify("账单记录即将上线")}
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
          <button type="button" className="sub-mine__redeem" onClick={() => notify("兑换礼品码即将上线")}>
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
                  <div className="sub-card__price-row">
                    <span className="sub-card__price">${price}</span>
                    <span className="sub-card__unit">/月</span>
                    {yearly ? <span className="sub-card__was">${p.monthly}</span> : null}
                  </div>
                  <span className="sub-card__total">
                    {yearly ? `年付费用为 $${price * 12}` : "按月支付，可随时取消"}
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

      <div className="sub-toast" role="status" aria-live="polite">
        {toast ? <span className="sub-toast__pill">{toast}</span> : null}
      </div>
    </div>
  );
}
