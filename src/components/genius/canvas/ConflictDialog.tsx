"use client";

import type { RefObject } from "react";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { CanvasDocument } from "@/lib/client/canvas";
import { clockTime } from "./util";

/**
 * 保存 409 的冲突弹层（R5.3 自 CanvasView 拆出）：展示「本地（未保存）/ 服务端」
 * 两份摘要，严格模态——Esc / 点外层不关（父组件不挂 useDismiss），只能显式二选一。
 * 聚焦管理（出现时聚焦「保留本地」、关掉焦点还画布）仍在 CanvasView，因为它要碰 rootRef。
 */
export function ConflictDialog({
  server,
  localNodes,
  localEdges,
  dialogRef,
  onKeepLocal,
  onUseServer,
}: {
  server: CanvasDocument;
  localNodes: number;
  localEdges: number;
  dialogRef: RefObject<HTMLDivElement | null>;
  onKeepLocal: () => void;
  onUseServer: () => void;
}) {
  const t = useT();
  return (
    <div
      className="canvas-conflict"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("canvas.conflict.title")}
    >
      <div className="canvas-conflict__head">
        <span className="canvas-conflict__title">{t("canvas.conflict.title")}</span>
      </div>
      <p className="canvas-conflict__desc">{t("canvas.conflict.desc")}</p>
      <div className="canvas-conflict__cols">
        <div className="canvas-conflict__col">
          <span className="canvas-conflict__colname">{t("canvas.conflict.local")}</span>
          <span className="canvas-conflict__summary">
            {t("canvas.conflict.summary", {
              nodes: localNodes,
              edges: localEdges,
            })}
          </span>
        </div>
        <div className="canvas-conflict__col">
          <span className="canvas-conflict__colname">{t("canvas.conflict.server")}</span>
          <span className="canvas-conflict__summary">
            {t("canvas.conflict.summary", {
              nodes: server.nodes.length,
              edges: server.edges.length,
            })}
          </span>
          <span className="canvas-conflict__saved">
            {t("canvas.conflict.savedAt", { time: clockTime(server.updatedAt) })}
          </span>
        </div>
      </div>
      <div className="canvas-conflict__foot">
        <button
          type="button"
          className="canvas-conflict__keep"
          onClick={onKeepLocal}
        >
          {t("canvas.conflict.keepLocal")}
        </button>
        <button type="button" className="canvas-conflict__server" onClick={onUseServer}>
          {t("canvas.conflict.useServer")}
        </button>
      </div>
    </div>
  );
}
