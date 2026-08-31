import Link from "next/link";
import { JobDetailProgress } from "@/components/shell/JobDetailProgress";
import { readJob, toPublic } from "@/lib/jobs/store";

export const dynamic = "force-dynamic";

const MODE_LABEL: Record<string, string> = {
  text_to_image: "文生图",
  text_to_video: "文生视频",
  image_to_video: "图生视频",
  reference_to_video: "参考生视频",
  edit_video: "编辑视频",
  extend_video: "延长视频",
};

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rec = await readJob(id);
  if (!rec) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg text-dim">任务不存在</p>
        <Link href="/studio" className="btn btn-ghost px-5 py-2 text-sm">
          ← 返回工作室
        </Link>
      </div>
    );
  }
  const pub = toPublic(rec);

  const meta: [string, string][] = [
    ["模式", MODE_LABEL[pub.mode] ?? pub.mode],
    ["模型", pub.model],
    ...(pub.mode !== "text_to_image"
      ? [
          [
            pub.mode === "extend_video" ? "延长段" : pub.mode === "edit_video" ? "源片时长" : "时长",
            `${pub.durationSec}s`,
          ] as [string, string],
        ]
      : []),
    ...(pub.mode === "extend_video" && pub.output?.kind === "video"
      ? [["成片时长", `${pub.output.durationSec}s`] as [string, string]]
      : []),
    ...(pub.aspectRatio ? [["画幅", pub.aspectRatio] as [string, string]] : []),
    ...(pub.resolution ? [["分辨率", pub.resolution] as [string, string]] : []),
    ...(pub.imageResolution
      ? [["图片分辨率", pub.imageResolution.toUpperCase()] as [string, string]]
      : []),
    ["音轨", pub.generateAudio ? "开" : "关"],
    [
      "成本",
      pub.costUsdActual != null
        ? `$${pub.costUsdActual.toFixed(3)} 实际`
        : `$${pub.costUsdEstimate.toFixed(3)} 预估`,
    ],
    ["创建", new Date(pub.createdAt).toLocaleString("zh-CN", { hour12: false })],
  ];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10">
      <header className="space-y-3">
        <Link
          href="/studio"
          className="readout text-accent/85 transition-colors hover:text-accent-strong"
        >
          ← 工作室
        </Link>
        <h1 className="text-balance text-xl font-medium leading-relaxed">
          {pub.prompt || MODE_LABEL[pub.mode] || pub.mode}
        </h1>
      </header>

      <JobDetailProgress initial={pub} />

      {/* 参数读数 */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl border border-line bg-panel p-5 sm:grid-cols-3">
        {meta.map(([k, v]) => (
          <div key={k} className="space-y-1">
            <dt className="readout text-faint">{k}</dt>
            <dd className="truncate font-mono text-[13px] tracking-wide text-dim" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {pub.output ? (
        <div className="flex gap-3">
          <a
            className="btn btn-primary px-6 py-2.5 text-sm"
            href={`${pub.output.kind === "image" ? pub.output.imageUrl : pub.output.videoUrl}?download=1`}
          >
            下载{pub.output.kind === "image" ? "图片" : " mp4"}
          </a>
          <Link href="/gallery" className="btn btn-ghost px-6 py-2.5 text-sm">
            画廊
          </Link>
        </div>
      ) : null}
    </div>
  );
}
