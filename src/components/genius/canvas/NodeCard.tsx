"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { CANVAS_APPROVAL_TIMEOUT_MS, type CanvasNode, type CanvasNodeExecution } from "@/lib/client/canvas";
import type { JobPublic } from "@/lib/jobs/schema";
import { NODE_W } from "./data";
import { IconClose, IconImage, IconPlus, IconBolt, IconText, IconVideo } from "./icons";
import { clockTime, TERMINAL } from "./util";

/** 执行位 errorCode 里有字典文案的集合；不在里面的直接显示原始码。 */
const EXEC_ERR_KEYS = new Set([
  "price_changed",
  "input_missing",
  "uncertain_submit",
  "upstream_failed",
  "job_missing",
  "output_purged",
  "approval_rejected",
  "approval_timeout",
  "queue_timeout",
  "canceled",
  "expired",
  "failed",
  "insufficient_balance",
  "invalid_argument",
  "internal_error",
]);

/**
 * 单个画布节点卡（R5.3 自 CanvasView 拆出）：标签条 + 三类正文
 * （便签 / 素材 / 生成）。回调全部经 props，不读 ShellContext 以外的状态。
 */
export function NodeCard({
  node,
  missing,
  onDragStart,
  onDelete,
  onTextChange,
  onUploadClick,
  onImageError,
  job,
  exec,
  running,
  inputOf,
  candidates,
  onPrompt,
  onInput,
  onRun,
  onApproval,
}: {
  node: CanvasNode;
  /** 素材缺失/过期（`materialMissing` 的判定结果，含本地 img onError 补记）。 */
  missing: boolean;
  onDragStart: (e: ReactMouseEvent<HTMLElement>) => void;
  onDelete: () => void;
  onTextChange: (v: string) => void;
  onUploadClick: () => void;
  onImageError: () => void;
  job: JobPublic | undefined;
  exec: CanvasNodeExecution | undefined;
  running: boolean;
  inputOf: string;
  candidates: CanvasNode[];
  onPrompt: (v: string) => void;
  onInput: (fromId: string | null) => void;
  onRun: () => void;
  onApproval: (decision: "approve" | "reject") => void;
}) {
  const t = useT();
  return (
    <div
      className="canvas-node"
      data-kind={node.kind}
      style={{ left: node.x, top: node.y, width: NODE_W }}
    >
      <span
        className="canvas-node__label"
        onMouseDown={onDragStart}
        style={{ cursor: "grab" }}
      >
        {node.kind === "text" ? (
          <IconText size={12} />
        ) : node.kind === "material" ? (
          <IconImage size={12} />
        ) : (
          <IconVideo size={12} />
        )}
        {t(`canvas.kind.${node.kind}`)}
        <button
          type="button"
          className="canvas-node__del"
          aria-label={t("canvas.nodeDelete")}
          onClick={onDelete}
        >
          <IconClose size={11} />
        </button>
      </span>

      {node.kind === "text" ? (
        <textarea
          className="canvas-node__body canvas-node__body--text canvas-node__textarea"
          style={{ height: 120 }}
          value={node.text ?? ""}
          placeholder={t("canvas.textPlaceholder")}
          onChange={(e) => onTextChange(e.target.value)}
        />
      ) : null}

      {node.kind === "material" ? (
        <div className="canvas-node__body" style={{ minHeight: 120 }}>
          {(node.assetId || node.uploadId) && !missing ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="canvas-node__img"
              src={`/api/uploads/${node.assetId ?? node.uploadId}`}
              alt={t("canvas.kind.material")}
              onError={onImageError}
            />
          ) : (
            <button
              type="button"
              className="canvas-node__upload"
              onClick={onUploadClick}
            >
              <IconPlus size={14} />
              {t("canvas.upload")}
            </button>
          )}
          <p className="canvas-node__material-note" data-missing={missing}>
            {missing
              ? t("canvas.material.missing")
              : node.assetExpiresAt
                ? t("canvas.material.expires", { time: clockTime(node.assetExpiresAt) })
                : t("canvas.material.retention")}
          </p>
        </div>
      ) : null}

      {node.kind === "gen_image" || node.kind === "gen_video" ? (
        <GenBody
          node={node}
          job={job}
          exec={exec}
          running={running}
          inputOf={inputOf}
          candidates={candidates}
          onPrompt={onPrompt}
          onInput={onInput}
          onRun={onRun}
          onApproval={onApproval}
        />
      ) : null}
    </div>
  );
}

/** 生成节点的正文体：提示词 + 上游选择 + 运行 + 产物预览（D 包：叠加 run 执行态徽标）。 */
function GenBody({
  node,
  job,
  exec,
  running,
  inputOf,
  candidates,
  onPrompt,
  onInput,
  onRun,
  onApproval,
}: {
  node: CanvasNode;
  job: JobPublic | undefined;
  exec: CanvasNodeExecution | undefined;
  running: boolean;
  inputOf: string;
  candidates: CanvasNode[];
  onPrompt: (v: string) => void;
  onInput: (fromId: string | null) => void;
  onRun: () => void;
  onApproval: (decision: "approve" | "reject") => void;
}) {
  const t = useT();
  const status = job?.status;
  return (
    <div className="canvas-node__body" data-state={status ?? "idle"} style={{ minHeight: 120 }}>
      <textarea
        className="canvas-node__textarea"
        style={{ height: 64 }}
        value={node.prompt ?? ""}
        placeholder={t("canvas.prompt.placeholder")}
        onChange={(e) => onPrompt(e.target.value)}
      />
      {candidates.length ? (
        <select
          className="canvas-node__select"
          value={inputOf}
          aria-label={t("canvas.input")}
          onChange={(e) => onInput(e.target.value || null)}
        >
          <option value="">{t("canvas.inputNone")}</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {t(`canvas.kind.${c.kind}`)} {c.id.slice(2, 6)}
            </option>
          ))}
        </select>
      ) : null}
      <div className="canvas-node__runrow">
        <button
          type="button"
          className="canvas-node__run"
          disabled={running || (status !== undefined && !TERMINAL.has(status))}
          onClick={onRun}
        >
          <IconBolt size={12} />
          {running || (status && !TERMINAL.has(status)) ? t("canvas.running") : t("canvas.run")}
        </button>
        {exec ? (
          <span className="canvas-node__exec" data-exec={exec.reused ? "reused" : exec.status}>
            {exec.reused
              ? t("canvas.exec.reused")
              : t(`canvas.exec.${exec.status}` as Parameters<typeof t>[0])}
          </span>
        ) : status ? (
          <span className="canvas-node__state">{t(`canvas.job.${status}` as Parameters<typeof t>[0])}</span>
        ) : null}
      </div>
      {exec?.status === "awaiting_approval" ? (
        <div className="canvas-node__approverow">
          <button
            type="button"
            className="canvas-node__approve"
            onClick={() => onApproval("approve")}
          >
            {t("canvas.run.approve")}
          </button>
          <button
            type="button"
            className="canvas-node__reject"
            onClick={() => onApproval("reject")}
          >
            {t("canvas.run.reject")}
          </button>
        </div>
      ) : null}
      {exec?.status === "awaiting_approval" && exec.awaitingSince ? (
        <span className="canvas-node__deadline">
          {t("canvas.run.approvalDeadline", {
            time: clockTime(
              new Date(Date.parse(exec.awaitingSince) + CANVAS_APPROVAL_TIMEOUT_MS).toISOString(),
            ),
          })}
        </span>
      ) : null}
      {exec?.errorCode ? (
        <span className="canvas-node__err">
          {EXEC_ERR_KEYS.has(exec.errorCode)
            ? t(`canvas.err.${exec.errorCode}` as Parameters<typeof t>[0])
            : exec.errorCode}
        </span>
      ) : null}
      {job?.output?.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="canvas-node__img" src={job.output.imageUrl} alt={job.prompt} />
      ) : null}
      {job?.output?.kind === "video" ? (
        <video className="canvas-node__video" src={job.output.videoUrl} poster={job.output.posterUrl} controls />
      ) : null}
      {job?.error ? <span className="canvas-node__err">{job.error.message}</span> : null}
    </div>
  );
}
