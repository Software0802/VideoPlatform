"use client";

import { useMemo, useState } from "react";
import { TOOLS, TOOL_CATS, TOOL_CAT_ALL, TOOL_CAT_KEY, shot, type ToolCatFilter } from "./data";
import { IconClose, IconFilter, IconSearch } from "./icons";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

type Props = {
  onClose: () => void;
  onApply: (toolName: string) => void;
};

/** 两个页签的 id 是 ASCII，显示名在字典里。 */
const TABS = [
  { id: "community", labelKey: "canvas.toolbox.tab.community" },
  { id: "mine", labelKey: "canvas.toolbox.tab.mine" },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];

/** 工具箱抽屉（原型图 30）：400 宽，社区 / 我的工具 + 搜索 + 分类芯片 + 工具列表。 */
export default function CanvasToolbox({ onClose, onApply }: Props) {
  const t = useT();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("community");
  const [cat, setCat] = useState<ToolCatFilter>(TOOL_CAT_ALL);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = tab === "mine" ? TOOLS.slice(0, 3) : TOOLS;
    return base.filter(
      (tool) => (cat === TOOL_CAT_ALL || tool.cat === cat) && (q === "" || tool.name.toLowerCase().includes(q)),
    );
  }, [tab, cat, query]);

  return (
    <aside className="canvas-toolbox" aria-label={t("canvas.toolbox.title")}>
      <div className="canvas-toolbox__head">
        <span className="canvas-toolbox__title">{t("canvas.toolbox.title")}</span>
        <button
          type="button"
          className="canvas-toolbox__close"
          aria-label={t("canvas.toolbox.close")}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      <div className="canvas-toolbox__tabs">
        {TABS.map((item) => (
          <button
            type="button"
            key={item.id}
            className="canvas-toolbox__tab"
            data-tab={item.id}
            aria-pressed={item.id === tab}
            data-on={item.id === tab ? "true" : undefined}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      <div className="canvas-toolbox__search-row">
        <span className="canvas-toolbox__search">
          <IconSearch />
          <input
            className="canvas-toolbox__input"
            value={query}
            aria-label={t("canvas.toolbox.search")}
            placeholder={t("canvas.toolbox.search")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <button type="button" className="canvas-toolbox__filter" aria-label={t("canvas.toolbox.filter")}>
          <IconFilter />
        </button>
      </div>

      <div className="canvas-toolbox__cats">
        {TOOL_CATS.map((c) => (
          <button
            type="button"
            key={c}
            className="canvas-toolbox__cat"
            data-cat={c}
            aria-pressed={c === cat}
            data-on={c === cat ? "true" : undefined}
            onClick={() => setCat(c)}
          >
            {t(TOOL_CAT_KEY[c])}
          </button>
        ))}
      </div>

      <div className="canvas-toolbox__list">
        {rows.map((tool, i) => (
          <div className="canvas-tool" key={tool.name}>
            <span className="canvas-tool__shot" style={{ backgroundImage: `url(${shot(i)})` }} />
            <span className="canvas-tool__body">
              <span className="canvas-tool__name">{tool.name}</span>
              <span className="canvas-tool__meta">{t("canvas.toolbox.uses", { n: tool.uses })}</span>
            </span>
            <button type="button" className="canvas-tool__apply" onClick={() => onApply(tool.name)}>
              {t("canvas.toolbox.apply")}
            </button>
          </div>
        ))}
        {rows.length === 0 ? <p className="canvas-toolbox__empty">{t("canvas.toolbox.empty")}</p> : null}
      </div>
    </aside>
  );
}
