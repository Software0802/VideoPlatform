"use client";

import { useEffect, useMemo, useState } from "react";
import { TOOL_CATS, TOOL_CAT_ALL, TOOL_CAT_KEY, type ToolCat, type ToolCatFilter } from "./data";
import { IconClose, IconSearch } from "./icons";
import { useT, type Translate } from "@/components/genius/i18n/I18nProvider";
import { fetchTemplates } from "@/lib/client/templates";
import { fetchJobsPage } from "@/lib/client/jobs";
import type { MessageKey } from "@/lib/i18n/messages";

/**
 * 工具箱抽屉（原型图 30）：左侧工具栏点开，把一段现成的提示词放进画布。
 *
 * 两个页签都是真数据，不是原型那份写死的 TOOLS：
 * - 「模板」= `GET /api/templates`（运维维护的预置提示词，与主页模板页签同源）；
 * - 「我的」= `GET /api/jobs` 里成功作品的提示词，按提示词去重、新的在前。
 *
 * 搜索与分类是**本地过滤**（两份清单都已经在手里，没必要为一次筛选再跑一趟服务端）。
 * 「应用到画布」不改现有节点：它在画布上新建一个对应类型的生成节点并填好提示词，
 * 由 `CanvasView` 落盘——工具箱自己不碰文档。
 */

export type ToolboxPick = { kind: ToolCat; prompt: string; name: string };

type Row = {
  key: string;
  name: string;
  meta: string;
  prompt: string;
  kind: ToolCat;
  cover?: string;
};

const TABS = [
  { id: "template", labelKey: "canvas.toolbox.tab.template" },
  { id: "mine", labelKey: "canvas.toolbox.tab.mine" },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];

type TabId = (typeof TABS)[number]["id"];

/** 作品一次拉这么多；工具箱是「最近用过的提示词」，不做分页。 */
const MINE_LIMIT = 60;

function shortDate(iso: string, t: Translate): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return t("canvas.toolbox.meta.mine");
  return new Date(ms).toLocaleDateString();
}

export default function CanvasToolbox({
  onClose,
  onApply,
}: {
  onClose: () => void;
  onApply: (pick: ToolboxPick) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<TabId>("template");
  const [cat, setCat] = useState<ToolCatFilter>(TOOL_CAT_ALL);
  const [query, setQuery] = useState("");
  const [templates, setTemplates] = useState<Row[] | null>(null);
  const [mine, setMine] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
    两份清单各拉一次并留在内存里：切页签、改分类、打字都只是本地过滤。`t` 会随语言
    切换换引用，所以错误文案在失败那一刻取，effect 本身只跑一次。
  */
  useEffect(() => {
    let alive = true;
    void fetchTemplates().then(
      (list) => {
        if (!alive) return;
        setTemplates(
          list.map((item) => ({
            key: `tpl:${item.id}`,
            name: item.name,
            meta: item.category,
            prompt: item.prompt,
            kind: item.mode === "text_to_image" ? "image" : "video",
            ...(item.cover ? { cover: item.cover } : {}),
          })),
        );
      },
      () => {
        if (alive) setTemplates([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (tab !== "mine" || mine) return;
    let alive = true;
    void fetchJobsPage({ limit: MINE_LIMIT }).then(
      (page) => {
        if (!alive) return;
        const seen = new Set<string>();
        const rows: Row[] = [];
        for (const job of page.jobs) {
          const prompt = job.prompt?.trim();
          if (job.status !== "succeeded" || !prompt || seen.has(prompt)) continue;
          seen.add(prompt);
          rows.push({
            key: `job:${job.id}`,
            name: prompt,
            meta: shortDate(job.createdAt, t),
            prompt,
            kind: job.mode === "text_to_image" ? "image" : "video",
            ...(job.output?.kind === "image"
              ? { cover: job.output.imageUrl }
              : job.output?.kind === "video" && job.output.posterUrl
                ? { cover: job.output.posterUrl }
                : {}),
          });
        }
        setMine(rows);
      },
      () => {
        if (!alive) return;
        setMine([]);
        setError(t("canvas.toolbox.mineError"));
      },
    );
    return () => {
      alive = false;
    };
  }, [tab, mine, t]);

  const source = tab === "template" ? templates : mine;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (source ?? []).filter(
      (row) =>
        (cat === TOOL_CAT_ALL || row.kind === cat) &&
        (q === "" || row.name.toLowerCase().includes(q) || row.prompt.toLowerCase().includes(q)),
    );
  }, [source, cat, query]);

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
        {rows.map((row) => (
          <div className="canvas-tool" key={row.key} data-kind={row.kind}>
            <span
              className="canvas-tool__shot"
              style={row.cover ? { backgroundImage: `url(${row.cover})` } : undefined}
            />
            <span className="canvas-tool__body">
              <span className="canvas-tool__name" title={row.prompt}>
                {row.name}
              </span>
              <span className="canvas-tool__meta">{row.meta}</span>
            </span>
            <button
              type="button"
              className="canvas-tool__apply"
              onClick={() => onApply({ kind: row.kind, prompt: row.prompt, name: row.name })}
            >
              {t("canvas.toolbox.apply")}
            </button>
          </div>
        ))}
        {source === null ? (
          <p className="canvas-toolbox__empty">{t("common.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="canvas-toolbox__empty">
            {error ?? (tab === "mine" ? t("canvas.toolbox.emptyMine") : t("canvas.toolbox.empty"))}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
