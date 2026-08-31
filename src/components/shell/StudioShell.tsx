"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { GenerateForm } from "@/components/studio/GenerateForm";
import { JobProgress } from "@/components/studio/JobProgress";
import { LiveMockBanner } from "@/components/studio/LiveMockBanner";
import { GalleryGrid } from "@/components/studio/GalleryGrid";
import { AccessTokenPrompt } from "@/components/shell/AccessTokenPrompt";
import { HealthStatus } from "@/components/shell/HealthStatus";
import {
  defaultsForKind,
  kindTitle,
  type StudioKind,
} from "@/lib/studio-kind";
import type { SceneProgress } from "@/types/scene";

const SceneHost = dynamic(
  () => import("@/components/scene/SceneHost").then((m) => m.SceneHost),
  {
    ssr: false,
    loading: () => <div className="absolute inset-0 bg-bg" aria-hidden="true" />,
  },
);

const KIND_TAB: Record<StudioKind, string> = {
  image: "图像",
  video: "视频",
  audio: "音频",
};

// 音频工作室尚未有对应的 provider/mode。保留类型兼容性，但不要把
// 一个实际会提交视频任务的入口暴露给用户。
const AVAILABLE_KINDS = ["image", "video"] as const satisfies readonly StudioKind[];

const PHASE_LABEL: Record<SceneProgress["phase"], string> = {
  idle: "待机",
  working: "渲染中",
  done: "已完成",
  error: "失败",
};

export function StudioShell({
  kind,
  initialPrompt = "",
  mock,
  upstream = mock ? "mock" : "xai",
  mockReason = "missing-key",
  initialJobs,
}: {
  kind: StudioKind;
  initialPrompt?: string;
  mock: boolean;
  upstream?: "mock" | "xai" | "sub2api";
  mockReason?: "missing-key" | "forced";
  initialJobs: JobPublic[];
}) {
  const seed = defaultsForKind(kind);
  const [jobs, setJobs] = useState(initialJobs);
  const [current, setCurrent] = useState<JobPublic | null>(initialJobs[0] ?? null);
  const [authRequired, setAuthRequired] = useState(false);
  const handleUnauthorized = useCallback(() => setAuthRequired(true), []);

  const upsert = useCallback((job: JobPublic) => {
    setCurrent(job);
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
  }, []);

  const progress: SceneProgress = useMemo(() => {
    if (!current) return { phase: "idle", progress: 0 };
    if (current.status === "succeeded") return { phase: "done", progress: 100 };
    if (["failed", "expired", "canceled"].includes(current.status)) {
      return { phase: "error", progress: current.progress };
    }
    return { phase: "working", progress: current.progress };
  }, [current]);

  return (
    <div className="studio-shell flex min-h-screen flex-col lg:flex-row">
      {/* ── 场景栏：放映机 ─────────────────────────────── */}
      <aside
        data-scene-slot
        className="grain relative min-h-[300px] overflow-hidden bg-bg lg:sticky lg:top-0 lg:h-screen lg:w-[40%] lg:min-w-[400px]"
      >
        <SceneHost progress={progress} />

        {/* 扫描线 */}
        <div
          className="pointer-events-none absolute inset-0 z-[2] opacity-25 mix-blend-overlay"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, oklch(1 0 0 / 4%) 3px)",
          }}
          aria-hidden="true"
        />
        {/* 暗角 */}
        <div
          className="pointer-events-none absolute inset-0 z-[2]"
          style={{
            background:
              "radial-gradient(115% 90% at 50% 45%, transparent 55%, oklch(0.08 0.004 80 / 68%) 100%)",
          }}
          aria-hidden="true"
        />

        <div className="absolute left-6 top-6 z-[3]">
          <Link
            href="/"
            className="group flex items-center gap-2.5 text-accent/85 transition-colors hover:text-accent-strong"
          >
            <span className="studio-brandmark" aria-hidden="true">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.1">
                <circle cx="8" cy="8" r="5.5" />
                <path d="M4.5 8h7M8 4.5c1.2 1 1.8 2.2 1.8 3.5S9.2 10.5 8 11.5" />
              </svg>
            </span>
            <span className="readout transition-transform duration-200 ease-expo group-hover:translate-x-0.5">
              流光 · Lumen
            </span>
          </Link>
        </div>

        <div className="pointer-events-none absolute right-6 top-7 z-[3] hidden text-right sm:block">
          <p className="readout text-[9px] text-faint">私人放映厅</p>
          <p className="mt-1 font-mono text-[10px] tracking-[0.16em] text-muted">NODE / 01</p>
        </div>

        {/* 放映机读数屏 */}
        <div className="absolute inset-x-6 bottom-6 z-[3] flex items-end justify-between gap-4">
          <div className="space-y-1.5">
            <p className="readout text-faint">状态</p>
            <p className="flex items-center gap-2 font-mono text-sm tracking-[0.12em] text-dim">
              <span
                className={`inline-block size-1.5 rounded-full ${
                  progress.phase === "working"
                    ? "animate-pulse-dot bg-accent"
                    : progress.phase === "done"
                      ? "bg-ok"
                      : progress.phase === "error"
                        ? "bg-danger"
                        : "bg-muted"
                }`}
              />
              {PHASE_LABEL[progress.phase]}
              {progress.phase === "working" ? (
                <span className="text-accent">{progress.progress}%</span>
              ) : null}
            </p>
          </div>
          <p className="readout text-right text-faint">
            {kindTitle(kind)}
          </p>
        </div>
      </aside>

      {/* ── 主区 ───────────────────────────────────────── */}
      <main className="studio-main relative z-10 min-w-0 flex-1 border-t border-line lg:border-l lg:border-t-0">
        <header className="studio-topbar flex flex-wrap items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            {/* 工作室切换 */}
            <nav
              className="flex items-center gap-1 rounded-full border border-line bg-panel/80 p-1 shadow-[0_8px_24px_-18px_oklch(0_0_0/90%)]"
              aria-label="工作室"
            >
              {AVAILABLE_KINDS.map((k) => (
                <Link
                  key={k}
                  href={`/studio/${k}`}
                  aria-current={k === kind ? "page" : undefined}
                  className={`flex min-h-11 items-center rounded-full px-3.5 py-2 text-[13px] transition-all duration-150 ${
                    k === kind
                      ? "bg-accent font-medium text-accent-ink shadow-[0_4px_14px_-8px_oklch(0.79_0.105_78/80%)]"
                      : "text-muted hover:bg-raise hover:text-ink"
                  }`}
                >
                  {KIND_TAB[k]}
                </Link>
              ))}
            </nav>
            <p className="hidden truncate text-xs text-muted md:block">
              Grok Imagine <span className="text-faint">/</span> 原生能力
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/gallery"
              className="flex min-h-11 items-center px-2 text-xs text-muted transition-colors hover:text-accent"
            >
              画廊
            </Link>
            <HealthStatus onUnauthorized={handleUnauthorized} />
            <span className="hidden font-mono text-[10px] tracking-[0.12em] text-faint xl:inline">会话 / 01</span>
            <LiveMockBanner mock={mock} upstream={upstream} mockReason={mockReason} />
          </div>
        </header>

        <div className="px-6 pb-12 lg:px-8">
          <section className="studio-intro animate-reveal" aria-labelledby="studio-heading">
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div className="max-w-xl">
                <p className="readout mb-3 text-accent/75">{kindTitle(kind)} / 控制台</p>
                <h1 id="studio-heading" className="text-[2rem] font-medium leading-tight text-ink lg:text-[2.35rem]">
                  让画面开始转动
                </h1>
                <p className="mt-3 max-w-[54ch] text-sm leading-7 text-muted">
                  写下你想看到的镜头，选择一条生成路径。每一次提交都会留下可回看的片格。
                </p>
              </div>
              <p className="max-w-[24ch] text-right text-xs leading-6 text-faint">
                参数一屏可达，状态实时回传。<br />画面完成后自动进入画廊。
              </p>
            </div>
          </section>

          <div className="grid gap-10 pt-8 xl:grid-cols-[minmax(0,1.06fr)_minmax(340px,0.94fr)]">
          <section aria-label="生成参数" className="animate-reveal" style={{ animationDelay: "70ms" }}>
            <GenerateForm
              key={kind}
              onCreated={upsert}
              onUnauthorized={handleUnauthorized}
              initialMode={seed.mode}
              initialPrompt={initialPrompt}
              initialGenerateAudio={seed.generateAudio}
            />
          </section>
          <div className="space-y-8 xl:sticky xl:top-6 xl:self-start">
            {current ? (
              <section aria-label="当前任务" className="animate-reveal [animation-delay:120ms]">
                <JobProgress
                  key={current.id}
                  initial={current}
                  onUpdate={upsert}
                  onUnauthorized={handleUnauthorized}
                  onRetried={upsert}
                />
              </section>
            ) : null}
            <section aria-label="画廊" className="animate-reveal [animation-delay:180ms]">
              <div className="mb-4 flex items-baseline justify-between">
                <div>
                  <p className="readout text-accent/65">输出画廊</p>
                  <h2 className="mt-1 text-lg font-medium text-ink">最近成片</h2>
                </div>
                <Link
                  href="/gallery"
                  className="text-xs text-muted transition-colors hover:text-accent"
                >
                  查看全部 →
                </Link>
              </div>
              <GalleryGrid jobs={jobs} compact />
            </section>
          </div>
        </div>
        </div>
      </main>
      {authRequired ? <AccessTokenPrompt onAuthorized={() => setAuthRequired(false)} /> : null}
    </div>
  );
}
