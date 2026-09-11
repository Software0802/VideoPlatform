"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { useShell } from "@/components/genius/ShellContext";
import {
  createCanvasApi,
  fetchCanvas,
  fetchCanvases,
  newCanvasEdgeId,
  newCanvasNodeId,
  patchCanvas,
  RevisionConflictError,
  runCanvasNodeApi,
  type CanvasDocument,
  type CanvasNode,
} from "@/lib/client/canvas";
import { fetchJob, uploadFile } from "@/lib/client/jobs";
import type { JobPublic } from "@/lib/jobs/schema";
import { FIT_PAD_X, FIT_PAD_Y, SCENE_H, SCENE_W } from "./data";
import {
  IconBolt,
  IconCursor,
  IconImage,
  IconPlus,
  IconText,
  IconClose,
  IconVideo,
} from "./icons";

type MenuPos = { x: number; y: number };

const LABEL_H = 22;
const NODE_W = 260;
const MENU_W = 158;
const MENU_H = 202;
const POLL_MS = 3000;
const SAVE_DEBOUNCE_MS = 600;

function clamp(min: number, v: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

const TERMINAL = new Set(["succeeded", "failed", "canceled", "expired"]);

/** 点击浮层之外或按 Esc 时关闭。 */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
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
  }, [open, ref, close]);
}

/**
 * 画布视图（C 包）：持久化到 `data/canvases/<userId>/<id>.json`，乐观并发
 * （PATCH 带 `expectedRevision`，409 即重拉），生成节点「运行」走与服务端
 * `createJob` 同一条准入 / 计价 / 幂等路径——画布上的任务就是普通任务。
 *
 * 四类节点：文本便签（内容并进下游提示词）、素材（上传图，喂给视频节点当首帧）、
 * 文生图、视频（有图片输入 = 图生视频，否则文生视频）。
 */
export default function CanvasView() {
  const t = useT();
  const { showToast } = useShell();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const materialFor = useRef<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const [doc, setDoc] = useState<CanvasDocument | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobPublic>>({});
  const [fit, setFit] = useState(1);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menu !== null, menuRef, closeMenu);

  /* 载入：最新一张画布，没有就建一张。 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchCanvases();
        const next = list[0] ? await fetchCanvas(list[0].id) : await createCanvasApi();
        if (alive) setDoc(next);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /* fit：作者坐标 900×620 缩放进视口。 */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - FIT_PAD_X;
      const h = el.clientHeight - FIT_PAD_Y;
      const next = clamp(0.4, Math.min(w / SCENE_W, h / SCENE_H), 1.4);
      setFit((prev) => (Math.abs(prev - next) > 0.005 ? next : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 写盘：本地先更新（界面不等网络），PATCH 带当前 revision；409 即别处已改——
   * 重拉最新文档交回，绝不静默覆盖（C 包硬要求）。
   */
  const persist = useCallback(
    async (base: CanvasDocument, nodes: CanvasNode[], edges = base.edges) => {
      try {
        const next = await patchCanvas(base.id, { expectedRevision: base.revision, nodes, edges });
        setDoc((cur) => (cur && cur.id === next.id ? next : cur));
      } catch (e) {
        if (e instanceof RevisionConflictError) {
          const fresh = await fetchCanvas(base.id);
          if (fresh) setDoc(fresh);
          showToast(t("canvas.conflict"));
        } else {
          showToast(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [showToast, t],
  );

  /** 本地先改 + 防抖落盘（打字 / 拖拽走这条路）。 */
  const mutate = useCallback(
    (fn: (d: CanvasDocument) => { nodes: CanvasNode[]; edges?: CanvasDocument["edges"] }) => {
      setDoc((cur) => {
        if (!cur) return cur;
        const { nodes, edges } = fn(cur);
        const next = { ...cur, nodes, edges: edges ?? cur.edges };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void persist(next, nodes, next.edges), SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [persist],
  );

  /* 生成节点轮询：有 jobId 未终态的节点每 3s 问一次。 */
  const pendingJobIds = (doc?.nodes ?? [])
    .map((n) => n.jobId)
    .filter((id): id is string => Boolean(id) && !TERMINAL.has(jobs[id!]?.status ?? ""));
  useEffect(() => {
    if (!pendingJobIds.length) return;
    const timer = setInterval(() => {
      for (const id of pendingJobIds) {
        void fetchJob(id).then((job) => {
          if (job) setJobs((map) => ({ ...map, [id]: job }));
        });
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJobIds.join(",")]);

  /* 首次见到 jobId 就立即拉一次（刷新恢复时不必等一个轮询周期）。 */
  useEffect(() => {
    for (const n of doc?.nodes ?? []) {
      if (n.jobId && !jobs[n.jobId]) {
        void fetchJob(n.jobId).then((job) => {
          if (job) setJobs((map) => ({ ...map, [n.jobId!]: job }));
        });
      }
    }
  }, [doc, jobs]);

  const scale = fit;

  const openMenuAt = (pos: MenuPos) => setMenu(pos);

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = sceneRef.current;
    if (!el) {
      openMenuAt({ x: 300, y: 224 });
      return;
    }
    const r = el.getBoundingClientRect();
    openMenuAt({
      x: clamp(0, (e.clientX - r.left) / scale, SCENE_W - MENU_W),
      y: clamp(0, (e.clientY - r.top) / scale, SCENE_H - MENU_H),
    });
  };

  const addNode = (kind: CanvasNode["kind"], pos: MenuPos) => {
    setMenu(null);
    const node: CanvasNode = { id: newCanvasNodeId(), kind, x: pos.x, y: pos.y };
    mutate((d) => ({ nodes: [...d.nodes, node] }));
    if (kind === "material") {
      materialFor.current = node.id;
      fileRef.current?.click();
    }
  };

  const removeNode = (id: string) => {
    mutate((d) => ({
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.from !== id && e.to !== id),
    }));
  };

  const onUpload = async (file: File | undefined) => {
    const nodeId = materialFor.current;
    materialFor.current = null;
    if (!file || !nodeId) return;
    try {
      const { uploadId } = await uploadFile(file, "start");
      mutate((d) => ({
        nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, uploadId } : n)),
      }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  /** 上游选择：一条 gen 节点最多一条入边；换选即换边，「无」即删掉入边。 */
  const setInput = (nodeId: string, fromId: string | null) => {
    mutate((d) => {
      const edges = d.edges.filter((e) => e.to !== nodeId);
      if (fromId) edges.push({ id: newCanvasEdgeId(), from: fromId, to: nodeId });
      return { nodes: d.nodes, edges };
    });
  };

  const runNode = async (nodeId: string) => {
    if (!doc || running.has(nodeId)) return;
    setError(null);
    setRunning((s) => new Set(s).add(nodeId));
    try {
      // 先把本地未落盘的改动推上去，让 run 读到的是最新提示词与连线。
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        await persist(doc, doc.nodes, doc.edges);
      }
      const fresh = (await fetchCanvas(doc.id)) ?? doc;
      const { canvas, job } = await runCanvasNodeApi(fresh.id, nodeId);
      setDoc(canvas);
      setJobs((map) => ({ ...map, [job.id]: job }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(message);
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(nodeId);
        return next;
      });
    }
  };

  const onNodePointerDown = (e: ReactMouseEvent<HTMLElement>, node: CanvasNode) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("textarea,input,select,button")) return;
    drag.current = { id: node.id, dx: (e.clientX - 0) / scale - node.x, dy: (e.clientY - 0) / scale - node.y };
    const rect = sceneRef.current?.getBoundingClientRect();
    if (rect) {
      drag.current.dx = (e.clientX - rect.left) / scale - node.x;
      drag.current.dy = (e.clientY - rect.top) / scale - node.y;
    }
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const el = sceneRef.current;
      if (!d || !el) return;
      const r = el.getBoundingClientRect();
      const x = clamp(0, (e.clientX - r.left) / scale - d.dx, SCENE_W - NODE_W);
      const y = clamp(0, (e.clientY - r.top) / scale - d.dy, SCENE_H - 60);
      setDoc((cur) =>
        cur ? { ...cur, nodes: cur.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)) } : cur,
      );
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      setDoc((cur) => {
        if (cur) void persist(cur, cur.nodes, cur.edges);
        return cur;
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [scale, persist]);

  const nodeById = (id: string) => doc?.nodes.find((n) => n.id === id);
  const inputOf = (nodeId: string) => doc?.edges.find((e) => e.to === nodeId)?.from ?? "";
  const candidatesFor = (node: CanvasNode) =>
    (doc?.nodes ?? []).filter(
      (n) => n.id !== node.id && (n.kind === "text" || n.kind === "material" || n.kind === "gen_image"),
    );

  return (
    <div
      className="canvas-view"
      ref={rootRef}
      onContextMenu={onContextMenu}
      style={{ backgroundSize: `${Math.round(22 * scale)}px ${Math.round(22 * scale)}px` }}
    >
      {!doc ? (
        <div className="canvas-empty">
          <div className="canvas-empty__copy">
            <span className="canvas-empty__title">{error ?? t("canvas.loading")}</span>
          </div>
        </div>
      ) : (
        <div className="canvas-scroll">
          <div
            className="canvas-scene"
            ref={sceneRef}
            style={{ width: SCENE_W, height: SCENE_H, transform: `scale(${scale.toFixed(3)})` }}
          >
            <svg
              className="canvas-wires"
              viewBox={`0 0 ${SCENE_W} ${SCENE_H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <g fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="1.2">
                {doc.edges.map((e) => {
                  const from = nodeById(e.from);
                  const to = nodeById(e.to);
                  if (!from || !to) return null;
                  const x1 = from.x + NODE_W;
                  const y1 = from.y + LABEL_H + 40;
                  const x2 = to.x;
                  const y2 = to.y + LABEL_H + 40;
                  return (
                    <path key={e.id} d={`M${x1} ${y1} C ${x1 + 50} ${y1} ${x2 - 50} ${y2} ${x2} ${y2}`} />
                  );
                })}
              </g>
            </svg>

            {doc.nodes.map((node) => (
              <div
                key={node.id}
                className="canvas-node"
                data-kind={node.kind}
                style={{ left: node.x, top: node.y, width: NODE_W }}
              >
                <span
                  className="canvas-node__label"
                  onMouseDown={(e) => onNodePointerDown(e, node)}
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
                    onClick={() => removeNode(node.id)}
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
                    onChange={(e) =>
                      mutate((d) => ({
                        nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, text: e.target.value } : n)),
                      }))
                    }
                  />
                ) : null}

                {node.kind === "material" ? (
                  <div className="canvas-node__body" style={{ minHeight: 120 }}>
                    {node.uploadId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className="canvas-node__img"
                        src={`/api/uploads/${node.uploadId}`}
                        alt={t("canvas.kind.material")}
                      />
                    ) : (
                      <button
                        type="button"
                        className="canvas-node__upload"
                        onClick={() => {
                          materialFor.current = node.id;
                          fileRef.current?.click();
                        }}
                      >
                        <IconPlus size={14} />
                        {t("canvas.upload")}
                      </button>
                    )}
                  </div>
                ) : null}

                {node.kind === "gen_image" || node.kind === "gen_video" ? (
                  <GenBody
                    node={node}
                    job={node.jobId ? jobs[node.jobId] : undefined}
                    running={running.has(node.id)}
                    inputOf={inputOf(node.id)}
                    candidates={candidatesFor(node)}
                    onPrompt={(prompt) =>
                      mutate((d) => ({
                        nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, prompt } : n)),
                      }))
                    }
                    onInput={(fromId) => setInput(node.id, fromId)}
                    onRun={() => void runNode(node.id)}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {menu ? (
        <div className="canvas-menu" ref={menuRef} style={{ left: menu.x * scale, top: menu.y * scale }}>
          {(["text", "material", "gen_image", "gen_video"] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              className="canvas-menu__item"
              onClick={() => addNode(kind, menu)}
            >
              {kind === "text" ? (
                <IconText size={12} />
              ) : kind === "material" ? (
                <IconImage size={12} />
              ) : (
                <IconVideo size={12} />
              )}
              {t(`canvas.kind.${kind}`)}
            </button>
          ))}
        </div>
      ) : null}

      {doc && doc.nodes.length === 0 && !menu ? (
        <div className="canvas-empty__hint" style={{ position: "absolute", left: 24, top: 24 }}>
          <IconCursor />
          {t("canvas.empty.rightClick")}
        </div>
      ) : null}

      {error ? <p className="agent-view__error" style={{ position: "absolute", left: 24, bottom: 16 }}>{error}</p> : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void onUpload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** 生成节点的正文体：提示词 + 上游选择 + 运行 + 产物预览。 */
function GenBody({
  node,
  job,
  running,
  inputOf,
  candidates,
  onPrompt,
  onInput,
  onRun,
}: {
  node: CanvasNode;
  job: JobPublic | undefined;
  running: boolean;
  inputOf: string;
  candidates: CanvasNode[];
  onPrompt: (v: string) => void;
  onInput: (fromId: string | null) => void;
  onRun: () => void;
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
        {status ? (
          <span className="canvas-node__state">{t(`canvas.job.${status}` as Parameters<typeof t>[0])}</span>
        ) : null}
      </div>
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
