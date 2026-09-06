"use client";

import { useEffect, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { formatCny } from "@/lib/billing/prices";
// 六种模式的中文名用共享那份：本地只列三种时，参考 / 编辑 / 延长会原样露出英文枚举
import { MODE_LABEL, formatElapsed, isActive, isFailed, isTerminal } from "@/lib/client/labels";
import { productNameOf } from "@/lib/client/models";
import { IconBolt } from "@/components/genius/icons";
import { creditsOf, useShell } from "@/components/genius/ShellContext";

/*
  创作页（方案 §5）：上部「当前任务」承接旧展览区（阶段 / 百分比 / 分镜 n/m / 成片 /
  失败原因 / 取消 / 重新生成），下方是「最近任务」列表。创作面板在这一页默认展开（Dock）。

  重试的两道闸（方案 §5）：`retryBlocked` 非空时显示它的 message 并**隐藏**「重新生成」
  （上游可能已接单计费，不可重发）；`artifactsPurgedAt` 非空同样禁止重试。
  `ShellContext.retry` 里还有一层同样的守卫。
*/

const STAGE_LABEL: Record<JobPublic["status"], string> = {
  queued: "排队中",
  submitting: "已提交",
  pending: "生成中",
  persisting: "写入中",
  directing: "分镜",
  keyframing: "锁帧",
  generating_shots: "生成分镜",
  qc: "质检",
  stitching: "拼接",
  succeeded: "完成",
  failed: "失败",
  expired: "已过期",
  canceled: "已取消",
};

function jobMeta(j: JobPublic): string {
  const image = j.mode === "text_to_image";
  // 产品名（`/api/models` 的对外命名）排在最前；老任务没有这个字段，就还是原来那行
  const product = productNameOf(j);
  const parts = [
    ...(product ? [product] : []),
    MODE_LABEL[j.mode] ?? j.mode,
    image ? (j.imageResolution ?? "1k").toUpperCase() : `${j.durationSec}s · ${j.resolution ?? "720p"}`,
    j.aspectRatio ?? "16:9",
  ];
  if (!image) parts.push(j.generateAudio ? "有声" : "无声");
  return parts.join(" · ");
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CreateView() {
  const { jobs, currentJob, setCurrentJob, busy, cancel, retry } = useShell();
  const [now, setNow] = useState<number | null>(null);

  const job = currentJob;
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

  const done = !!job && job.status === "succeeded" && !!job.output;
  const failed = !!job && isFailed(job.status);
  const state: "idle" | "busy" | "done" | "failed" = active ? "busy" : done ? "done" : failed ? "failed" : "idle";
  const pct = job ? Math.round(done ? 100 : job.progress) : 0;
  const shotsDone = job?.shots ? job.shots.filter((s) => s.status === "succeeded").length : 0;
  const stage = !job
    ? "还没有任务"
    : job.status === "generating_shots" && job.shots
      ? `生成分镜 ${shotsDone}/${job.shots.length}`
      : STAGE_LABEL[job.status];
  const elapsed = job ? formatElapsed(job.createdAt, isTerminal(job.status) ? new Date(job.updatedAt).getTime() : now) : "00:00";
  const purged = !!job?.artifactsPurgedAt;
  const canRetry = !!job && (job.status === "failed" || job.status === "expired") && !job.retryBlocked && !purged;
  const retryLabel = job?.shots?.length ? "重做失败分镜" : "重新生成";

  const recent = jobs.slice(0, 12);

  return (
    <div className="create">
      <section
        className="task"
        data-job-id={job?.id ?? ""}
        data-state={state}
        data-status={job?.status ?? ""}
        aria-live="polite"
      >
        <div className="task__head">
          <span className="task__label">当前任务</span>
          <span className="task__stage">
            {stage}
            {job ? ` · ${elapsed}` : ""}
          </span>
          {job ? <span className="task__pct">{pct}%</span> : null}
        </div>

        {job ? <div className="task__bar" style={{ width: `${pct}%` }} aria-hidden="true" /> : null}

        {!job ? <p className="task__idle">写一句提示词，从下面的面板开始创作。</p> : null}

        {done && job?.output && !purged ? (
          <div className="task__media">
            {job.output.kind === "video" ? (
              <video key={job.id} src={job.output.videoUrl} poster={job.output.posterUrl} controls playsInline preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={job.id} src={job.output.imageUrl} alt={job.prompt || "生成图像"} />
            )}
          </div>
        ) : null}

        {job?.error ? (
          <p className="task__err" role="alert">
            {job.error.message}
          </p>
        ) : null}
        {job?.retryBlocked ? (
          <p className="task__blocked" role="alert">
            {job.retryBlocked.message}
          </p>
        ) : null}
        {purged ? <p className="task__purged">作品已过期清理，无法重新生成这一条，请重新提交。</p> : null}

        {job ? (
          <div className="task__actions">
            <span className="task__meta">{jobMeta(job)}</span>
            {active ? (
              <button type="button" className="task__btn" disabled={busy} onClick={cancel}>
                取消
              </button>
            ) : null}
            {canRetry ? (
              <button type="button" className="task__btn" disabled={busy} onClick={retry}>
                {retryLabel}
              </button>
            ) : null}
            {done && job.output && !purged ? (
              <a
                className="task__btn task__btn--light"
                href={`${job.output.kind === "video" ? job.output.videoUrl : job.output.imageUrl}?download=1`}
                download
              >
                下载
              </a>
            ) : null}
            <button type="button" className="task__btn task__btn--dim" onClick={() => setCurrentJob(null)}>
              关闭
            </button>
          </div>
        ) : null}
      </section>

      <section className="recent">
        <h2 className="recent__title">最近任务</h2>
        {recent.length ? (
          <ul className="recent__list">
            {recent.map((j) => {
              const still = j.artifactsPurgedAt
                ? "/lumina/purged.svg"
                : !j.output
                  ? ""
                  : j.output.kind === "image"
                    ? j.output.imageUrl
                    : j.output.posterUrl;
              return (
                <li key={j.id} className="recent__item" data-status={j.status}>
                  <button
                    type="button"
                    className="recent__hit"
                    onClick={() => setCurrentJob(j)}
                    title={j.prompt || "首帧起始"}
                  >
                    <span
                      className="recent__thumb"
                      style={still ? { backgroundImage: `url(${still})` } : undefined}
                      aria-hidden="true"
                    />
                    <span className="recent__body">
                      <span className="recent__prompt">{j.prompt || "首帧起始"}</span>
                      <span className="recent__meta">
                        {STAGE_LABEL[j.status]} · {clockTime(j.createdAt)} · {jobMeta(j)}
                      </span>
                    </span>
                    {j.priceCny > 0 ? (
                      <span className="recent__price" title={formatCny(j.priceCny)}>
                        <IconBolt size={11} />
                        {creditsOf(j.priceCny)}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="recent__empty">还没有任务记录。</p>
        )}
      </section>
    </div>
  );
}
