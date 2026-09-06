"use client";

import { useMemo, useState } from "react";
import { TOOLS, TOOL_CATS, shot } from "./data";
import { IconClose, IconFilter, IconSearch } from "./icons";

type Props = {
  onClose: () => void;
  onApply: (toolName: string) => void;
};

const TABS = ["社区工具", "我的工具"] as const;

/** 工具箱抽屉（原型图 30）：400 宽，社区 / 我的工具 + 搜索 + 分类芯片 + 工具列表。 */
export default function CanvasToolbox({ onClose, onApply }: Props) {
  const [tab, setTab] = useState<string>(TABS[0]);
  const [cat, setCat] = useState<string>(TOOL_CATS[0]);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = tab === "我的工具" ? TOOLS.slice(0, 3) : TOOLS;
    return base.filter(
      (t) => (cat === "全部" || t.cat === cat) && (q === "" || t.name.toLowerCase().includes(q)),
    );
  }, [tab, cat, query]);

  return (
    <aside className="canvas-toolbox" aria-label="工具箱">
      <div className="canvas-toolbox__head">
        <span className="canvas-toolbox__title">工具箱</span>
        <button type="button" className="canvas-toolbox__close" aria-label="关闭工具箱" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="canvas-toolbox__tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t}
            className="canvas-toolbox__tab"
            aria-pressed={t === tab}
            data-on={t === tab ? "true" : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="canvas-toolbox__search-row">
        <span className="canvas-toolbox__search">
          <IconSearch />
          <input
            className="canvas-toolbox__input"
            value={query}
            aria-label="搜索工具"
            placeholder="搜索工具"
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <button type="button" className="canvas-toolbox__filter" aria-label="筛选">
          <IconFilter />
        </button>
      </div>

      <div className="canvas-toolbox__cats">
        {TOOL_CATS.map((c) => (
          <button
            type="button"
            key={c}
            className="canvas-toolbox__cat"
            aria-pressed={c === cat}
            data-on={c === cat ? "true" : undefined}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="canvas-toolbox__list">
        {rows.map((t, i) => (
          <div className="canvas-tool" key={t.name}>
            <span className="canvas-tool__shot" style={{ backgroundImage: `url(${shot(i)})` }} />
            <span className="canvas-tool__body">
              <span className="canvas-tool__name">{t.name}</span>
              <span className="canvas-tool__meta">{t.uses} 次使用 · 作者 hu…</span>
            </span>
            <button type="button" className="canvas-tool__apply" onClick={() => onApply(t.name)}>
              应用到画布
            </button>
          </div>
        ))}
        {rows.length === 0 ? <p className="canvas-toolbox__empty">没有匹配的工具。</p> : null}
      </div>
    </aside>
  );
}
