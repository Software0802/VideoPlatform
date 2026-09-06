"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALL_SKILLS, shot } from "./data";
import { IconChevronDown, IconChevronLeft } from "./icons";

type Props = {
  off: Record<number, boolean>;
  onToggle: (index: number) => void;
  onBack: () => void;
};

const FILTERS = ["全部", "已启用", "已关闭"] as const;
type Filter = (typeof FILTERS)[number];

/** 技能广场（原型图 22）：返回圆钮 + 居中标题 + 右侧筛选 + 卡片网格。 */
export default function AgentPlaza({ off, onToggle, onBack }: Props) {
  const [filter, setFilter] = useState<Filter>("全部");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = boxRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const rows = useMemo(
    () =>
      ALL_SKILLS.map((s, i) => ({ ...s, index: i, on: !off[i] })).filter((r) =>
        filter === "全部" ? true : filter === "已启用" ? r.on : !r.on,
      ),
    [off, filter],
  );

  return (
    <div className="agent-view__scroll">
      <div className="agent-plaza">
        <div className="agent-plaza__head">
          <button type="button" className="agent-round" aria-label="返回智能体" onClick={onBack}>
            <IconChevronLeft />
          </button>
          <span className="agent-plaza__title">技能广场</span>
          <div className="agent-ask__slot" ref={boxRef}>
            <button
              type="button"
              className="agent-chip agent-chip--tall"
              aria-expanded={open}
              aria-haspopup="menu"
              data-open={open ? "true" : undefined}
              onClick={() => setOpen((v) => !v)}
            >
              {filter}
              <IconChevronDown />
            </button>
            {open ? (
              <div className="agent-pop agent-pop--filter" role="menu">
                {FILTERS.map((f) => (
                  <button
                    type="button"
                    key={f}
                    role="menuitem"
                    className="agent-pop__plain"
                    data-current={f === filter ? "true" : undefined}
                    onClick={() => {
                      setFilter(f);
                      close();
                    }}
                  >
                    <span className="agent-pop__dot" />
                    {f}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="agent-plaza__grid">
          {rows.map((r) => (
            <div className="agent-plaza-card" key={r.name}>
              <span
                className="agent-plaza-card__shot"
                style={{ backgroundImage: `url(${shot(r.index)})` }}
              />
              <div className="agent-plaza-card__body">
                <span className="agent-plaza-card__name">{r.name}</span>
                <span className="agent-plaza-card__desc">{r.desc}</span>
              </div>
              <div className="agent-plaza-card__foot">
                <span className="agent-plaza-card__meta">
                  @Genius · {r.uses}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.on}
                  aria-label={`启用技能 ${r.name}`}
                  className="agent-switch"
                  data-on={r.on ? "true" : "false"}
                  onClick={() => onToggle(r.index)}
                >
                  <span className="agent-switch__knob" />
                </button>
              </div>
            </div>
          ))}
        </div>
        {rows.length === 0 ? <p className="agent-plaza__empty">没有符合条件的技能。</p> : null}
      </div>
    </div>
  );
}
