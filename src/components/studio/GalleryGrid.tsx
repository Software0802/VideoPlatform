"use client";

import Image from "next/image";
import Link from "next/link";
import type { JobPublic } from "@/lib/jobs/schema";

const MODE_BADGE: Record<JobPublic["mode"], string> = {
  text_to_image: "文生图",
  text_to_video: "文生视频",
  image_to_video: "图生",
  reference_to_video: "参考",
  edit_video: "编辑",
  extend_video: "延长",
};

function GalleryCard({ job, compact }: { job: JobPublic; compact: boolean }) {
  const output = job.output;
  if (!output) return null;
  return (
    <Link
      href={`/jobs/${job.id}`}
      className={`gallery-card group block ${compact ? "gallery-card--compact" : ""}`}
    >
      {/* 网格里统一用海报图：视频元素留给详情页，省解码也避免黑帧 */}
      {output.kind === "image" || output.posterUrl ? (
        <div className="relative aspect-video">
          <Image
            src={output.kind === "image" ? output.imageUrl : output.posterUrl}
            alt={job.prompt || "生成结果"}
            fill
            sizes={compact ? "(max-width: 1280px) 50vw, 240px" : "(max-width: 768px) 100vw, 240px"}
            className="object-cover"
            loading="lazy"
            decoding="async"
            unoptimized
          />
        </div>
      ) : (
        <div className="gallery-card__fallback aspect-video" aria-label="视频海报暂不可用">
          <span>视频成片</span>
        </div>
      )}

      {/* 模式徽章 */}
      <span className="absolute left-2.5 top-2.5 rounded-md bg-black/75 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-dim">
        {MODE_BADGE[job.mode]}
      </span>
      {output.kind === "video" ? (
        <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-dim">
          <svg viewBox="0 0 16 16" className="size-2.5 fill-current" aria-hidden="true">
            <path d="M5 3.5v9l7-4.5z" />
          </svg>
          {output.durationSec}s
        </span>
      ) : null}

      {/* 紧凑网格用 hover 浮出提示词；完整画廊在图片下方常驻 */}
      {compact ? (
        <div className="absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-8 opacity-0 transition-all duration-200 ease-expo group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
          <p className="line-clamp-2 text-xs leading-relaxed text-ink">
            {job.prompt || "无提示词"}
          </p>
        </div>
      ) : null}
      {!compact ? (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5">
          <p className="min-w-0 truncate text-xs text-dim">{job.prompt || "无提示词"}</p>
          <span className="flex-none font-mono text-[9px] tracking-[0.12em] text-faint">查看 →</span>
        </div>
      ) : null}
    </Link>
  );
}

export function GalleryGrid({
  jobs,
  compact = false,
}: {
  jobs: JobPublic[];
  compact?: boolean;
}) {
  const done = jobs.filter((j) => j.status === "succeeded" && j.output);
  if (!done.length) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
        <svg
          viewBox="0 0 32 32"
          className="size-9 text-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="16" cy="16" r="12.5" />
          <circle cx="16" cy="16" r="2.2" />
          <circle cx="16" cy="8.2" r="2.6" />
          <circle cx="16" cy="23.8" r="2.6" />
          <circle cx="9.2" cy="12.1" r="2.6" />
          <circle cx="22.8" cy="12.1" r="2.6" />
          <circle cx="9.2" cy="19.9" r="2.6" />
          <circle cx="22.8" cy="19.9" r="2.6" />
        </svg>
        <div className="space-y-1">
          <p className="text-sm text-dim">还没有成片</p>
          <p className="text-xs text-muted">生成完成后会出现在这里</p>
        </div>
        <Link href="/studio/video" className="btn btn-ghost px-4 py-1.5 text-xs">
          去生成 →
        </Link>
      </div>
    );
  }
  if (compact) {
    return (
      <div className="gallery-strip-shell">
        <div className="gallery-strip" aria-label="最近成片">
          {done.map((j) => (
            <GalleryCard key={j.id} job={j} compact />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
    >
      {done.map((j) => (
        <GalleryCard key={j.id} job={j} compact={false} />
      ))}
    </div>
  );
}
