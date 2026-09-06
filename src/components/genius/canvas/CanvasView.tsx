"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import CanvasToolbox from "./CanvasToolbox";
import {
  CANVAS_MODELS,
  COST_TEXT,
  COST_VIDEO,
  FIT_PAD_X,
  FIT_PAD_Y,
  ICON_GRADS,
  NODE_TEXT_1,
  RESULT_BLOCK,
  RTE_ACTIVE,
  RTE_ITEMS,
  SCENE_H,
  SCENE_W,
  SEED_PROMPT,
  SKELETON_ROWS,
  VIDEO_SEED_PROMPT,
  shot,
} from "./data";
import {
  IconArrowUp,
  IconAudio,
  IconBoard,
  IconBolt,
  IconBot,
  IconCursor,
  IconExpand,
  IconFace,
  IconFit,
  IconFolder,
  IconGrid9,
  IconImage,
  IconMinimap,
  IconPanels,
  IconPlay,
  IconPlus,
  IconPointer,
  IconRedo,
  IconShare,
  IconText,
  IconToolbox,
  IconUndo,
  IconVideo,
  IconVolume,
} from "./icons";

type Stage = 0 | 1 | 2;
type NodeKind = "text" | "video";
type NodeState = "idle" | "busy" | "done";
type MenuPos = { x: number; y: number };

/**
 * 作者坐标系里的节点几何：标签行 22px（13px 文字 + 6px 间距），正文体紧随其后。
 * 文本节点上方多一条 44px 富文本条，故 y 提前 44，两种节点的正文体顶边都落在 ADDED_BODY_TOP。
 */
const LABEL_H = 22;
const RTE_H = 44;
const ADDED_BODY_TOP = 172;
const RECTS = {
  text1: { x: 24, y: 150, w: 264, h: 150 },
  img1: { x: 384, y: 74, w: 200, h: 112 },
  addedText: { x: 470, y: ADDED_BODY_TOP - LABEL_H - RTE_H, w: 270, h: 150 },
  addedVideo: { x: 470, y: ADDED_BODY_TOP - LABEL_H, w: 270, h: 152 },
  upload: { x: 24, y: 340, w: 130, h: 173 },
  output: { x: 180, y: 340, w: 130, h: 173 },
  prompt: { x: 440, y: 330, w: 340 },
} as const;

const MENU_W = 158;
const MENU_H = 202;
const DEFAULT_MENU: MenuPos = { x: 300, y: 224 };

function clamp(min: number, v: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

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
 * 画布视图（交接包 §6，原型图 2、26–37）。
 * 空态 → 场景层（900×620 作者坐标 + fit×zoom）→ 节点 / ⊕ 手柄 / 类型菜单 / 富文本条 /
 * 提示词面板 / 模型列表 / 工具箱抽屉 / 应用工具落节点并连线 / 发送后骨架→结果 / 视频节点。
 * 全部本地 state，占位数据，不发任何请求。
 */
export default function CanvasView() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [stage, setStage] = useState<Stage>(0);
  const [hoverText1, setHoverText1] = useState(false);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [nodeKind, setNodeKind] = useState<NodeKind | null>(null);
  const [nodeState, setNodeState] = useState<NodeState>("idle");
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [refsAdded, setRefsAdded] = useState(false);
  const [model, setModel] = useState("Claude Sonnet 4.6");
  const [modelPop, setModelPop] = useState(false);
  const [prompt, setPrompt] = useState("");

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeModel = useCallback(() => setModelPop(false), []);
  useDismiss(menu !== null, menuRef, closeMenu);
  useDismiss(modelPop, modelRef, closeModel);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // fit = clamp(0.4, min((W-108)/900, (H-72)/620), 1.4)；W/H 取本组件实际尺寸。
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

  const scale = (fit * zoom) / 100;
  const isVideoNode = nodeKind === "video";
  const nodeAdded = stage >= 2 && nodeKind !== null;
  const cost = isVideoNode ? COST_VIDEO : COST_TEXT;
  const modelLabel = isVideoNode ? "Genius V6" : model;

  const openMenuAt = (pos: MenuPos) => {
    setStage((s) => (s === 0 ? 1 : s));
    setMenu(pos);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = sceneRef.current;
    if (!el) {
      openMenuAt(DEFAULT_MENU);
      return;
    }
    const r = el.getBoundingClientRect();
    openMenuAt({
      x: clamp(0, (e.clientX - r.left) / scale, SCENE_W - MENU_W),
      y: clamp(0, (e.clientY - r.top) / scale, SCENE_H - MENU_H),
    });
  };

  const addNode = (kind: NodeKind) => {
    setMenu(null);
    setNodeKind(kind);
    setNodeState("idle");
    setStage(2);
    setPrompt(kind === "video" ? VIDEO_SEED_PROMPT : "");
  };

  const send = () => {
    if (!prompt.trim()) {
      setPrompt(SEED_PROMPT);
      return;
    }
    setNodeState("busy");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNodeState("done"), 1600);
  };

  const applyTool = () => {
    setToolboxOpen(false);
    setRefsAdded(true);
    setStage(2);
    setNodeKind((k) => k ?? "text");
  };

  const addedRect = isVideoNode ? RECTS.addedVideo : RECTS.addedText;
  const addedCenterY = ADDED_BODY_TOP + addedRect.h / 2;
  const text1CenterY = RECTS.text1.y + LABEL_H + RECTS.text1.h / 2;
  const img1CenterY = RECTS.img1.y + LABEL_H + RECTS.img1.h / 2;
  const uploadCenterY = RECTS.upload.y + LABEL_H + RECTS.upload.h / 2;

  return (
    <div
      className="canvas-view"
      ref={rootRef}
      onContextMenu={onContextMenu}
      style={{ backgroundSize: `${Math.round(22 * scale)}px ${Math.round(22 * scale)}px` }}
    >
      {stage === 0 ? (
        <div className="canvas-empty">
          <div className="canvas-empty__lead">
            <div className="canvas-empty__cards" aria-hidden="true">
              <span
                className="canvas-empty__card canvas-empty__card--a"
                style={{ backgroundImage: `url(${shot(3)})` }}
              />
              <span
                className="canvas-empty__card canvas-empty__card--b"
                style={{ backgroundImage: `url(${shot(5)})` }}
              />
            </div>
            <div className="canvas-empty__copy">
              <span className="canvas-empty__hint">
                <IconPointer />
                右键
              </span>
              <span className="canvas-empty__title">在画布上放下第一个节点</span>
              <span className="canvas-empty__sub">从这里开始搭建你的镜头流程</span>
            </div>
          </div>
          <div className="canvas-empty__actions">
            <button type="button" className="canvas-entry" onClick={() => setStage(1)}>
              <span className="canvas-entry__icon">
                <IconImage size={15} />
              </span>
              生图
            </button>
            <button type="button" className="canvas-entry" onClick={() => setStage(1)}>
              <span className="canvas-entry__icon">
                <IconVideo size={15} />
              </span>
              故事视频
            </button>
            <button type="button" className="canvas-entry" onClick={() => setStage(1)}>
              <span className="canvas-entry__icon">
                <IconFace />
              </span>
              三视图
            </button>
            <button type="button" className="canvas-entry" onClick={() => setStage(1)}>
              <span className="canvas-entry__icon">
                <IconGrid9 />
              </span>
              九宫格
            </button>
          </div>
        </div>
      ) : null}

      {stage > 0 ? (
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
                <path
                  d={`M${RECTS.text1.x + RECTS.text1.w} ${text1CenterY - 7} C ${RECTS.text1.x + RECTS.text1.w + 34} ${text1CenterY - 7} ${RECTS.img1.x - 36} ${img1CenterY} ${RECTS.img1.x} ${img1CenterY}`}
                />
                {nodeAdded ? (
                  <path
                    d={`M${RECTS.text1.x + RECTS.text1.w} ${text1CenterY + 8} C ${RECTS.text1.x + RECTS.text1.w + 62} ${text1CenterY + 8} ${addedRect.x - 60} ${addedCenterY} ${addedRect.x} ${addedCenterY}`}
                  />
                ) : null}
                {refsAdded ? (
                  <>
                    <path
                      d={`M${RECTS.upload.x + RECTS.upload.w} ${uploadCenterY} C ${RECTS.upload.x + RECTS.upload.w + 10} ${uploadCenterY} ${RECTS.output.x - 10} ${uploadCenterY} ${RECTS.output.x} ${uploadCenterY}`}
                    />
                    {nodeAdded ? (
                      <path
                        d={`M${RECTS.output.x + RECTS.output.w} ${uploadCenterY} C ${RECTS.output.x + RECTS.output.w + 60} ${uploadCenterY} ${addedRect.x - 60} ${addedCenterY} ${addedRect.x} ${addedCenterY}`}
                      />
                    ) : null}
                  </>
                ) : null}
              </g>
            </svg>

            {/* 文本 1 */}
            <div
              className="canvas-node"
              style={{ left: RECTS.text1.x, top: RECTS.text1.y, width: RECTS.text1.w }}
              onMouseEnter={() => setHoverText1(true)}
              onMouseLeave={() => setHoverText1(false)}
            >
              <span className="canvas-node__label">
                <IconText size={12} />
                文本 1
              </span>
              <div className="canvas-node__body canvas-node__body--text" style={{ height: RECTS.text1.h }}>
                {NODE_TEXT_1}
                {hoverText1 ? (
                  <>
                    <button
                      type="button"
                      className="canvas-node__handle canvas-node__handle--left"
                      aria-label="在左侧添加节点"
                      onClick={() => openMenuAt({ x: 24, y: 224 })}
                    >
                      <IconPlus size={10} />
                    </button>
                    <button
                      type="button"
                      className="canvas-node__handle canvas-node__handle--right"
                      aria-label="在右侧添加节点"
                      onClick={() => openMenuAt(DEFAULT_MENU)}
                    >
                      <IconPlus size={10} />
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            {/* 图片 1 */}
            <div
              className="canvas-node"
              style={{ left: RECTS.img1.x, top: RECTS.img1.y, width: RECTS.img1.w }}
            >
              <span className="canvas-node__label">
                <IconImage size={12} />
                图片 1
              </span>
              <span
                className="canvas-node__shot"
                style={{ backgroundImage: `url(${shot(3)})`, aspectRatio: "16 / 9" }}
              />
            </div>

            {/* 工具应用后落下的两个节点 */}
            {refsAdded ? (
              <>
                <div
                  className="canvas-node canvas-node--pop"
                  style={{ left: RECTS.upload.x, top: RECTS.upload.y, width: RECTS.upload.w }}
                >
                  <span className="canvas-node__label">
                    <IconImage size={12} />
                    Upload a picture
                  </span>
                  <span
                    className="canvas-node__shot"
                    style={{ backgroundImage: `url(${shot(1)})`, aspectRatio: "3 / 4" }}
                  />
                </div>
                <div
                  className="canvas-node canvas-node--pop"
                  style={{ left: RECTS.output.x, top: RECTS.output.y, width: RECTS.output.w }}
                >
                  <span className="canvas-node__label">
                    <IconVideo size={12} />
                    Output Results
                  </span>
                  <div className="canvas-clip" style={{ backgroundImage: `url(${shot(6)})` }}>
                    <span className="canvas-clip__bar">
                      <IconPlay />
                      <span className="canvas-clip__track">
                        <span className="canvas-clip__fill" />
                      </span>
                      <span className="canvas-clip__time">00:05</span>
                    </span>
                  </div>
                </div>
              </>
            ) : null}

            {/* 新增节点（文本 3 / 视频 2） */}
            {nodeAdded ? (
              <div
                className="canvas-node canvas-node--pop"
                style={{ left: addedRect.x, top: addedRect.y, width: addedRect.w }}
              >
                {!isVideoNode ? (
                  <div className="canvas-rte" role="toolbar" aria-label="富文本">
                    {RTE_ITEMS.map((r, i) => (
                      <span key={r} className="canvas-rte__item" data-on={i === RTE_ACTIVE ? "true" : undefined}>
                        {r}
                      </span>
                    ))}
                  </div>
                ) : null}
                <span className="canvas-node__label">
                  {isVideoNode ? <IconVideo size={12} /> : <IconText size={12} />}
                  {isVideoNode ? "视频 2" : "文本 3"}
                </span>
                <div
                  className={
                    isVideoNode ? "canvas-node__body canvas-node__body--video" : "canvas-node__body"
                  }
                  style={{ minHeight: addedRect.h }}
                  data-state={nodeState}
                >
                  {nodeState === "idle" ? (
                    <span className="canvas-node__hint">{isVideoNode ? "生成视频" : "请输入内容…"}</span>
                  ) : null}
                  {nodeState === "busy" ? (
                    <>
                      <div className="canvas-skeleton">
                        {SKELETON_ROWS.map((w, i) => (
                          <span key={i} className="canvas-skeleton__row" style={{ width: w }} />
                        ))}
                      </div>
                      <div className="canvas-progress">
                        <span className="canvas-progress__pct">50%</span>
                        <span className="canvas-progress__track">
                          <span className="canvas-progress__fill" />
                        </span>
                      </div>
                    </>
                  ) : null}
                  {nodeState === "done" ? (
                    isVideoNode ? (
                      <div className="canvas-clip canvas-clip--full" style={{ backgroundImage: `url(${shot(9)})` }}>
                        <span className="canvas-clip__bar">
                          <IconPlay />
                          <span className="canvas-clip__track">
                            <span className="canvas-clip__fill" />
                          </span>
                          <span className="canvas-clip__time">00:05</span>
                        </span>
                      </div>
                    ) : (
                      <div className="canvas-result">
                        <span className="canvas-result__title">{RESULT_BLOCK.title}</span>
                        <span className="canvas-result__sub">{RESULT_BLOCK.concept}</span>
                        <span className="canvas-result__rule" />
                        <span className="canvas-result__sub">{RESULT_BLOCK.sceneLabel}</span>
                        <span>{RESULT_BLOCK.scene}</span>
                        <span className="canvas-result__rule" />
                        <span className="canvas-result__sub">{RESULT_BLOCK.layoutLabel}</span>
                      </div>
                    )
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* 提示词面板 */}
            {nodeAdded ? (
              <div
                className="canvas-prompt"
                style={{ left: RECTS.prompt.x, top: RECTS.prompt.y, width: RECTS.prompt.w }}
              >
                <div className="canvas-prompt__head">
                  {refsAdded ? (
                    <span className="canvas-prompt__ref" style={{ backgroundImage: `url(${shot(1)})` }} />
                  ) : null}
                  <button type="button" className="canvas-prompt__icon" data-on="true" aria-label="文本">
                    <IconText size={15} />
                  </button>
                  <button type="button" className="canvas-prompt__icon" aria-label="添加参考">
                    <IconPlus size={15} />
                  </button>
                  <button
                    type="button"
                    className="canvas-prompt__icon canvas-prompt__icon--ring"
                    title="从工具箱选择参考"
                    aria-label="从工具箱选择参考"
                    onClick={() => setToolboxOpen(true)}
                  >
                    <IconToolbox size={15} />
                  </button>
                  <span className="canvas-prompt__expand" aria-hidden="true">
                    <IconExpand />
                  </span>
                </div>

                <textarea
                  className="canvas-prompt__text"
                  value={prompt}
                  maxLength={5000}
                  aria-label="画布提示词"
                  placeholder="描述您想要生成的任何内容…"
                  onChange={(e) => setPrompt(e.target.value)}
                />

                <div className="canvas-prompt__foot" ref={modelRef}>
                  <button
                    type="button"
                    className="canvas-model"
                    aria-expanded={modelPop}
                    aria-haspopup="menu"
                    data-open={modelPop ? "true" : undefined}
                    onClick={() => setModelPop((v) => !v)}
                  >
                    <span className="canvas-model__dot" />
                    {modelLabel}
                  </button>
                  {isVideoNode ? (
                    <span className="canvas-vidchip">
                      参考 · 16:9 · 540p · 3秒
                      <IconVolume />
                    </span>
                  ) : null}
                  <span className="canvas-prompt__count">{prompt.length}/5000</span>
                  <span className="canvas-prompt__cost">
                    <IconBolt />
                    {cost}
                  </span>
                  <button type="button" className="canvas-prompt__send" aria-label="发送" onClick={send}>
                    <IconArrowUp />
                  </button>

                  {modelPop ? (
                    <div className="canvas-modelpop" role="menu">
                      <span className="canvas-modelpop__title">模型</span>
                      {CANVAS_MODELS.map((m, i) => (
                        <button
                          type="button"
                          key={m.key}
                          role="menuitem"
                          className="canvas-modelpop__item"
                          data-current={model.startsWith(m.key) ? "true" : undefined}
                          onClick={() => {
                            setModel(m.full);
                            setModelPop(false);
                          }}
                        >
                          <span
                            className="canvas-modelpop__icon"
                            style={{ background: ICON_GRADS[i % ICON_GRADS.length] }}
                          />
                          <span className="canvas-modelpop__body">
                            <span className="canvas-modelpop__name">{m.name}</span>
                            <span className="canvas-modelpop__desc">{m.desc}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* 节点类型菜单 */}
            {menu ? (
              <div className="canvas-menu" role="menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
                <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => addNode("text")}>
                  <IconText />
                  文本
                </button>
                <button type="button" role="menuitem" className="canvas-menu__item" onClick={closeMenu}>
                  <IconImage />
                  图片
                </button>
                <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => addNode("video")}>
                  <IconVideo />
                  视频
                </button>
                <button type="button" role="menuitem" className="canvas-menu__item" onClick={closeMenu}>
                  <IconAudio />
                  音频
                </button>
                <button type="button" role="menuitem" className="canvas-menu__item" onClick={closeMenu}>
                  <IconBoard />
                  分镜表
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 右上浮层 */}
      <div className="canvas-topright">
        <button type="button" className="canvas-topright__btn">
          <IconShare />
          分享
        </button>
        <button type="button" className="canvas-topright__btn">
          <IconBot />
          智能助手
        </button>
      </div>

      {/* 左侧工具栏 */}
      <div className="canvas-tools">
        <button
          type="button"
          className="canvas-tools__add"
          aria-label="添加节点"
          onClick={() => openMenuAt(DEFAULT_MENU)}
        >
          <IconPlus />
        </button>
        <div className="canvas-tools__group">
          <button type="button" className="canvas-tools__btn" data-on="true" title="选择" aria-label="选择">
            <IconCursor />
          </button>
          <button type="button" className="canvas-tools__btn" title="素材" aria-label="素材">
            <IconFolder />
          </button>
          <button
            type="button"
            className="canvas-tools__btn"
            title="工具箱"
            aria-label="工具箱"
            aria-expanded={toolboxOpen}
            data-on={toolboxOpen ? "true" : undefined}
            onClick={() => {
              setStage((s) => (s === 0 ? 1 : s));
              setToolboxOpen(true);
            }}
          >
            <IconToolbox />
          </button>
          <button type="button" className="canvas-tools__btn" title="撤销" aria-label="撤销">
            <IconUndo />
          </button>
          <button type="button" className="canvas-tools__btn" title="重做" aria-label="重做">
            <IconRedo />
          </button>
        </div>
      </div>

      {toolboxOpen ? <CanvasToolbox onClose={() => setToolboxOpen(false)} onApply={applyTool} /> : null}

      {/* 左下控制条 */}
      <div className="canvas-bottom">
        <button type="button" className="canvas-bottom__btn" title="面板" aria-label="面板">
          <IconPanels />
        </button>
        <button
          type="button"
          className="canvas-bottom__btn"
          title="适应画布"
          aria-label="适应画布"
          onClick={() => setZoom(100)}
        >
          <IconFit />
        </button>
        <button type="button" className="canvas-bottom__btn" title="缩略图" aria-label="缩略图">
          <IconMinimap />
        </button>
        <span className="canvas-bottom__sep" />
        <input
          className="canvas-bottom__slider"
          type="range"
          min={20}
          max={200}
          value={zoom}
          aria-label="缩放"
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <span className="canvas-bottom__pct">{Math.round(fit * zoom)}%</span>
      </div>
    </div>
  );
}
