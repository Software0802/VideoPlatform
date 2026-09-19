"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { useNotices, useSession } from "@/components/genius/ShellContext";
import {
  cancelCanvasRunApi,
  createCanvasApi,
  createCanvasRunApi,
  decideCanvasRunApprovalApi,
  fetchCanvas,
  fetchCanvasRuns,
  fetchCanvasWorkflow,
  fetchCanvases,
  newCanvasEdgeId,
  newCanvasNodeId,
  patchCanvas,
  quoteCanvas,
  RevisionConflictError,
  runCanvasNodeApi,
  type CanvasDocument,
  type CanvasNode,
  type CanvasNodeExecution,
  type CanvasQuote,
  type CanvasRun,
} from "@/lib/client/canvas";
import { ApiError } from "@/lib/client/http";
import { newIdempotencyKey, uploadFile } from "@/lib/client/jobs";
import { fetchProducts, type Product } from "@/lib/client/models";
import { errorText } from "@/lib/i18n/errorText";
import { useDialogFocus } from "@/components/genius/useDialogFocus";
import type { JobPublic } from "@/lib/jobs/schema";
import CanvasToolbox, { type ToolboxPick } from "./CanvasToolbox";
import { ConflictDialog } from "./ConflictDialog";
import {
  FIT_PAD_X,
  FIT_PAD_X_NARROW,
  FIT_PAD_Y,
  LABEL_H,
  MAX_ZOOM,
  MIN_SCALE_NARROW,
  MIN_ZOOM,
  NARROW_W,
  NODE_W,
  SCENE_H,
  SCENE_W,
  ZOOM_STEP,
} from "./data";
import { NodeCard, waitStateOf } from "./NodeCard";
import { QuoteDialog, RunBar } from "./QuoteDialog";
import { useCanvasPolling } from "./useCanvasPolling";
import {
  IconCursor,
  IconFit,
  IconImage,
  IconPlus,
  IconText,
  IconToolbox,
  IconVideo,
} from "./icons";
import { clamp } from "./util";

/**
 * 右键 / 长按菜单的位置。作者坐标（`x`/`y`）给「在这里建节点」用，视图像素坐标
 * （`left`/`top`）给浮层自己定位用——菜单是 `.canvas-view` 的绝对定位子节点，不随
 * `.canvas-scroll` 一起滚，所以不能用「作者坐标 × scale」摆它（滚动后会偏掉一整屏，
 * 而窄屏现在是会滚的，见 review 2026-09-15 U-02）。
 */
type MenuPos = { x: number; y: number; left: number; top: number };

const MENU_W = 158;
const MENU_H = 202;
const SAVE_DEBOUNCE_MS = 600;
/** 长按建节点：按住多久算长按、手指抖动多少像素以内还算按住、开菜单后多久不接受点击。 */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
const LONG_PRESS_GUARD_MS = 400;

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
 *
 * R5.3 结构：节点卡在 `NodeCard.tsx`（含生成节点正文 `GenBody`）、报价弹层与
 * 运行钮在 `QuoteDialog.tsx`、409 冲突弹层在 `ConflictDialog.tsx`、轮询/补拉簇在
 * `useCanvasPolling.ts`；共享几何常量在 `data.ts`，`clamp`/`clockTime`/`TERMINAL`
 * 在 `util.ts`。
 */
export default function CanvasView() {
  const t = useT();
  const { showToast } = useNotices();
  const { refreshMe } = useSession();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const quoteRef = useRef<HTMLDivElement | null>(null);
  const conflictRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 保存链（2026-09-13）：后一次 PATCH 必须排在在途 PATCH 之后、用它返回的
  // revision 作 expectedRevision。doc.revision 要等响应回来才经 setDoc 更新，
  // 不串行的话，在途期间的第二次保存会带着旧 revision 撞 409。
  const saveTail = useRef<Promise<CanvasDocument | null>>(Promise.resolve(null));
  /*
    防抖窗口里那一笔还没发出去的改动（review 2026-09-15 C-09）。原来卸载 / 刷新只
    `clearTimeout`，于是「在节点里打完最后一句就切走」这句话直接没了，回来看到的是
    600ms 之前的版本，而且没有任何提示。记在这里，离开时补发。
  */
  const pendingSave = useRef<{ base: CanvasDocument; nodes: CanvasNode[]; edges: CanvasDocument["edges"] } | null>(null);
  const materialFor = useRef<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const [doc, setDoc] = useState<CanvasDocument | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobPublic>>({});
  const [missingMaterials, setMissingMaterials] = useState<Set<string>>(new Set());
  const [fit, setFit] = useState(1);
  /** 手动缩放：叠在 fit 之上，底部工具条写它（`适应画布` 把它拨回 1）。 */
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [toolbox, setToolbox] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** `GET /api/models` 的产品表：节点上的模型芯片按它列，拉不到就不显示芯片。 */
  const [products, setProducts] = useState<Product[]>([]);
  // D 包：最新一次整图运行（展示 overlay）+ 报价弹层 + 提交中状态。
  const [latestRun, setLatestRun] = useState<CanvasRun | null>(null);
  const [quote, setQuote] = useState<CanvasQuote | null>(null);
  // D 切片二：报价弹层里的两份勾选——执行前需批准的节点（默认勾视频）与
  // 强制重跑的复用/已清节点（默认不勾）。
  const [gates, setGates] = useState<Set<string>>(new Set());
  const [regen, setRegen] = useState<Set<string>>(new Set());
  const [runBusy, setRunBusy] = useState(false);
  const runKeyRef = useRef<string | null>(null);
  const lastRunStatus = useRef<CanvasRun["status"] | null>(null);
  // 保存 409（2026-09-13）：不静默覆盖任何一方——本地 doc 保持不动，弹层让用户
  // 在「本地（未保存）」与「服务端」之间二选一。
  const [conflict, setConflict] = useState<{ server: CanvasDocument } | null>(null);
  // persist 是防抖定时器触发的 callback，读不到最新 state——用 ref 镜像 conflict。
  const conflictState = useRef<{ server: CanvasDocument } | null>(null);
  useEffect(() => {
    conflictState.current = conflict;
  }, [conflict]);

  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menu !== null, menuRef, closeMenu);
  /* 报价弹层同样吃「点外层 / Esc」收层（H4），头部 ✕ 是可见关闭控件。 */
  useDismiss(quote !== null, quoteRef, () => setQuote(null));

  /** 冲突二选一：用当前本地 doc（冲突期间仍在编辑）按服务端 revision 覆盖写。 */
  const resolveKeepLocal = async () => {
    const cur = conflictState.current;
    if (!doc || !cur) return;
    try {
      const next = await patchCanvas(doc.id, {
        expectedRevision: cur.server.revision,
        nodes: doc.nodes,
        edges: doc.edges,
      });
      setDoc(next);
      setConflict(null);
      // 冲突解决后链尾还是冲突前的旧 revision，重置让下一次保存回到 doc 的 revision。
      saveTail.current = Promise.resolve(null);
      showToast(t("canvas.conflict.keptLocal"));
    } catch (e) {
      if (e instanceof RevisionConflictError) {
        // 又被人改了：弹层留着，服务端栏换成最新版，直到成功或用户选服务端。
        const fresh = await fetchCanvas(doc.id);
        if (fresh) setConflict({ server: fresh });
      } else {
        showToast(errorText(t, e));
      }
    }
  };
  const resolveUseServer = () => {
    const cur = conflictState.current;
    if (!cur) return;
    setDoc(cur.server);
    setConflict(null);
    saveTail.current = Promise.resolve(null);
    showToast(t("canvas.conflict.usedServer"));
  };
  /*
    严格模态：只能显式选一份，Esc / 点外层不关——误触不得替用户覆盖任何一方。
    焦点管理换成共用的 `useDialogFocus`（review 2026-09-15 U-07）：默认落在「保留本地」，
    Tab 在两个按钮之间循环（原来手写的那版不困焦，Tab 会走到背后的画布上去）。
  */
  useDialogFocus(conflictRef, conflict !== null, ".canvas-conflict__keep");
  /* 报价弹层同样把焦点收进来：它是一次要花钱的确认。 */
  useDialogFocus(quoteRef, quote !== null);

  /* 载入：最新一张画布，没有就建一张；再拉它的最新一次 run 做产物 overlay。 */
  // `t` 随语言切换换引用；载入 effect 若依赖它，切语言会整份重拉画布并清掉防抖中的
  // 未落盘编辑。错误文案只在失败那一刻取当前 `t`，走 ref，effect 只跑一次。
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchCanvases();
        // 列表与详情之间可能被删掉：落空就当没有画布，重建一张。
        const next = list[0] ? ((await fetchCanvas(list[0].id)) ?? (await createCanvasApi())) : await createCanvasApi();
        if (!alive) return;
        setDoc(next);
        const runs = await fetchCanvasRuns(next.id).catch(() => []);
        if (alive && runs[0]) setLatestRun(runs[0]);
      } catch (e) {
        if (alive) setError(errorText(tRef.current, e));
      }
    })();
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /*
    产品表（`GET /api/models`）：生成节点上的模型芯片按它列，选中的写进 `node.product`
    ——报价与运行都已经认这个字段（`canvas/graph.ts` 的 `requestedId`）。拉不到就退回
    「自动」：不点名产品时服务端按能力路由，与这条芯片出现之前的行为一致。
  */
  useEffect(() => {
    let alive = true;
    void fetchProducts().then(
      (list) => {
        if (alive) setProducts(list);
      },
      () => {
        if (alive) setProducts([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  /* fit：作者坐标 900×620 缩放进视口；窄屏不缩小，改成可平移（见 data.ts 的窄屏档）。 */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const narrow = el.clientWidth <= NARROW_W;
      const w = el.clientWidth - (narrow ? FIT_PAD_X_NARROW : FIT_PAD_X);
      const h = el.clientHeight - FIT_PAD_Y;
      const raw = Math.min(w / SCENE_W, h / SCENE_H);
      const next = clamp(narrow ? MIN_SCALE_NARROW : 0.4, raw, 1.4);
      setFit((prev) => (Math.abs(prev - next) > 0.005 ? next : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * 写盘：本地先更新（界面不等网络），PATCH 带当前 revision；409 即别处已改——
   * 保留本地副本，弹层让用户在本地 / 服务端之间二选一，绝不静默覆盖任何一方。
   * 冲突未决期间不再发 PATCH（反复 409 没有意义），本地 mutate 照常进行。
   */
  const persist = useCallback(
    (
      base: CanvasDocument,
      nodes: CanvasNode[],
      edges = base.edges,
      opts?: { keepalive?: boolean },
    ): Promise<void> => {
      if (conflictState.current) return Promise.resolve();
      const task = saveTail.current.then(async (prev) => {
        if (conflictState.current) return prev;
        // 链上上一个 PATCH 的返回才是服务端当前 revision；拿不到（链空、换了
        // 画布、上一次失败）才退回 schedule 时捕获的 base.revision。
        const expectedRevision = prev && prev.id === base.id ? prev.revision : base.revision;
        try {
          const next = await patchCanvas(base.id, { expectedRevision, nodes, edges }, opts);
          setDoc((cur) => (cur && cur.id === next.id ? next : cur));
          return next;
        } catch (e) {
          if (e instanceof RevisionConflictError) {
            const fresh = await fetchCanvas(base.id);
            if (fresh) setConflict({ server: fresh });
          } else {
            showToast(errorText(t, e));
          }
          return prev;
        }
      });
      saveTail.current = task;
      return task.then(() => undefined);
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
        pendingSave.current = { base: next, nodes, edges: next.edges };
        saveTimer.current = setTimeout(() => {
          pendingSave.current = null;
          void persist(next, nodes, next.edges);
        }, SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [persist],
  );

  /**
   * 把防抖窗口里那一笔立刻发出去（离开页面 / 卸载时用）。
   *
   * `runNode` / `runAll` 早就有同样的「先落盘再运行」写法，缺的只是「用户直接走了」
   * 这条路径。`keepalive` 让请求在文档卸载后仍能送达（review 2026-09-15 C-09）。
   */
  const flushSave = useCallback(
    (keepalive = false) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const held = pendingSave.current;
      pendingSave.current = null;
      if (held) void persist(held.base, held.nodes, held.edges, { keepalive });
    },
    [persist],
  );
  const flushRef = useRef(flushSave);
  useEffect(() => {
    flushRef.current = flushSave;
  }, [flushSave]);
  useEffect(() => {
    // pagehide 覆盖刷新、关标签与移动端切走；卸载（切视图）走 cleanup。
    const onHide = () => flushRef.current(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flushRef.current(false);
    };
  }, []);

  /* 轮询/补拉簇（R5.3）：run 状态、执行位签名触发的余额刷新、jobId 轮询与首次补拉。 */
  useCanvasPolling({ doc, latestRun, setLatestRun, jobs, setJobs, refreshMe });

  useEffect(() => {
    if (!latestRun) return;
    const prev = lastRunStatus.current;
    lastRunStatus.current = latestRun.status;
    if (prev === "running" && latestRun.status !== "running") {
      const unfinished = latestRun.nodeExecutions.filter(
        (e) => e.status === "failed" || e.status === "blocked",
      ).length;
      const key =
        latestRun.status === "partially_failed" ? "canvas.run.toast.partially_failed" : `canvas.run.toast.${latestRun.status}`;
      showToast(
        latestRun.status === "partially_failed"
          ? t(key as Parameters<typeof t>[0], { n: unfinished })
          : t(key as Parameters<typeof t>[0]),
      );
    }
  }, [latestRun, showToast, t]);

  const execOf = useCallback(
    (nodeId: string): CanvasNodeExecution | undefined =>
      latestRun?.nodeExecutions.find((e) => e.nodeId === nodeId),
    [latestRun],
  );

  const scale = fit * zoom;

  /** 由一次右键 / 长按的视口坐标开菜单：作者坐标给建节点，视图像素坐标给浮层定位。 */
  const openMenuAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const scene = sceneRef.current;
      const root = rootRef.current;
      if (!scene || !root) {
        setMenu({ x: 300, y: 224, left: 24, top: 24 });
        return;
      }
      const s = scene.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      setMenu({
        x: clamp(0, (clientX - s.left) / scale, SCENE_W - MENU_W),
        y: clamp(0, (clientY - s.top) / scale, SCENE_H - MENU_H),
        left: clamp(0, clientX - r.left, Math.max(0, r.width - MENU_W)),
        top: clamp(0, clientY - r.top, Math.max(0, r.height - MENU_H)),
      });
    },
    [scale],
  );

  /*
    触屏建节点（review 2026-09-15 U-02）：原来唯一的入口是右键，手机上等于没有入口，
    空态还写着「右键新建」。长按 500ms 开同一个菜单；手指移出 8px 或抬起即作废。
    Android 浏览器长按时自己也会发 contextmenu——那条路径先到就取消这里的计时器，
    两边不会开两次。
  */
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  /*
    长按开出菜单后的一小段静默期。手指抬起时浏览器会在「手指下方」补一次 click，而那时
    菜单刚好就在手指下方——不挡的话「长按」等于「长按并立刻建了一个节点」。挡板由定时器
    自己撤掉（而不是等某次事件），所以没有「补发的 click 没来 → 用户第一次点被吞掉」。
  */
  const menuGuard = useRef<{ on: boolean; timer: number | null }>({ on: false, timer: null });
  const armMenuGuard = useCallback(() => {
    if (menuGuard.current.timer !== null) window.clearTimeout(menuGuard.current.timer);
    menuGuard.current.on = true;
    menuGuard.current.timer = window.setTimeout(() => {
      menuGuard.current = { on: false, timer: null };
    }, LONG_PRESS_GUARD_MS);
  }, []);
  const cancelLongPress = useCallback(() => {
    if (!longPress.current) return;
    window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  }, []);
  useEffect(
    () => () => {
      cancelLongPress();
      if (menuGuard.current.timer !== null) window.clearTimeout(menuGuard.current.timer);
    },
    [cancelLongPress],
  );

  const onViewPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    const target = e.target as HTMLElement;
    // 节点与各浮层上的长按归它们自己（拖拽、选字、点按钮），只有空白处才建节点。
    if (target.closest(".canvas-node,.canvas-menu,.canvas-quote,.canvas-conflict,.canvas-topright")) {
      return;
    }
    cancelLongPress();
    const { clientX, clientY } = e;
    longPress.current = {
      x: clientX,
      y: clientY,
      timer: window.setTimeout(() => {
        longPress.current = null;
        armMenuGuard();
        openMenuAtClient(clientX, clientY);
      }, LONG_PRESS_MS),
    };
  };

  const onViewPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const held = longPress.current;
    if (!held) return;
    if (
      Math.abs(e.clientX - held.x) > LONG_PRESS_SLOP ||
      Math.abs(e.clientY - held.y) > LONG_PRESS_SLOP
    ) {
      cancelLongPress();
    }
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    cancelLongPress();
    openMenuAtClient(e.clientX, e.clientY);
  };

  const addNode = (kind: CanvasNode["kind"], pos: MenuPos) => {
    // 长按刚开出菜单的那一下补发 click 不算选择（见 menuGuard）。
    if (menuGuard.current.on) return;
    setMenu(null);
    const node: CanvasNode = { id: newCanvasNodeId(), kind, x: pos.x, y: pos.y };
    mutate((d) => ({ nodes: [...d.nodes, node] }));
    if (kind === "material") {
      materialFor.current = node.id;
      fileRef.current?.click();
    }
  };

  /**
   * 左侧工具栏的「添加节点」：开的是右键那一份菜单，位置贴着按钮。
   * 触屏与键盘都能到（右键 / 长按之外的第三条入口）。
   */
  const openMenuFromRail = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenuAtClient(r.right + 8, r.top);
  };

  /**
   * 新节点摆哪儿：按已有节点数走一个四列的格子往下排，`clamp` 保证不出场景。
   * 不做碰撞检测——节点可以被拖到任何地方，摆重了用户自己拖开就是。
   * 工具箱与空态入口共用。
   */
  const freeSpot = (count: number): { x: number; y: number } => ({
    x: clamp(0, 120 + (count % 4) * 180, SCENE_W - NODE_W),
    y: clamp(0, 60 + Math.floor(count / 4) * 150, SCENE_H - 160),
  });

  /** 工具箱「应用到画布」：新建一个对应类型的生成节点并填好提示词。 */
  const applyTool = (pick: ToolboxPick) => {
    const kind: CanvasNode["kind"] = pick.kind === "image" ? "gen_image" : "gen_video";
    mutate((d) => {
      const pos = freeSpot(d.nodes.length);
      return { nodes: [...d.nodes, { id: newCanvasNodeId(), kind, ...pos, prompt: pick.prompt }] };
    });
    showToast(t("canvas.toolbox.applied", { name: pick.name }));
  };

  /** 空态两个入口：直接建一个便签 / 视频节点，不必先知道「这里要右键」。 */
  const addFirstNode = (kind: CanvasNode["kind"]) => {
    mutate((d) => {
      const pos = freeSpot(d.nodes.length);
      return { nodes: [...d.nodes, { id: newCanvasNodeId(), kind, ...pos }] };
    });
  };

  /**
   * 导出这次要跑的步骤与人审门（`GET /api/canvases/:id/workflow`）。只读，不建 run、
   * 不报价；带上报价弹层里当下勾的那几道门，导出的就是「确认运行会执行的那张图」。
   */
  const exportWorkflow = async () => {
    if (!doc) return;
    try {
      const graph = await fetchCanvasWorkflow(doc.id, [...gates]);
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(graph, null, 2)}\n`], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${doc.id}.workflow.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      showToast(errorText(t, e));
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
        nodes: d.nodes.map((n) => (n.id === nodeId
          ? { ...n, uploadId, assetId: undefined, assetExpiresAt: undefined, assetState: undefined }
          : n)),
      }));
    } catch (e) {
      showToast(errorText(t, e));
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
      refreshMe();
    } catch (e) {
      const message = errorText(t, e);
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

  /** 整图运行（D 包）：先落盘 → 报价弹层 → 确认后建 run；幂等键随一次点击固定。 */
  const runAll = async () => {
    if (!doc || runBusy) return;
    setError(null);
    setRunBusy(true);
    try {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        await persist(doc, doc.nodes, doc.edges);
      }
      const fresh = (await fetchCanvas(doc.id)) ?? doc;
      setDoc(fresh);
      const q = await quoteCanvas(fresh.id);
      runKeyRef.current = newIdempotencyKey();
      // 默认给视频节点上审批门：图便宜、视频返工贵；复用/已清位不可设门。
      setGates(
        new Set(
          q.items
            .filter((i) => i.kind === "gen_video" && !i.reused && !i.purged)
            .map((i) => i.nodeId),
        ),
      );
      setRegen(new Set());
      setQuote(q);
    } catch (e) {
      const message = errorText(t, e);
      setError(message);
      showToast(message);
    } finally {
      setRunBusy(false);
    }
  };

  /** 勾选「重跑」：复用/已清位切回实计价——重取报价（regen 集进 quoteHash）。 */
  const toggleRegen = async (nodeId: string, on: boolean) => {
    if (!doc || runBusy) return;
    const next = new Set(regen);
    if (on) next.add(nodeId);
    else next.delete(nodeId);
    setRegen(next);
    setRunBusy(true);
    try {
      const q = await quoteCanvas(doc.id, [...next]);
      // 复用位可能随 regen 闭包变化：清掉已落在复用/已清位上的门。
      setGates((g) =>
        new Set(
          [...g].filter((id) => {
            const it = q.items.find((i) => i.nodeId === id);
            return it && !it.reused && !it.purged;
          }),
        ),
      );
      setQuote(q);
    } catch (e) {
      showToast(errorText(t, e));
    } finally {
      setRunBusy(false);
    }
  };

  const toggleGate = (nodeId: string, on: boolean) => {
    setGates((g) => {
      const next = new Set(g);
      if (on) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  };

  const confirmRun = async () => {
    if (!doc || !quote || runBusy) return;
    setRunBusy(true);
    try {
      const run = await createCanvasRunApi({
        canvasId: doc.id,
        quoteHash: quote.hash,
        idempotencyKey: runKeyRef.current ?? newIdempotencyKey(),
        approvalNodeIds: [...gates],
        regenerate: [...regen],
      });
      runKeyRef.current = null;
      lastRunStatus.current = "running";
      setLatestRun(run);
      setQuote(null);
    } catch (e) {
      const message = errorText(t, e);
      // 报价过期：关掉弹层让用户重走「运行整图」拿新报价。
      if (e instanceof ApiError && e.code === "quote_stale") setQuote(null);
      setError(message);
      showToast(message);
    } finally {
      setRunBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!latestRun || latestRun.status !== "running") return;
    try {
      setLatestRun(await cancelCanvasRunApi(latestRun.id));
    } catch (e) {
      showToast(errorText(t, e));
    }
  };

  /** 审批门决策：批准 → 节点回 ready 继续提交；驳回 → blocked 传播下游。 */
  const decideApproval = async (nodeId: string, decision: "approve" | "reject") => {
    if (!latestRun || latestRun.status !== "running") return;
    try {
      setLatestRun(await decideCanvasRunApprovalApi(latestRun.id, nodeId, decision));
    } catch (e) {
      showToast(errorText(t, e));
    }
  };

  const onNodePointerDown = (e: ReactPointerEvent<HTMLElement>, node: CanvasNode) => {
    if (e.button !== 0 || !e.isPrimary) return;
    // 触屏上的拖拽由 pointerdown 起头（原来绑的是 mousedown，手机上要等手指抬起才补发
    // 一次，`drag.current` 于是停在那里，之后随便一划都会把上一个节点拖走 —— review
    // 2026-09-15 C-22）。
    cancelLongPress();
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
    // pointercancel：系统把这次指针收走了（触屏上被滚动 / 手势接管、来电切前台…）。
    // 不收它的话 `drag.current` 会一直留着，下一次划动就接着拖上一个节点。收尾与抬手
    // 一致：落盘当前位置，不回滚——用户看见的就是这个位置。
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [scale, persist]);

  const materialMissing = (node: CanvasNode) => node.assetState === "missing" || node.assetState === "expired" ||
    missingMaterials.has(node.assetId ?? node.uploadId ?? "");
  const nodeById = (id: string) => doc?.nodes.find((n) => n.id === id);
  /*
    D 包 overlay：节点显示最近一次 run 的执行产物，没有 run 记录时回退手动运行的
    `node.jobId`。节点卡与连线都要按它算「在不在等模型」，所以提到这里共用一份。
  */
  const jobOfNode = (node: CanvasNode) => {
    const jid = execOf(node.id)?.jobId ?? node.jobId;
    return jid ? jobs[jid] : undefined;
  };
  const waitOfNode = (node: CanvasNode) => waitStateOf(execOf(node.id), jobOfNode(node), running.has(node.id));
  const inputOf = (nodeId: string) => doc?.edges.find((e) => e.to === nodeId)?.from ?? "";
  const candidatesFor = (node: CanvasNode) =>
    (doc?.nodes ?? []).filter(
      (n) => n.id !== node.id && (n.kind === "text" || n.kind === "material" || n.kind === "gen_image"),
    );

  return (
    <div
      className="canvas-view"
      ref={rootRef}
      tabIndex={-1}
      data-running={latestRun?.status === "running" ? "true" : undefined}
      onContextMenu={onContextMenu}
      onPointerDown={onViewPointerDown}
      onPointerMove={onViewPointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
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
                    <path
                      key={e.id}
                      /* 目标节点在等模型时，这根线走流动虚线：一眼看出「哪一段正在跑」 */
                      data-wait={waitOfNode(to) === "model" ? "model" : undefined}
                      d={`M${x1} ${y1} C ${x1 + 50} ${y1} ${x2 - 50} ${y2} ${x2} ${y2}`}
                    />
                  );
                })}
              </g>
            </svg>

            {doc.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                missing={materialMissing(node)}
                onDragStart={(e) => onNodePointerDown(e, node)}
                onDelete={() => removeNode(node.id)}
                onTextChange={(v) =>
                  mutate((d) => ({
                    nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, text: v } : n)),
                  }))
                }
                onUploadClick={() => {
                  materialFor.current = node.id;
                  fileRef.current?.click();
                }}
                onImageError={() => setMissingMaterials((current) => new Set(current).add(node.assetId ?? node.uploadId!))}
                job={jobOfNode(node)}
                exec={execOf(node.id)}
                running={running.has(node.id)}
                inputOf={inputOf(node.id)}
                candidates={candidatesFor(node)}
                onPrompt={(prompt) =>
                  mutate((d) => ({
                    nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, prompt } : n)),
                  }))
                }
                onInput={(fromId) => setInput(node.id, fromId)}
                products={products}
                onProduct={(productId) =>
                  mutate((d) => ({
                    nodes: d.nodes.map((n) =>
                      n.id === node.id
                        ? { ...n, ...(productId ? { product: productId } : { product: undefined }) }
                        : n,
                    ),
                  }))
                }
                onRun={() => void runNode(node.id)}
                onApproval={(decision) => void decideApproval(node.id, decision)}
              />
            ))}
          </div>
        </div>
      )}

      {menu ? (
        <div className="canvas-menu" ref={menuRef} style={{ left: menu.left, top: menu.top }}>
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

      {doc ? (
        <>
          {/*
            左侧工具栏：fit 公式本来就给它留着 108px（`FIT_PAD_X`），在它真被渲染
            出来之前那段留白没有主人。两个按钮都接真行为——建节点开的是右键那份
            菜单，工具箱抽屉读真模板与真作品。窄屏（≤560）不渲染，那一档的留白也
            按 `FIT_PAD_X_NARROW` 收掉。
          */}
          <div className="canvas-tools">
            <button
              type="button"
              className="canvas-tools__add"
              aria-label={t("canvas.tools.add")}
              title={t("canvas.tools.add")}
              onClick={openMenuFromRail}
            >
              <IconPlus size={19} />
            </button>
            <div className="canvas-tools__group">
              <button
                type="button"
                className="canvas-tools__btn"
                aria-label={t("canvas.tools.toolbox")}
                title={t("canvas.tools.toolbox")}
                aria-expanded={toolbox}
                data-on={toolbox ? "true" : undefined}
                onClick={() => setToolbox((on) => !on)}
              >
                <IconToolbox size={16} />
              </button>
            </div>
          </div>

          <div className="canvas-bottom">
            <button
              type="button"
              className="canvas-bottom__btn"
              aria-label={t("canvas.bottom.fit")}
              title={t("canvas.bottom.fit")}
              onClick={() => setZoom(1)}
            >
              <IconFit size={15} />
            </button>
            <span className="canvas-bottom__sep" />
            <input
              className="canvas-bottom__slider"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={ZOOM_STEP}
              value={zoom}
              aria-label={t("canvas.bottom.zoom")}
              onChange={(e) => setZoom(clamp(MIN_ZOOM, Number(e.target.value), MAX_ZOOM))}
            />
            <span className="canvas-bottom__pct">{Math.round(scale * 100)}%</span>
          </div>
        </>
      ) : null}

      {toolbox ? <CanvasToolbox onClose={() => setToolbox(false)} onApply={applyTool} /> : null}

      {doc && doc.nodes.length === 0 && !menu ? (
        <div className="canvas-empty__hint" style={{ position: "absolute", left: 24, top: 24 }}>
          <IconCursor />
          {t("canvas.empty.rightClick")}
          {/* 「右键新建」不是所有人都会想到，也不是所有设备都有右键：给两个直给的入口。 */}
          <span className="canvas-empty__actions">
            <button type="button" className="canvas-entry" onClick={() => addFirstNode("text")}>
              <span className="canvas-entry__icon">
                <IconText size={12} />
              </span>
              {t("canvas.kind.text")}
            </button>
            <button type="button" className="canvas-entry" onClick={() => addFirstNode("gen_video")}>
              <span className="canvas-entry__icon">
                <IconVideo size={12} />
              </span>
              {t("canvas.kind.gen_video")}
            </button>
          </span>
        </div>
      ) : null}

      {doc && doc.nodes.length > 0 ? (
        <RunBar
          running={latestRun?.status === "running"}
          runBusy={runBusy}
          onRunAll={() => void runAll()}
          onCancel={() => void cancelRun()}
        />
      ) : null}

      {quote ? (
        <QuoteDialog
          quote={quote}
          gates={gates}
          regen={regen}
          runBusy={runBusy}
          dialogRef={quoteRef}
          onExport={() => void exportWorkflow()}
          onToggleGate={toggleGate}
          onToggleRegen={(nodeId, on) => void toggleRegen(nodeId, on)}
          onConfirm={() => void confirmRun()}
          onClose={() => setQuote(null)}
        />
      ) : null}

      {conflict ? (
        <ConflictDialog
          server={conflict.server}
          localNodes={doc?.nodes.length ?? 0}
          localEdges={doc?.edges.length ?? 0}
          dialogRef={conflictRef}
          onKeepLocal={() => void resolveKeepLocal()}
          onUseServer={resolveUseServer}
        />
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
