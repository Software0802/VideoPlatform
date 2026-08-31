import Link from "next/link";
import { GalleryGrid } from "@/components/studio/GalleryGrid";
import { listJobRecords, toPublic } from "@/lib/jobs/store";

export const dynamic = "force-dynamic";

export default async function GalleryPage() {
  const recs = await listJobRecords();
  const jobs = recs.map(toPublic);
  const done = jobs.filter((j) => j.status === "succeeded" && j.output);
  return (
    <main className="studio-main min-h-screen min-w-0">
      <header className="studio-topbar flex flex-wrap items-center justify-between gap-4 px-6 py-4 lg:px-10">
        <div className="flex items-center gap-4">
          <Link
            href="/studio"
            className="group flex items-center gap-2.5 text-accent/85 transition-colors hover:text-accent-strong"
          >
            <span className="studio-brandmark" aria-hidden="true">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.1">
                <circle cx="8" cy="8" r="5.5" />
                <path d="M4.5 8h7M8 4.5c1.2 1 1.8 2.2 1.8 3.5S9.2 10.5 8 11.5" />
              </svg>
            </span>
            <span className="readout">流光 · Lumen</span>
          </Link>
          <span className="text-faint">/</span>
          <span className="text-sm text-dim">输出画廊</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden font-mono text-[10px] tracking-[0.12em] text-faint sm:inline">存档 / 01</span>
          <Link href="/studio/video" className="btn btn-primary px-4 py-2 text-xs">新建生成</Link>
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-10 lg:px-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="readout text-accent/70">输出画廊</p>
            <h1 className="mt-2 text-[2rem] font-medium tracking-[-0.025em] text-ink lg:text-[2.35rem]">画廊</h1>
            <p className="mt-2 text-sm text-muted">每一帧都来自你的工作台。</p>
          </div>
          <p className="font-mono text-[11px] tracking-[0.14em] text-muted">{done.length.toString().padStart(2, "0")} 部成片</p>
        </div>
        <GalleryGrid jobs={jobs} />
      </div>
    </main>
  );
}
