"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { formatCny } from "@/lib/billing/prices";
// 六种模式的展示名用共享那份（存的是键名，取文案在这里做）
import { MODE_LABEL, formatElapsed, isActive, isFailed, isTerminal } from "@/lib/client/labels";
import { productNameOf } from "@/lib/client/models";
import { IconBolt } from "@/components/genius/icons";
import { creditsOf, useJobs } from "@/components/genius/ShellContext";
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
  const { jobs, currentJob, setCurrentJob, busy, cancel, retry, retryPriceCny, reconcile } = useJobs();
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
  /*
    「核验上游」只有一条真通道：`reconcileJob` 判的是 `status === "failed" && error.code ===
    "uncertain_submit"`（`jobs/recovery.ts`），别的情形点下去必然 409。分镜级标记的任务
    job.error.code 是 `needs_review`，也走不了这条路（review 2026-09-15 U-06）。
  */
  const canVerify =
    !!job && job.retryBlocked?.code === "uncertain_submit" && job.status === "failed" &&
    job.error?.code === "uncertain_submit";
  /*
    阻断栏说哪一句：任务还在跑（分镜级标记，其它镜头继续）→ 只讲这一镜；已终态且有核验通道
    → 讲「尚未扣费 + 先核验」；已终态没有通道 → 讲「没扣费、已退回、可以重来」。
    服务端原文不进 DOM：它是运维口径，而这个节点是 `role="alert"`，title 会被读屏当可访问名播。
  */
  const blockedLabel: MessageKey | null = !job?.retryBlocked
    ? null
    : !isTerminal(job.status)
      ? "create.blocked.running"
      : canVerify
        ? "create.blocked.verify"
        : "create.blocked.done";
  const canRetry = !!job && (job.status === "failed" || job.status === "expired") && !job.retryBlocked && !purged;
  /*
    重试涨价确认（review 2026-09-15 B-10）：重试按当下参数重新定价，时长向上归一、换家、
    价表变动都可能让它比原来贵——原来是直接扣，或者被 402 顶回来，全程没有提示。
    服务端第一次拦下 409 并回传新价，按钮就改成「确认重试（¥x）」，再点一次才真的扣。
  */
  const retryLabel = retryPriceCny !== null
    ? t("create.retryConfirm", { price: formatCny(retryPriceCny) })
    : job?.shots?.length
      ? t("create.retryShots")
      : t("create.retry");

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

        {/*
          等待层：任务在跑时占住成片将要出现的那块位置（16:9），用冷光呼吸 + 扫光 + 一条
          跟着百分比走的扫描线说明「模型正在出片」。`--pct` 走内联自定义属性，扫描线的位置
          全交给 CSS，不在 React 里算像素。

          **内部一个文字节点都不能有**：`.task` 是 `aria-live="polite"`，而进度每 500ms 刷一次，
          再往里加文本等于让读屏每半秒重播一遍。属性与内联样式的变化不触发播报，所以这一层
          连同分镜小条一起 `aria-hidden`，状态文字仍由上面的 `.task__stage` / `.task__pct` 承担。
        */}
        {state === "busy" ? (
          <div
            className="task__wait"
            aria-hidden="true"
            data-pct={pct}
            style={{ "--pct": pct } as CSSProperties}
          >
            {job?.shots?.length ? (
              <span className="task__wait-shots">
                {job.shots.map((s, i) => (
                  <i key={`${job.id}-${i}`} data-done={s.status === "succeeded" ? "true" : "false"} />
                ))}
              </span>
            ) : null}
          </div>
        ) : null}

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
        {blockedLabel ? (
          <p className="task__blocked" role="alert">
            {t(blockedLabel)}
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
            {canVerify ? (
              <button type="button" className="task__btn" disabled={busy} onClick={reconcile}>
                {t("create.verify")}
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
                <li
                  key={j.id}
                  className="recent__item"
                  data-status={j.status}
                  /* 非终态的那几条在标题前点一枚呼吸小圆点：列表里一眼看出哪条还在跑 */
                  data-active={isActive(j.status) ? "true" : undefined}
                >
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
