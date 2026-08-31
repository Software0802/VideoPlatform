"use client";

const LATER = [30, 45, 60];

export function DurationPicker({
  value,
  onChange,
  disabled,
  helper,
  native = Array.from({ length: 15 }, (_, index) => index + 1),
  showLater = true,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  helper?: string;
  native?: number[];
  showLater?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label="时长"
        className="grid grid-cols-[repeat(auto-fit,minmax(48px,1fr))] gap-px overflow-hidden rounded-xl border border-line bg-line"
      >
        {native.map((n) => {
          const active = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(n)}
              className={`min-h-11 px-3 py-2.5 font-mono text-[13px] tracking-wider transition-colors duration-150 ${
                active
                  ? "bg-accent font-semibold text-accent-ink"
                  : "bg-panel text-muted hover:bg-raise hover:text-ink"
              }`}
            >
              {n}s
            </button>
          );
        })}
        {(showLater ? LATER : []).map((n) => (
          <button
            key={n}
            type="button"
            disabled
            aria-label={`${n} 秒，即将推出，由一致性管线拼接`}
            title="即将推出 · 由一致性管线拼接"
            className="min-h-11 cursor-not-allowed bg-panel px-3 py-2.5 font-mono text-[13px] tracking-wider text-faint"
            style={{
              backgroundImage:
                "repeating-linear-gradient(-45deg, transparent 0 5px, oklch(0.92 0.01 90 / 4%) 5px 7px)",
            }}
          >
            {n}s
            <span className="ml-1.5 text-[9px] uppercase tracking-wider text-accent/50">
              即将推出
            </span>
          </button>
        ))}
      </div>
      {showLater ? (
        <p className="text-xs leading-relaxed text-muted">
          30/45/60 秒即将推出 · 由一致性管线拼接
        </p>
      ) : null}
      {helper ? <p className="text-xs leading-relaxed text-muted">{helper}</p> : null}
    </div>
  );
}
