/*
  Mono-Color 设计系统的三个标记组件，按 _ds_bundle.js 的几何复刻：
  都是「规则线 + 单行 mono 文字」，只用页面的两种墨（钴蓝 / 赭红）。
*/

export function SectionRule({
  number,
  title,
  subtitle,
  weight = 2,
}: {
  number?: string;
  title?: string;
  subtitle?: string;
  weight?: number;
}) {
  return (
    <div className="rule-section">
      <div className="rule-section__row">
        {number ? <span className="rule-section__index">{number}</span> : null}
        {title ? <span className="rule-section__title">{title}</span> : null}
        {subtitle ? <span className="rule-section__sub">{subtitle}</span> : null}
      </div>
      <div className="rule-section__line" style={{ height: weight }} />
    </div>
  );
}

export function RegistrationMark({ size = 28, ink = "currentColor", weight = 1.5 }: { size?: number; ink?: string; weight?: number }) {
  const c = size / 2;
  const r = size * 0.3;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ display: "block" }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={ink} strokeWidth={weight} />
      <line x1={c} y1={0} x2={c} y2={size} stroke={ink} strokeWidth={weight} />
      <line x1={0} y1={c} x2={size} y2={c} stroke={ink} strokeWidth={weight} />
    </svg>
  );
}

export function RuledDataStrip({ items, weight = 4, size = 13 }: { items: string[]; weight?: number; size?: number }) {
  return (
    <div className="rule-strip">
      <div className="rule-strip__line" style={{ height: weight }} />
      <div className="rule-strip__row" style={{ fontSize: size }}>
        {items.map((it) => (
          <span key={it}>{it}</span>
        ))}
      </div>
    </div>
  );
}
