"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import type { AgentSkill } from "@/lib/client/agent";
import { shot } from "./data";
import { IconChevronDown, IconChevronLeft } from "./icons";

type Props = {
  skills: AgentSkill[];
  /** `true` = 这个技能被用户关掉了（只存在浏览器本地，见 `AgentView`）。 */
  off: Record<string, boolean>;
  onToggle: (id: string) => void;
  onBack: () => void;
};

const FILTERS = ["all", "on", "off"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_KEY = {
  all: "agent.filterAll",
  on: "agent.filterOn",
  off: "agent.filterOff",
} as const;

/** 技能广场：返回圆钮 + 居中标题 + 右侧筛选 + 卡片网格。技能来自 `GET /api/agent/skills`。 */
export default function AgentPlaza({ skills, off, onToggle, onBack }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
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
      skills
        .map((s, index) => ({ ...s, index, on: !off[s.id] }))
        .filter((r) => (filter === "all" ? true : filter === "on" ? r.on : !r.on)),
    [skills, off, filter],
  );

  return (
    <div className="agent-view__scroll">
      <div className="agent-plaza">
        <div className="agent-plaza__head">
          <button type="button" className="agent-round" aria-label={t("agent.back")} onClick={onBack}>
            <IconChevronLeft />
          </button>
          <span className="agent-plaza__title">{t("agent.plazaTitle")}</span>
          <div className="agent-ask__slot" ref={boxRef}>
            <button
              type="button"
              className="agent-chip agent-chip--tall"
              aria-expanded={open}
              aria-haspopup="menu"
              data-open={open ? "true" : undefined}
              onClick={() => setOpen((v) => !v)}
            >
              {t(FILTER_KEY[filter])}
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
                    {t(FILTER_KEY[f])}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="agent-plaza__grid">
          {rows.map((r) => (
            <div className="agent-plaza-card" key={r.id} data-skill-id={r.id}>
              <span
                className="agent-plaza-card__shot"
                style={{ backgroundImage: `url(${shot(r.index)})` }}
              />
              <div className="agent-plaza-card__body">
                <span className="agent-plaza-card__name">{r.name[locale]}</span>
                <span className="agent-plaza-card__desc">{r.desc[locale]}</span>
              </div>
              <div className="agent-plaza-card__foot">
                <span className="agent-plaza-card__meta">{t("agent.author")}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.on}
                  aria-label={t("agent.enableSkill", { name: r.name[locale] })}
                  className="agent-switch"
                  data-on={r.on ? "true" : "false"}
                  onClick={() => onToggle(r.id)}
                >
                  <span className="agent-switch__knob" />
                </button>
              </div>
            </div>
          ))}
        </div>
        {rows.length === 0 ? <p className="agent-plaza__empty">{t("agent.plazaEmpty")}</p> : null}
      </div>
    </div>
  );
}
