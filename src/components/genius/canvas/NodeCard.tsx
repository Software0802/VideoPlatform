"use client";

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { CANVAS_APPROVAL_TIMEOUT_MS, type CanvasNode, type CanvasNodeExecution } from "@/lib/client/canvas";
import type { Product } from "@/lib/client/models";
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
 * 这个节点此刻在等谁：`model` 等上游出片（冷光波纹），`approval` 等人批准（琥珀慢呼吸）。
 *
 * 判据分三处取，因为每处各只看得见一段：
 * - `exec`：整图 run 的执行位。`ready` 是「已排进这次 run、等着提交」，`running` 是
 *   「已提交、上游在跑」——两者都算在等模型。run 轮询 3 秒一次而 mock 3.5 秒出片，
 *   实测客户端多数时候看到的就是 `ready`，只认 `running` 等于绝大部分时间什么都不显示。
 *   `waiting_dependencies` 不算：它等的是上游那个节点，而上游自己会亮，连线也会指过来。
 * - `job`：真正的任务记录，非终态即在跑。手动单跑的节点只有它。
 * - `running`：本地刚点下「运行」、任务号还没回来的那一小段。
 *
 * 连线（`CanvasView` 里的 `.canvas-wires path`）要和节点用同一份判据，所以导出。
 */
export function waitStateOf(
  exec: CanvasNodeExecution | undefined,
  job: JobPublic | undefined,
  running: boolean,
): "model" | "approval" | undefined {
  if (exec?.status === "awaiting_approval") return "approval";
  if (exec?.status === "ready" || exec?.status === "running" || running) return "model";
  if (job && !TERMINAL.has(job.status)) return "model";
  return undefined;
}

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
  products,
  onProduct,
  modelOpen,
  modelRef,
  onModelOpen,
  onRun,
  onApproval,
}: {
  node: CanvasNode;
  /** 素材缺失/过期（`materialMissing` 的判定结果，含本地 img onError 补记）。 */
  missing: boolean;
  onDragStart: (e: ReactPointerEvent<HTMLElement>) => void;
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
  /** `GET /api/models` 的产品表；空表示拉不到，节点上就不显示模型芯片。 */
  products: Product[];
  /** 点名产品（写 `node.product`）；`null` = 交回服务端按能力路由。 */
  onProduct: (productId: string | null) => void;
  /** 这枚芯片的弹层开着没有。开合状态在 `CanvasView`：全画布同时只开一个。 */
  modelOpen: boolean;
  /** 开着的那一个把浮层挂给 `CanvasView` 的 `useDismiss`（点外层 / Esc 收层）。 */
  modelRef?: React.RefObject<HTMLDivElement | null>;
  onModelOpen: (open: boolean) => void;
  onRun: () => void;
  onApproval: (decision: "approve" | "reject") => void;
}) {
  const t = useT();
  /*
    删除二次确认（review 2026-09-15 U-18）：✕ 原来是即删，写了半天的提示词、传上去的
    素材一点就没，没有撤销也没有确认。空节点仍然直接删——给一个什么都没有的卡片加一步
    确认只是添堵。
  */
  const [confirming, setConfirming] = useState(false);
  const hasContent = Boolean(
    node.text?.trim() || node.prompt?.trim() || node.uploadId || node.assetId || job,
  );
  /*
    节点上的模型选择（`node.product`）。这个字段一直在 schema 里、报价与运行也一直认它
    （`canvas/graph.ts` 的 `requestedId` / `run.ts` 的 `model`），只是从来没有界面能写它——
    整张画布只能吃默认路由。`products` 由 `CanvasView` 按这个节点这次会跑的 mode 筛过，
    这里直接列，「自动」= 不点名，交回服务端按能力选。钉着的产品不在这张表里（产品下线、
    或这条路径它接不下）就照实说，不能借「自动」把一个必然 400 的钉子盖过去。

    这一行放在正文**外面**：`.canvas-node__body` 是 `overflow:hidden`，浮层开在里面会被裁掉。
  */
  const isGen = node.kind === "gen_image" || node.kind === "gen_video";
  const current = products.find((p) => p.id === node.product);
  const pickProduct = (productId: string | null) => {
    onModelOpen(false);
    onProduct(productId);
  };
  return (
    <div
      className="canvas-node"
      data-kind={node.kind}
      data-wait={waitStateOf(exec, job, running)}
      style={{ left: node.x, top: node.y, width: NODE_W }}
    >
      <span
        className="canvas-node__label"
        onPointerDown={onDragStart}
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
          onClick={() => (hasContent ? setConfirming(true) : onDelete())}
        >
          <IconClose size={11} />
        </button>
      </span>

      {confirming ? (
        <div className="canvas-node__confirm" role="alertdialog" aria-label={t("canvas.nodeDelete")}>
          <span className="canvas-node__confirm-text">{t("canvas.nodeDelete.confirmText")}</span>
          <button
            type="button"
            className="canvas-node__confirm-btn"
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="canvas-node__confirm-btn canvas-node__confirm-btn--danger"
            onClick={onDelete}
          >
            {t("canvas.nodeDelete.confirm")}
          </button>
        </div>
      ) : null}

      {isGen && products.length ? (
        <div className="canvas-node__modelrow" ref={modelRef}>
          <button
            type="button"
            className="canvas-model"
            data-open={modelOpen ? "true" : undefined}
            data-product-id={node.product ?? ""}
            aria-expanded={modelOpen}
            aria-label={t("canvas.model.pick")}
            onClick={() => onModelOpen(!modelOpen)}
          >
            <span className="canvas-model__dot" aria-hidden="true" />
            {current?.name ?? t(node.product ? "canvas.model.gone" : "canvas.model.auto")}
          </button>
          {modelOpen ? (
            <div className="canvas-modelpop">
              <span className="canvas-modelpop__title">{t("canvas.model.pick")}</span>
              <button
                type="button"
                className="canvas-modelpop__item"
                data-current={!node.product}
                onClick={() => pickProduct(null)}
              >
                <span className="canvas-modelpop__body">
                  <span className="canvas-modelpop__name">{t("canvas.model.auto")}</span>
                  <span className="canvas-modelpop__desc">{t("canvas.model.autoDesc")}</span>
                </span>
              </button>
              {products.map((product) => (
                <button
                  type="button"
                  key={product.id}
                  className="canvas-modelpop__item"
                  data-product-id={product.id}
                  data-current={product.id === node.product}
                  onClick={() => pickProduct(product.id)}
                >
                  <span className="canvas-modelpop__body">
                    <span className="canvas-modelpop__name">{product.name}</span>
                    <span className="canvas-modelpop__desc">{product.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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
