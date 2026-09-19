"use client";

import type { RefObject } from "react";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { CanvasQuote } from "@/lib/client/canvas";
import { IconBolt, IconClose } from "./icons";

/** 右上角运行钮：有 run 在跑时变「取消」。`doc.nodes.length > 0` 的挂载条件留在 CanvasView。 */
export function RunBar({
  running,
  runBusy,
  onRunAll,
  onCancel,
}: {
  running: boolean;
  runBusy: boolean;
  onRunAll: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="canvas-topright">
      {running ? (
        <button type="button" className="canvas-topright__btn" onClick={onCancel}>
          {t("canvas.runCancel")}
        </button>
      ) : (
        <button
          type="button"
          className="canvas-topright__btn"
          disabled={runBusy}
          onClick={onRunAll}
        >
          <IconBolt size={12} />
          {t("canvas.runAll")}
        </button>
      )}
    </div>
  );
}

/**
 * 整图运行的报价弹层（D 包）：逐节点价格 + 审批门勾选（`gates`）+
 * 复用/已清位的「重跑」勾选（`regen`）。`useDismiss` 的点外层/Esc 收层在 CanvasView。
 */
export function QuoteDialog({
  quote,
  gates,
  regen,
  runBusy,
  dialogRef,
  onToggleGate,
  onToggleRegen,
  onConfirm,
  onClose,
}: {
  quote: CanvasQuote;
  gates: Set<string>;
  regen: Set<string>;
  runBusy: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  onToggleGate: (nodeId: string, on: boolean) => void;
  onToggleRegen: (nodeId: string, on: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="canvas-quote" ref={dialogRef} role="dialog" aria-label={t("canvas.quote.title")}>
      <div className="canvas-quote__head">
        <span className="canvas-quote__title">{t("canvas.quote.title")}</span>
        <button
          type="button"
          className="canvas-quote__close"
          aria-label={t("canvas.quote.cancel")}
          onClick={onClose}
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="canvas-quote__items">
        {quote.items.map((item) => (
          <div className="canvas-quote__item" key={item.nodeId}>
            <span className="canvas-quote__item-kind">
              {t(`canvas.kind.${item.kind}` as Parameters<typeof t>[0])}
            </span>
            <span className="canvas-quote__item-summary" title={item.summary}>
              {item.productName ?? item.mode} · {item.summary}
            </span>
            {item.reused || item.purged ? (
              <label className="canvas-quote__check">
                <input
                  type="checkbox"
                  checked={regen.has(item.nodeId)}
                  disabled={runBusy}
                  onChange={(e) => onToggleRegen(item.nodeId, e.target.checked)}
                />
                {t("canvas.quote.regen")}
              </label>
            ) : (
              <label className="canvas-quote__check">
                <input
                  type="checkbox"
                  checked={gates.has(item.nodeId)}
                  disabled={runBusy}
                  onChange={(e) => onToggleGate(item.nodeId, e.target.checked)}
                />
                {t("canvas.quote.approveFirst")}
              </label>
            )}
            <span className="canvas-quote__item-price">¥{item.priceCny.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="canvas-quote__foot">
        <span className="canvas-quote__note">
          {t("canvas.quote.note")}
          {quote.reusedCount
            ? ` · ${t("canvas.quote.reused", { n: quote.reusedCount })}`
            : ""}
        </span>
        <span className="canvas-quote__total">
          {t("canvas.quote.total")} ¥{quote.totalCny.toFixed(2)}
        </span>
        <button
          type="button"
          className="canvas-quote__confirm"
          disabled={runBusy}
          onClick={onConfirm}
        >
          {t("canvas.quote.confirm")}
        </button>
      </div>
    </div>
  );
}
