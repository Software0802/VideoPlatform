"use client";

import { useMemo, useRef, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import type { NativeMode } from "@/lib/providers/types";
import { estimateCostUsd } from "@/lib/cost";
import {
  isImageMode,
  modelForMode,
  PRESET_VOICES,
} from "@/lib/providers/grok/mode-matrix";
import { DurationPicker } from "./DurationPicker";

const MODES: { id: NativeMode; label: string; hint: string }[] = [
  { id: "text_to_image", label: "文生图", hint: "一张静帧，立刻出" },
  { id: "text_to_video", label: "文生视频", hint: "只写提示词" },
  { id: "image_to_video", label: "图生视频（首帧）", hint: "首帧图 = 起始画面" },
  { id: "reference_to_video", label: "参考生视频", hint: "最多 7 张参考，不锁第一帧" },
  { id: "edit_video", label: "编辑视频", hint: "改已有片子 · 源片 ≤ 8.7s" },
  { id: "extend_video", label: "延长视频", hint: "从末帧接着演 · 延长 2–10s" },
];

type UploadResult = {
  uploadId: string;
  durationSec: number | null;
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="readout text-muted">{children}</span>;
}

export function GenerateForm({
  onCreated,
  onUnauthorized,
  initialMode = "text_to_video",
  initialPrompt = "",
  initialGenerateAudio,
}: {
  onCreated: (job: JobPublic) => void;
  onUnauthorized?: () => void;
  initialMode?: NativeMode;
  initialPrompt?: string;
  initialGenerateAudio?: boolean;
}) {
  const [mode, setMode] = useState<NativeMode>(initialMode);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [durationSec, setDurationSec] = useState(8);
  const [extendSec, setExtendSec] = useState(6);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("720p");
  const [imageResolution, setImageResolution] = useState<"1k" | "2k">("1k");
  const [generateAudio, setGenerateAudio] = useState(
    initialGenerateAudio ?? initialMode !== "text_to_image",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startId, setStartId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [refIds, setRefIds] = useState<string[]>([]);
  const [voiceIds, setVoiceIds] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceDurationSec, setSourceDurationSec] = useState<number | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  const model = modelForMode(mode);
  const image = isImageMode(mode);
  const billDuration =
    mode === "extend_video"
      ? extendSec
      : mode === "edit_video"
        ? sourceDurationSec ?? 8
        : durationSec;
  const estimate = useMemo(() => estimateCostUsd(model, billDuration), [model, billDuration]);

  function changeMode(next: NativeMode) {
    setMode(next);
    setError(null);
    if (next === "text_to_image") {
      setGenerateAudio(false);
    } else if (mode === "text_to_image") {
      // Restore the documented video default when leaving the image mode.
      setGenerateAudio(true);
    }
    // R2V 不接受 1080p；切换模式时把之前的合法值收回到最高档，
    // 避免一个不可选的值继续留在表单状态里。
    if (next === "reference_to_video" && resolution === "1080p") {
      setResolution("720p");
    }
  }

  async function upload(file: File, role: string): Promise<UploadResult> {
    const fd = new FormData();
    fd.set("role", role);
    fd.set("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body: fd });
    const data = await res.json();
    if (res.status === 401) onUnauthorized?.();
    if (!res.ok) throw new Error(data.error?.message ?? "上传失败");
    return {
      uploadId: data.uploadId as string,
      durationSec: typeof data.durationSec === "number" ? data.durationSec : null,
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode !== "image_to_video" && !prompt.trim()) {
        throw new Error("该模式需要提示词");
      }
      if (mode === "image_to_video" && !startId) {
        throw new Error("图生视频需要先上传首帧图");
      }
      if (mode === "reference_to_video" && !refIds.length && !voiceIds.length) {
        throw new Error("参考生视频至少需要一张参考图或一个音色");
      }
      if ((mode === "edit_video" || mode === "extend_video") && !sourceId) {
        throw new Error("该模式需要先上传源视频");
      }
      // Keep the key for a retry after a transient network failure. The
      // server can then replay the original job instead of charging twice.
      idempotencyKey.current ??=
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const body: Record<string, unknown> = {
        mode,
        prompt,
      };
      if (image) {
        body.aspectRatio = aspectRatio;
        body.imageResolution = imageResolution;
      } else if (mode === "text_to_video" || mode === "image_to_video" || mode === "reference_to_video") {
        body.durationSec = durationSec;
        body.aspectRatio = aspectRatio;
        body.resolution = resolution;
        body.generateAudio = generateAudio;
      }
      if (mode === "extend_video") body.durationSec = extendSec;
      // 只提交当前模式允许的资产。用户在填写过程中切换模式时，
      // 隐藏字段仍可能保留本地状态，不能让它们污染下一次请求。
      if (mode === "image_to_video" && startId) body.startUploadId = startId;
      if (mode !== "text_to_image" && lastId) body.lastUploadId = lastId;
      if (mode === "reference_to_video") {
        if (refIds.length) body.referenceUploadIds = refIds;
        if (voiceIds.length) body.voiceIds = voiceIds;
      }
      if ((mode === "edit_video" || mode === "extend_video") && sourceId) {
        body.sourceVideoUploadId = sourceId;
      }
      if (idempotencyKey.current) body.idempotencyKey = idempotencyKey.current;
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 401) onUnauthorized?.();
      if (!res.ok) throw new Error(data.error?.message ?? "创建失败");
      onCreated(data);
      idempotencyKey.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const showDuration = mode === "text_to_video" || mode === "image_to_video" || mode === "reference_to_video";
  const showExtend = mode === "extend_video";
  const showAspect = showDuration || image;
  const showVideoRes = showDuration;
  const showStart = mode === "image_to_video";
  const showRefs = mode === "reference_to_video";
  const showSource = mode === "edit_video" || mode === "extend_video";
  const showAudio = showDuration;
  const showLast = !image;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-7">
      {/* 模式 */}
      <div className="space-y-2.5">
        <div className="flex items-end justify-between gap-4">
          <FieldLabel>生成路径</FieldLabel>
          <span className="font-mono text-[10px] tracking-[0.12em] text-faint">{MODES.length.toString().padStart(2, "0")} MODES</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => changeMode(m.id)}
                aria-pressed={active}
                data-active={active}
                className="mode-card group px-3.5 py-3"
                onPointerMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
                  event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
                }}
              >
                <span
                  className={`block text-[13px] font-medium ${
                    active ? "text-accent-strong" : "text-ink"
                  }`}
                >
                  {m.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                  {m.hint}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 提示词 */}
      <label className="block space-y-2.5">
        <div className="flex items-end justify-between gap-4">
          <FieldLabel>提示词</FieldLabel>
          <span className="font-mono text-[10px] tabular-nums tracking-[0.1em] text-faint">{prompt.length.toString().padStart(3, "0")} / 2000</span>
        </div>
        <div className="prompt-panel">
          <textarea
            required={mode !== "image_to_video"}
            aria-describedby="prompt-help"
            value={prompt}
            maxLength={2000}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="雨夜的外滩，一位穿深青色风衣的女人走向江边…"
            className="w-full resize-y px-4 py-4 text-[15px] leading-7 text-ink outline-none placeholder:text-muted"
          />
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
            <span id="prompt-help" className="text-xs text-faint">{mode === "image_to_video" ? "提示词可选，首帧图将作为起始画面" : "描述主体、光线、镜头与节奏"}</span>
            <span className="font-mono text-[10px] tracking-[0.1em] text-muted">MAX 2000 CHARS</span>
          </div>
        </div>
      </label>

      {showDuration ? (
        <div className="space-y-2.5">
          <FieldLabel>成片时长（秒）</FieldLabel>
          <DurationPicker value={durationSec} onChange={setDurationSec} />
        </div>
      ) : null}
      {showExtend ? (
        <div className="space-y-2.5">
          <FieldLabel>延长 2–10 秒（加在原片之后），不是成片总时长</FieldLabel>
          <DurationPicker
            value={extendSec}
            onChange={setExtendSec}
            native={Array.from({ length: 9 }, (_, index) => index + 2)}
            showLater={false}
          />
        </div>
      ) : null}

      {showAspect ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-2.5">
            <FieldLabel>画幅</FieldLabel>
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value)}
              className="field select px-3.5 py-2.5 text-sm"
            >
              {["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          {showVideoRes ? (
            <label className="space-y-2.5">
              <FieldLabel>分辨率</FieldLabel>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="field select px-3.5 py-2.5 text-sm"
              >
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p" disabled={mode === "reference_to_video"}>
                  {mode === "reference_to_video" ? "1080p（不可用）" : "1080p"}
                </option>
              </select>
            </label>
          ) : (
            <label className="space-y-2.5">
              <FieldLabel>分辨率</FieldLabel>
              <select
                value={imageResolution}
                onChange={(e) => setImageResolution(e.target.value as "1k" | "2k")}
                className="field select px-3.5 py-2.5 text-sm"
              >
                <option value="1k">1K</option>
                <option value="2k">2K</option>
              </select>
            </label>
          )}
        </div>
      ) : null}

      {showStart ? (
        <FileField
          label="首帧（作为起始画面）"
          accept="image/*"
          onFile={async (f) => {
            const uploaded = await upload(f, "start");
            setStartId(uploaded.uploadId);
          }}
          done={Boolean(startId)}
        />
      ) : null}

      {showRefs ? (
        <>
          <FileField
            label="参考图（最多 7 张）"
            accept="image/*"
            multiple
           onFiles={async (files) => {
              if (files.length > 7) throw new Error("参考图最多 7 张");
              const ids: string[] = [];
              for (const f of files) {
                ids.push((await upload(f, "reference")).uploadId);
              }
              setRefIds(ids);
            }}
            done={refIds.length > 0}
          />
          <fieldset className="space-y-2.5">
            <legend>
              <FieldLabel>参考音色（最多 3 个，preset voice_id）</FieldLabel>
            </legend>
            <div className="voice-picker" role="group" aria-label="参考音色">
              {PRESET_VOICES.map((voice) => {
                const selected = voiceIds.includes(voice);
                return (
                  <button
                    key={voice}
                    type="button"
                    className="voice-option"
                    data-selected={selected}
                    aria-pressed={selected}
                    onClick={() => {
                      setVoiceIds((current) => {
                        if (current.includes(voice)) return current.filter((id) => id !== voice);
                        if (current.length >= 3) return current;
                        return [...current, voice];
                      });
                    }}
                  >
                    <span aria-hidden="true">◉</span>
                    {voice}
                  </button>
                );
              })}
            </div>
            <p className="text-xs leading-relaxed text-muted">
              可选 preset voice_id；参考图与音色至少选择一种。
            </p>
          </fieldset>
        </>
      ) : null}

      {showSource ? (
        <>
          <FileField
            label={mode === "edit_video" ? "源视频 mp4（≤ 8.7 秒）" : "源视频 mp4（2–15 秒）"}
            accept="video/mp4"
            onFile={async (f) => {
              const uploaded = await upload(f, "source_video");
              setSourceId(uploaded.uploadId);
              setSourceDurationSec(uploaded.durationSec);
            }}
            done={Boolean(sourceId)}
          />
          {mode === "edit_video" ? (
            <p className="text-xs leading-relaxed text-muted">
              {sourceDurationSec != null
                ? `源片 ${sourceDurationSec.toFixed(1)} 秒。输出时长与画幅沿用源片，分辨率封顶 720p。`
                : "上传后显示源片时长。输出时长与画幅沿用源片，分辨率封顶 720p。"}
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              {sourceDurationSec != null
                ? `成片约 ${(sourceDurationSec + extendSec).toFixed(1)} 秒（源片 ${sourceDurationSec.toFixed(1)} 秒 + 延长段 ${extendSec} 秒）`
                : "延长段会加在原片之后，不是成片总时长。"}
            </p>
          )}
        </>
      ) : null}

      {showLast ? (
        <>
          <FileField
            label="尾帧（仅保存，用于后续长视频一致性）"
            accept="image/*"
            onFile={async (f) => {
              const uploaded = await upload(f, "last");
              setLastId(uploaded.uploadId);
            }}
            done={Boolean(lastId)}
          />
          <p className="text-xs leading-relaxed text-muted">
            Grok 目前不能锁定结束帧。上传后不会让成片停在这张图上。
          </p>
        </>
      ) : null}

      {showAudio ? (
        <div className="flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-3">
          <span className="text-sm text-dim">生成音轨</span>
          <button
            type="button"
            role="switch"
            aria-checked={generateAudio}
            aria-label="生成音轨"
            className="switch"
            onClick={() => setGenerateAudio((v) => !v)}
          >
            <span className="sr-only">{generateAudio ? "开" : "关"}</span>
          </button>
        </div>
      ) : null}

      {/* 提交行 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
        <p className="font-mono text-[11px] tracking-[0.08em] text-muted">
          约 <span className="text-accent">${estimate.toFixed(2)}</span>
          <span className="ml-1 text-faint">（以 xAI 账单为准）</span>
          <span className="mx-2 text-faint">·</span>
          {model}
        </p>
        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary min-w-[112px] px-7 py-3 text-sm"
        >
          {busy ? "提交中…" : "生成"}
        </button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

function FileField({
  label,
  accept,
  multiple,
  onFile,
  onFiles,
  done,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  onFile?: (f: File) => Promise<void>;
  onFiles?: (f: File[]) => Promise<void>;
  done?: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "ready" | "error">("idle");
  const [names, setNames] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  async function handle(list: File[]) {
    if (!list.length) return;
    setState("busy");
    try {
      if (onFiles) await onFiles(list);
      else if (onFile) await onFile(list[0]);
      setNames(list.map((f) => f.name));
      setState("ready");
    } catch (err) {
      setState("error");
      setNames([err instanceof Error ? err.message : "上传失败"]);
    }
  }

  return (
    <div className="space-y-2.5">
      <FieldLabel>{label}</FieldLabel>
      <label
        className="dropzone"
        data-done={done && state === "ready"}
        data-dragging={dragging}
        aria-busy={state === "busy"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handle([...e.dataTransfer.files]);
        }}
      >
        <input
          type="file"
          accept={accept}
          multiple={multiple}
          aria-label={label}
          onChange={(e) => void handle([...(e.target.files ?? [])])}
        />
        <svg
          viewBox="0 0 16 16"
          className="size-4 flex-none text-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 10.5V3.5M5 6l3-3 3 3" />
          <path d="M2.5 10.5v2a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-[13px]" aria-live="polite">
          {state === "busy"
            ? "上传中…"
            : names.length > 0
              ? names.join("、")
              : "点击选择，或拖入文件"}
        </span>
        {state === "ready" && done ? (
          <span className="flex-none font-mono text-[10px] uppercase tracking-[0.14em] text-ok">
            就绪 ✓
          </span>
        ) : null}
        {state === "error" ? (
          <span role="alert" className="flex-none font-mono text-[10px] uppercase tracking-[0.14em] text-danger">
            失败
          </span>
        ) : null}
      </label>
    </div>
  );
}
