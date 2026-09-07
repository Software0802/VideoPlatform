"use client";

import { useEffect, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { formatCny } from "@/lib/billing/prices";
// 六种模式的展示名用共享那份（存的是键名，取文案在这里做）
import { MODE_LABEL, formatElapsed, isActive, isFailed, isTerminal } from "@/lib/client/labels";
import { productNameOf } from "@/lib/client/models";
import { IconBolt } from "@/components/genius/icons";
import { creditsOf, useShell } from "@/components/genius/ShellContext";
import { useT, type Translate } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  创作页（方案 §5）：上部「当前任务」承接旧展览区（阶段 / 百分比 / 分镜 n/m / 成片 /
  失败原因 / 取消 / 重新生成），下方是「最近任务」列表。创作面板在这一页默认展开（Dock）。

  重试的两道闸（方案 §5）：`retryBlocked` 非空时显示它的 message 并**隐藏**「重新生成」
  （上游可能已接单计费，不可重发）；`artifactsPurgedAt` 非空同样禁止重试。
  `ShellContext.retry` 里还有一层同样的守卫。

  服务端直接透传的错误文案（`job.error.message` / `job.retryBlocked.message`）保持原样，
  不在本轮多语言范围内。
*/

const STAGE_LABEL: Record<JobPublic["status"], MessageKey> = {
  queued: "create.stage.queued",
  submitting: "create.stage.submitting",
  pending: "create.stage.pending",
  persisting: "create.stage.persisting",
  directing: "create.stage.directing",
  keyframing: "create.stage.keyframing",
  generating_shots: "create.stage.generating_shots",
  qc: "create.stage.qc",
  stitching: "create.stage.stitching",
  succeeded: "create.stage.succeeded",
  failed: "create.stage.failed",
  expired: "create.stage.expired",
  canceled: "create.stage.canceled",
};

function jobMeta(j: JobPublic, t: Translate): string {
  const image = j.mode === "text_to_image";
  // 产品名（`/api/models` 的对外命名）排在最前；老任务没有这个字段，就还是原来那行
  const product = productNameOf(j);
  const parts = [
    ...(product ? [product] : []),
    MODE_LABEL[j.mode] ? t(MODE_LABEL[j.mode]) : j.mode,
    image ? (j.imageResolution ?? "1k").toUpperCase() : `${j.durationSec}s · ${j.resolution ?? "720p"}`,
    j.aspectRatio ?? "16:9",
  ];
  if (!image) parts.push(j.generateAudio ? t("common.withAudio") : t("common.silent"));
  return parts.join(" · ");
}

/*
  月-日 时:分。刻意**不**走 `toLocaleDateString`：这一段在服务端也渲染（首屏 40 条任务
  由 `(shell)/layout.tsx` 下发），Node 与浏览器的 ICU 输出不保证一模一样，差一个空格就是
  一次水合失配。纯数字格式两种语言下读法相同，也就不需要进字典。
*/
function clockTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CreateView() {
  const { jobs, currentJob, setCurrentJob, busy, cancel, retry } = useShell();
  const t = useT();
  const [now, setNow] = useState<number | null>(null);

  const job = currentJob;
  const active = !!job && isActive(job.status);

  useEffect(() => {
    if (!active) return;
    const t0 = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(timer);
    };
  }, [active]);

  const done = !!job && job.status === "succeeded" && !!job.output;
  const failed = !!job && isFailed(job.status);
  const state: "idle" | "busy" | "done" | "failed" = active ? "busy" : done ? "done" : failed ? "failed" : "idle";
  const pct = job ? Math.round(done ? 100 : job.progress) : 0;
  const shotsDone = job?.shots ? job.shots.filter((s) => s.status === "succeeded").length : 0;
  const stage = !job
    ? t("create.noTask")
    : job.status === "generating_shots" && job.shots
      ? t("create.shots", { done: shotsDone, total: job.shots.length })
      : t(STAGE_LABEL[job.status]);
  const elapsed = job ? formatElapsed(job.createdAt, isTerminal(job.status) ? new Date(job.updatedAt).getTime() : now) : "00:00";
  const purged = !!job?.artifactsPurgedAt;
  const canRetry = !!job && (job.status === "failed" || job.status === "expired") && !job.retryBlocked && !purged;
  const retryLabel = job?.shots?.length ? t("create.retryShots") : t("create.retry");

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
          <span className="task__label">{t("create.currentTask")}</span>
          <span className="task__stage">
            {stage}
            {job ? ` · ${elapsed}` : ""}
          </span>
          {job ? <span className="task__pct">{pct}%</span> : null}
        </div>

        {job ? <div className="task__bar" style={{ width: `${pct}%` }} aria-hidden="true" /> : null}

        {!job ? <p className="task__idle">{t("create.idle")}</p> : null}

        {done && job?.output && !purged ? (
          <div className="task__media">
            {job.output.kind === "video" ? (
              <video key={job.id} src={job.output.videoUrl} poster={job.output.posterUrl} controls playsInline preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={job.id} src={job.output.imageUrl} alt={job.prompt || t("create.imageAlt")} />
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
        {purged ? <p className="task__purged">{t("create.purged")}</p> : null}

        {job ? (
          <div className="task__actions">
            <span className="task__meta">{jobMeta(job, t)}</span>
            {active ? (
              <button type="button" className="task__btn" disabled={busy} onClick={cancel}>
                {t("common.cancel")}
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
                {t("common.download")}
              </a>
            ) : null}
            <button type="button" className="task__btn task__btn--dim" onClick={() => setCurrentJob(null)}>
              {t("common.close")}
            </button>
          </div>
        ) : null}
      </section>

      <section className="recent">
        <h2 className="recent__title">{t("create.recent")}</h2>
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
                    title={j.prompt || t("create.firstFrame")}
                  >
                    <span
                      className="recent__thumb"
                      style={still ? { backgroundImage: `url(${still})` } : undefined}
                      aria-hidden="true"
                    />
                    <span className="recent__body">
                      <span className="recent__prompt">{j.prompt || t("create.firstFrame")}</span>
                      <span className="recent__meta">
                        {t(STAGE_LABEL[j.status])} · {clockTime(j.createdAt)} · {jobMeta(j, t)}
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
          <p className="recent__empty">{t("create.recentEmpty")}</p>
        )}
      </section>
    </div>
  );
}
