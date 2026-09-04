"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import type { NativeMode } from "@/lib/providers/types";
import type { SceneProgress } from "@/types/scene";
import { estimateCostUsd } from "@/lib/cost";
import { MODEL_1_5, MODEL_IMAGE } from "@/lib/providers/grok/mode-matrix";
import { createJob, newIdempotencyKey, uploadFile } from "@/lib/client/jobs";
import { useJobLive } from "@/lib/client/useJobLive";
import { formatElapsed, isActive, isFailed, isTerminal, stageIndex } from "@/lib/client/labels";
import { AccessTokenPrompt } from "@/components/shell/AccessTokenPrompt";
import { SceneHost } from "@/components/scene/SceneHost";
import { mountReel, mountWall, type ReelHandle, type WallHandle } from "@/lib/scene/lumen-three";
import { RegistrationMark, RuledDataStrip, SectionRule } from "./marks";

/* ── 常量：三条路径、画幅、时长、示例成片 ── */

type UiMode = "t2v" | "i2v" | "t2i";
const MODES: { id: UiMode; label: string; native: NativeMode }[] = [
  { id: "t2v", label: "文生视频", native: "text_to_video" },
  { id: "i2v", label: "图生视频", native: "image_to_video" },
  { id: "t2i", label: "文生图", native: "text_to_image" },
];
const UI_MODE_OF: Partial<Record<NativeMode, UiMode>> = { text_to_video: "t2v", image_to_video: "i2v", text_to_image: "t2i" };
const RATIOS = ["16:9", "9:16", "1:1"] as const;
const DURS = [4, 6, 8, 10] as const;
const STAGE_LABELS = ["排队 / Queued", "提交 / Submit", "生成 / Render", "落盘 / Write", "完成 / Done"];
const STAGES = ["排队", "提交", "生成", "落盘", "完成"];

const PATHS: { id: UiMode; index: string; title: string; desc: string; meta: string }[] = [
  { id: "t2v", index: "I", title: "文生视频", desc: "只写提示词。描述主体、光线、镜头与节奏，得到一段 4–10 秒的成片。", meta: "Text → Video · 720p" },
  { id: "i2v", index: "II", title: "图生视频", desc: "上传一张首帧，它就是起始画面。尾帧仅保存，用于后续长片一致性。", meta: "Image → Video · First frame" },
  { id: "t2i", index: "III", title: "文生图", desc: "一张静帧，立刻出。适合先定画面，再决定要不要让它动。", meta: "Text → Image · 1K / 2K" },
];

const SAMPLE_IMGS = ["2e9cde0e2fb0803e", "a72d8b509c55bcd0", "a1f3319d0d783e66", "f3bfe52263d0656d", "d99c0972e1f99b67", "a9008119d34b8fc1", "5a09f4952b5ad9b6", "6f297b60448c30c9"];
const SAMPLE_PROMPTS = ["玉米田深处，一个穿银色防护服的人走来", "像素风峡谷日出，河流蜿蜒穿过山谷", "雨夜的外滩，一位穿深青色风衣的女人走向江边", "清晨的山谷薄雾，镜头缓慢推进", "霓虹街道，慢速推轨", "海岸线航拍，日落前", "旧仓库里的一束光", "雪后的胡同口"];

type Plate = {
  key: string;
  jobId: string;
  src: string;
  videoUrl: string | null;
  prompt: string;
  mode: UiMode;
  dur: number;
  ratio: string;
  quality: string;
  model: string;
  audio: boolean;
  cost: number;
  sample: boolean;
};

function platesFromJobs(jobs: JobPublic[]): Plate[] {
  const real = jobs
    .filter((j) => j.status === "succeeded" && j.output && UI_MODE_OF[j.mode])
    .map<Plate>((j) => ({
      key: j.id,
      jobId: j.id,
      src: j.output!.kind === "video" ? j.output!.posterUrl : j.output!.imageUrl,
      videoUrl: j.output!.kind === "video" ? j.output!.videoUrl : null,
      prompt: j.prompt || "（无提示词，以素材为准）",
      mode: UI_MODE_OF[j.mode]!,
      dur: j.durationSec,
      ratio: j.aspectRatio ?? "16:9",
      quality: j.mode === "text_to_image" ? (j.imageResolution ?? "1k").toUpperCase() : (j.resolution ?? "720p"),
      model: j.model,
      audio: j.generateAudio,
      cost: j.costUsdActual ?? j.costUsdEstimate,
      sample: false,
    }));
  if (real.length) return real;
  // 还没有成片时用占位样片撑起画廊与存档
  return SAMPLE_IMGS.map<Plate>((n, i) => {
    const dur = 6 + (i % 3) * 2;
    return {
      key: `sample-${n}`,
      jobId: ("7F2A9C" + i).slice(-6).toUpperCase(),
      src: `/lumina/${n}.webp`,
      videoUrl: null,
      prompt: SAMPLE_PROMPTS[i],
      mode: i % 3 === 2 ? "i2v" : "t2v",
      dur,
      ratio: "16:9",
      quality: "720p",
      model: MODEL_1_5,
      audio: true,
      cost: dur * 0.05,
      sample: true,
    };
  });
}

type Frame = { preview: string; uploadId: string | null; state: "busy" | "ready" | "error"; message?: string };

const pad2 = (n: number) => String(n).padStart(2, "0");
const modeLabel = (m: UiMode) => MODES.find((x) => x.id === m)!.label;
/** 任务 id 是随机十六进制，取尾 4 位做读数 */
const shortId = (id: string) => id.replace(/^job_/, "").slice(-4).toUpperCase();

// useJobLive 需要一个 job；没有任务时给它一个终态哑对象，effect 直接跳过
const NO_JOB = { id: "", status: "succeeded" } as const;

export function LumenHome({ initialJobs, mock }: { initialJobs: JobPublic[]; mock: boolean }) {
  const [jobs, setJobs] = useState<JobPublic[]>(initialJobs);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<UiMode>("t2v");
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]>("16:9");
  const [dur, setDur] = useState<(typeof DURS)[number]>(8);
  const [first, setFirst] = useState<Frame | null>(null);
  const [last, setLast] = useState<Frame | null>(null);
  const [tray, setTray] = useState(false);
  const [job, setJob] = useState<JobPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [hovered, setHovered] = useState(-1);
  const [scrollP, setScrollP] = useState(0);
  const [drag, setDrag] = useState(0);
  const [detail, setDetail] = useState<number | null>(null);

  const reel = useRef<ReelHandle | null>(null);
  const wall = useRef<WallHandle | null>(null);
  const gallery = useRef<HTMLElement>(null);
  const detailEl = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const lastInput = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  const dragX = useRef<number | null>(null);
  const turn = useRef(0);

  const isVideo = mode !== "t2i";
  const model = isVideo ? MODEL_1_5 : MODEL_IMAGE;
  const plates = useMemo(() => platesFromJobs(jobs), [jobs]);
  // 环上只挂最近 12 张；设计稿 R=7.2 对应 8 张，更多时按数量放大半径保持间距
  const ring = useMemo(() => plates.slice(0, 12), [plates]);
  const ringRadius = Math.max(7.2, ring.length * 0.9);
  const wallKey = ring.map((p) => p.src).join("|");

  /* ── 任务跟踪 ── */
  const onUnauthorized = useCallback(() => setAuthRequired(true), []);
  const upsert = useCallback((j: JobPublic) => {
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [j, ...prev]));
  }, []);
  const onLive = useCallback(
    (j: JobPublic) => {
      setJob(j);
      upsert(j);
    },
    [upsert],
  );
  useJobLive(job ?? NO_JOB, onLive, onUnauthorized);

  const active = !!job && isActive(job.status);
  useEffect(() => {
    if (!active) return;
    const t0 = window.setTimeout(() => setNow(Date.now()), 0);
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(t);
    };
  }, [active]);

  const progress: SceneProgress = useMemo(() => {
    if (!job) return { phase: "idle", progress: 0 };
    if (isActive(job.status)) return { phase: "working", progress: job.progress };
    if (job.status === "succeeded") return { phase: "done", progress: 100 };
    return { phase: "error", progress: job.progress };
  }, [job]);
  useEffect(() => {
    reel.current?.setProgress(progress);
  }, [progress]);

  /* ── 画廊：滚动区间进度 + 拖拽偏移 → 环旋转 ── */
  const turnValue = scrollP * 0.5 + drag;
  useEffect(() => {
    turn.current = turnValue;
    wall.current?.setScroll(turnValue);
  }, [turnValue, wallKey]);
  useEffect(() => {
    const onScroll = () => {
      const el = gallery.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, -r.top / (r.height - window.innerHeight)));
      setScrollP((prev) => (Math.abs(p - prev) > 0.002 ? p : prev));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const frac = ((turnValue % 1) + 1) % 1;
  const derivedSel = ring.length ? Math.floor(frac * ring.length) % ring.length : 0;
  const sel = hovered >= 0 ? hovered : detail != null && detail < ring.length ? detail : derivedSel;
  const selPlate = ring[sel] ?? ring[0];

  /* ── 详情：打开后平滑滚到该区域 ── */
  const openDetail = useCallback((i: number) => {
    setDetail(i);
  }, []);
  useEffect(() => {
    if (detail == null) return;
    const el = detailEl.current;
    if (!el) return;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 40, behavior: "smooth" });
  }, [detail]);

  const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  const scrollToId = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  /* ── 首尾帧 ── */
  async function pickFrame(role: "start" | "last", file: File | undefined) {
    if (!file) return;
    const set = role === "start" ? setFirst : setLast;
    const prev = role === "start" ? first : last;
    if (prev?.preview) URL.revokeObjectURL(prev.preview);
    const preview = URL.createObjectURL(file);
    set({ preview, uploadId: null, state: "busy" });
    if (role === "start" && mode === "t2v") setMode("i2v");
    setError(null);
    try {
      const up = await uploadFile(file, role, onUnauthorized);
      set({ preview, uploadId: up.uploadId, state: "ready" });
    } catch (e) {
      set({ preview, uploadId: null, state: "error", message: e instanceof Error ? e.message : "上传失败" });
    }
  }
  function toggleFrame(role: "start" | "last") {
    const cur = role === "start" ? first : last;
    if (cur) {
      URL.revokeObjectURL(cur.preview);
      (role === "start" ? setFirst : setLast)(null);
      return;
    }
    (role === "start" ? firstInput : lastInput).current?.click();
  }

  function pickMode(next: UiMode) {
    setMode(next);
    setError(null);
  }

  /* ── 提交：沿用 GenerateForm 的 /api/jobs 契约 ── */
  async function submit() {
    if (busy || active) return;
    setError(null);
    try {
      if (mode !== "i2v" && !prompt.trim()) throw new Error("这条路径需要提示词");
      if (mode === "i2v" && first?.state !== "ready") throw new Error(first?.state === "busy" ? "首帧还在上传，请稍候" : "图生视频需要先选一张首帧");
      if (last?.state === "busy") throw new Error("尾帧还在上传，请稍候");
      setBusy(true);
      // 网络抖动时沿用同一个 key，服务端回放原任务而不是重复计费
      idempotencyKey.current ??= newIdempotencyKey();
      const native = MODES.find((m) => m.id === mode)!.native;
      const body: Record<string, unknown> = { mode: native, prompt, idempotencyKey: idempotencyKey.current };
      if (mode === "t2i") {
        body.aspectRatio = ratio;
        body.imageResolution = "1k";
      } else {
        body.durationSec = dur;
        body.aspectRatio = ratio;
        body.resolution = "720p";
        body.generateAudio = true;
        if (mode === "i2v") body.startUploadId = first!.uploadId;
        if (last?.state === "ready" && last.uploadId) body.lastUploadId = last.uploadId;
      }
      const created = await createJob(body, onUnauthorized);
      idempotencyKey.current = null;
      setJob(created);
      upsert(created);
      setTray(false);
      setDetail(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reuse(p: Plate) {
    setPrompt(p.prompt);
    setMode(p.mode);
    setDetail(null);
    scrollTop();
    textarea.current?.focus();
  }

  /* ── 派生文案 ── */
  const done = !!job && job.status === "succeeded" && !!job.output;
  const failed = !!job && isFailed(job.status);
  const statusLine = !job ? "Idle · 待机" : active ? "Rendering · 渲染中" : failed ? "Failed · 失败" : "Done · 已完成";
  const summary = [
    isVideo ? "Grok · video" : "Grok · image",
    modeLabel(mode),
    isVideo ? `${dur}s` : null,
    ratio,
    first ? "首帧" : null,
    isVideo && last ? "尾帧" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const stageIdx = job ? stageIndex(job.status) : -1;
  const jobStage = !job ? "" : failed ? `失败 / ${job.status === "canceled" ? "Canceled" : job.status === "expired" ? "Expired" : "Failed"}` : STAGE_LABELS[Math.max(0, stageIdx)];
  const jobClock = job ? formatElapsed(job.createdAt, isTerminal(job.status) ? new Date(job.updatedAt).getTime() : now) : "00:00";
  const jobPct = job ? `${Math.round(isTerminal(job.status) && !failed ? 100 : job.progress)}%` : "";
  const resultMeta = job
    ? [modeLabel(UI_MODE_OF[job.mode] ?? "t2v"), job.mode === "text_to_image" ? (job.imageResolution ?? "1k").toUpperCase() : `${job.durationSec}s · ${job.resolution ?? "720p"}`, job.aspectRatio ?? ratio].join(" · ")
    : "";
  const detailPlate = detail != null ? plates[detail] : null;
  const wallPos = String(Math.round(frac * 360)).padStart(3, "0") + "°";
  const frameNote = mode === "i2v" ? "首帧即起始画面；尾帧仅保存。" : "选首帧会切到图生视频；尾帧仅保存。";
  const placeholder = mode === "i2v" ? "首帧图作为起始画面，提示词可选…" : "雨夜的外滩，一位穿深青色风衣的女人走向江边…";

  const frameBtn = (f: Frame | null, label: string, role: "start" | "last") => (
    <button
      type="button"
      className="frame-btn"
      data-on={!!f}
      data-state={f?.state}
      title={f?.message ?? (f ? `移除${label}` : `选择${label}`)}
      style={f ? { backgroundImage: `url(${f.preview})` } : undefined}
      onClick={() => toggleFrame(role)}
    >
      <span>{f ? (f.state === "busy" ? `${label} …` : f.state === "error" ? `${label} ✕` : `${label} ✓`) : `+ ${label}`}</span>
    </button>
  );

  return (
    <div className="lm" id="top">
      {/* ── 1. 首屏：放映机线版 + 居中输入框 ── */}
      <section className="hero">
        <SceneHost
          className="hero__canvas"
          aria-hidden="true"
          mount={(c) => mountReel(c, { ink: "#2148B8", accent: "#C65F38", follow: true, distance: 4.2, offsetX: -1.3 })}
          onReady={(h) => {
            reel.current = h;
            h?.setProgress(progress);
          }}
        />
        <header className="masthead">
          <a href="#top" className="masthead__brand" onClick={scrollToId("top")}>
            <span className="masthead__cn">流光</span>
            <span className="masthead__en">Lumen</span>
          </a>
          <nav className="masthead__nav">
            <a href="#gallery" onClick={scrollToId("gallery")}>画廊 / Gallery</a>
            <a href="#archive" onClick={scrollToId("archive")}>存档 / Archive</a>
            <span className="ink-accent">Cobalt + Terracotta</span>
          </nav>
        </header>
        <div className="masthead__rule" />
        <div className="hero__title">
          <h1>
            写下一个镜头，
            <br />
            看它转起来。
          </h1>
          <p>
            Write a shot. Watch it turn.
            <br />
            Text to video · image to video · text to image
          </p>
        </div>

        <div className="prompt-wrap">
          <div className="prompt">
            <div className="prompt__top">
              <span>Prompt / 提示词</span>
              <span className={active ? "ink-accent" : undefined}>{statusLine}</span>
            </div>
            <textarea
              ref={textarea}
              rows={3}
              value={prompt}
              maxLength={2000}
              placeholder={placeholder}
              aria-label="提示词"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="prompt__bar">
              <button type="button" className="prompt__summary" onClick={() => setTray((v) => !v)} aria-expanded={tray}>
                <span className="ink-accent prompt__glyph">{tray ? "−" : "+"}</span>
                <span>{summary}</span>
              </button>
              <button type="button" className="prompt__submit" onClick={() => void submit()} disabled={busy || active}>
                {active ? "Rendering" : busy ? "Sending" : "Generate 生成"}
              </button>
            </div>

            {tray ? (
              <div className="tray">
                <div className="tray__row">
                  <span className="tray__key">路径 / Path</span>
                  <div className="tray__modes" role="radiogroup" aria-label="路径">
                    {MODES.map((m) => (
                      <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className="radio" data-on={mode === m.id} onClick={() => pickMode(m.id)}>
                        <span className="radio__dot" />
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="tray__row">
                  <span className="tray__key">模型 / Model</span>
                  <select
                    className="tray__select"
                    aria-label="模型"
                    value={model}
                    onChange={(e) => pickMode(e.target.value === MODEL_IMAGE ? "t2i" : mode === "t2i" ? "t2v" : mode)}
                  >
                    <option value={MODEL_1_5}>grok-imagine-video</option>
                    <option value={MODEL_IMAGE}>grok-imagine-image</option>
                  </select>
                </div>
                {isVideo ? (
                  <div className="tray__row">
                    <span className="tray__key">时长 / Length</span>
                    <div className="seg" role="radiogroup" aria-label="时长">
                      {DURS.map((d) => (
                        <button key={d} type="button" role="radio" aria-checked={dur === d} data-on={dur === d} onClick={() => setDur(d)}>
                          {d}s
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="tray__row" data-last={!isVideo}>
                  <span className="tray__key">画幅 / Ratio</span>
                  <div className="seg" role="radiogroup" aria-label="画幅">
                    {RATIOS.map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={ratio === r} data-on={ratio === r} onClick={() => setRatio(r)}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
                {isVideo ? (
                  <div className="tray__row" data-last>
                    <span className="tray__key">首尾帧 / Frames</span>
                    <div className="frames">
                      {frameBtn(first, "首帧", "start")}
                      <span className="ink-accent">→</span>
                      {frameBtn(last, "尾帧", "last")}
                      <span className="frames__note">{frameNote}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {error ? (
            <p className="prompt__error" role="alert">
              {error}
            </p>
          ) : null}

          {job ? (
            <div className="readout">
              <div className="readout__lines">
                <div className="readout__meta">
                  <span className="ink-accent readout__id">Job {shortId(job.id)}</span>
                  <span className={failed ? "ink-accent" : undefined}>{jobStage}</span>
                  <span>{jobClock}</span>
                </div>
                <div className="readout__track">
                  <div className="readout__fill" style={{ width: failed ? "0%" : done ? "100%" : `${job.progress}%` }} />
                </div>
                {failed && job.error ? <span className="readout__err">{job.error.message}</span> : null}
              </div>
              <span className="readout__pct">{jobPct}</span>
            </div>
          ) : null}
        </div>

        <input ref={firstInput} type="file" accept="image/*" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { void pickFrame("start", e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={lastInput} type="file" accept="image/*" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { void pickFrame("last", e.target.files?.[0]); e.target.value = ""; }} />

        <div className="hero__legend">
          <span>Reel speed = progress</span>
          <span>Ink density = status</span>
          {mock ? <span className="ink-accent">Mock · 模拟输出</span> : null}
        </div>
        <div className="hero__mark">
          <RegistrationMark size={26} ink="#C65F38" />
        </div>
      </section>

      {/* ── 2. 成片 ── */}
      {done && job.output ? (
        <section className="output">
          <div className="output__text">
            <SectionRule number="00" title="成片" subtitle="OUTPUT / 01" />
            <p className="output__prompt">{job.prompt || "（无提示词，以素材为准）"}</p>
            <span className="ink-accent mono-12">{resultMeta}</span>
            <a className="link-accent" href={`${job.output.kind === "video" ? job.output.videoUrl : job.output.imageUrl}?download=1`} download>
              下载 / Download ↓
            </a>
          </div>
          <div className="plate-frame">
            {job.output.kind === "video" ? (
              <video src={job.output.videoUrl} poster={job.output.posterUrl} controls playsInline preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={job.output.imageUrl} alt={job.prompt || "生成图像"} />
            )}
          </div>
        </section>
      ) : null}

      {/* ── 3. 三条路径 ── */}
      <section className="paths">
        <SectionRule number="01" title="三条路径" subtitle="THREE PATHS · ONE BOX" />
        <div className="paths__grid">
          {PATHS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="path"
              onClick={() => {
                pickMode(p.id);
                setTray(true);
                scrollTop();
              }}
            >
              <span className="path__index">{p.index}</span>
              <span className="path__title">{p.title}</span>
              <span className="path__desc">{p.desc}</span>
              <span className="path__meta ink-accent">{p.meta}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── 4. 画廊：环形展廊 ── */}
      <section id="gallery" ref={gallery} className="gallery">
        <div className="gallery__sticky">
          <SceneHost
            key={wallKey}
            className="gallery__canvas"
            aria-label="最近成片，拖拽或滚动旋转"
            mount={(c) =>
              mountWall(c, {
                images: ring.map((p) => p.src),
                ink: "#2148B8",
                paper: "#F5F1E8",
                layout: "ring",
                cells: 58,
                radius: ringRadius,
                onSelect: openDetail,
                onHover: setHovered,
              })
            }
            onReady={(h) => {
              wall.current = h;
              h?.setScroll(turn.current);
            }}
            onPointerDown={(e) => {
              dragX.current = e.clientX;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragX.current == null) return;
              const d = (e.clientX - dragX.current) / window.innerWidth;
              dragX.current = e.clientX;
              setDrag((v) => v - d * 0.6);
            }}
            onPointerUp={() => {
              dragX.current = null;
            }}
            onPointerCancel={() => {
              dragX.current = null;
            }}
          />
          <div className="gallery__head">
            <SectionRule number="02" title="最近成片" subtitle="RECENT · DRAG OR SCROLL TO TURN" />
          </div>
          {selPlate ? (
            <div className="gallery__info">
              <span className="ink-accent mono-12 bold">
                Plate {pad2(sel + 1)} / {pad2(ring.length)} · {modeLabel(selPlate.mode)} · {selPlate.mode === "t2i" ? selPlate.quality : `${selPlate.dur}s`}
              </span>
              <p>{selPlate.prompt}</p>
            </div>
          ) : null}
          <div className="gallery__pos">{wallPos}</div>
        </div>
      </section>

      {/* ── 5. 存档 ── */}
      <section id="archive" className="archive">
        <SectionRule number="03" title="存档" subtitle={`${pad2(plates.length)} 部成片 / OUTPUTS${plates[0]?.sample ? " · SAMPLE" : ""}`} />
        <div className="archive__grid">
          {plates.map((p, i) => (
            <button key={p.key} type="button" className="plate" data-on={detail === i} onClick={() => openDetail(i)}>
              <span className="plate__img">
                <span role="img" aria-label={p.prompt} style={{ backgroundImage: `url(${p.src})` }} />
              </span>
              <span className="plate__meta">
                <span className="bold">Plate {pad2(i + 1)}</span>
                <span>
                  {p.mode === "t2i" ? "文生图" : p.mode === "i2v" ? "图生" : "文生"} · {p.mode === "t2i" ? p.quality : `${p.dur}s`}
                </span>
              </span>
              <span className="plate__prompt">{p.prompt}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── 6. 任务详情 ── */}
      {detailPlate ? (
        <section ref={detailEl} className="detail">
          <div className="detail__media">
            <div className="plate-frame plate-frame--ink">
              {detailPlate.videoUrl ? (
                <video src={detailPlate.videoUrl} poster={detailPlate.src} controls playsInline preload="metadata" />
              ) : (
                <span role="img" aria-label={detailPlate.prompt} className="plate-frame__screen" style={{ backgroundImage: `url(${detailPlate.src})` }} />
              )}
            </div>
            <div className="detail__caption mono-12">
              <span className="ink-accent bold">
                Plate {pad2(detail! + 1)} / {pad2(plates.length)}
              </span>
              <span>
                {modeLabel(detailPlate.mode)} · {detailPlate.mode === "t2i" ? detailPlate.quality : `${detailPlate.dur}s · ${detailPlate.quality}`} · {detailPlate.ratio}
              </span>
            </div>
          </div>
          <div className="detail__text">
            <SectionRule number="04" title="任务" subtitle={`JOB ${detailPlate.jobId.replace(/^job_/, "").slice(-6).toUpperCase()}${detailPlate.sample ? " · SAMPLE" : ""}`} />
            <p className="detail__prompt">{detailPlate.prompt}</p>
            <div className="facts">
              {[
                ["路径 / Path", modeLabel(detailPlate.mode)],
                ["模型 / Model", detailPlate.model],
                ["时长 / Length", detailPlate.mode === "t2i" ? `静帧 · ${detailPlate.ratio} · ${detailPlate.quality}` : `${detailPlate.dur}s · ${detailPlate.ratio} · ${detailPlate.quality}`],
                ["音轨 / Audio", detailPlate.mode === "t2i" ? "无 / None" : detailPlate.audio ? "已生成 / Generated" : "未生成 / Off"],
                ["成本 / Cost", `≈ $${(detailPlate.sample ? estimateCostUsd(detailPlate.model, detailPlate.dur) : detailPlate.cost).toFixed(2)} · 以 xAI 账单为准`],
              ].map(([k, v]) => (
                <div key={k} className="facts__row">
                  <span className="facts__key">{k}</span>
                  <span>{v}</span>
                </div>
              ))}
              <div className="facts__end" />
            </div>
            <div className="stages">
              {STAGES.map((s) => (
                <span key={s}>
                  <span className="stages__dot" />
                  {s}
                </span>
              ))}
            </div>
            <div className="detail__actions">
              <button type="button" className="link-accent" onClick={() => reuse(detailPlate)}>
                用这条提示词再生成 / Reuse ↑
              </button>
              <button type="button" className="link-plain" onClick={() => setDetail(null)}>
                关闭 / Close
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── 7. Footer ── */}
      <footer className="foot">
        <RuledDataStrip items={["流光 · Lumen", "Grok Imagine / Native", "Paper #F5F1E8 · Cobalt #2148B8 · Terracotta #C65F38", "2026"]} weight={4} size={13} />
      </footer>

      {authRequired ? <AccessTokenPrompt onAuthorized={() => setAuthRequired(false)} /> : null}
    </div>
  );
}
