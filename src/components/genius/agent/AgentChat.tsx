"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import { creditsOf } from "@/components/genius/ShellContext";
import type { AgentSessionDetail, AgentSkill, AgentTier } from "@/lib/client/agent";
import type { JobPublic } from "@/lib/jobs/schema";
import { TIER_KEY, statusKey, stillOf } from "./data";
import {
  IconArrowUp,
  IconBolt,
  IconChevronLeft,
  IconPlus,
  IconSkill,
  IconTrash,
  IconX,
} from "./icons";

type Props = {
  session: AgentSessionDetail | null;
  /** 已发出、回复还没到的那句话。用它渲染「思考中」占位，不必先假造一条消息。 */
  pendingText: string | null;
  busy: boolean;
  error: string | null;
  /** 这台实例配了对话提供方吗。`false` = 输入条置灰，历史仍然读得到。 */
  available: boolean;
  skills: AgentSkill[];
  tier: AgentTier;
  imageName: string;
  videoName: string;
  onSend: (text: string) => void;
  onBack: () => void;
  onDelete: () => void;
};

const TABS = ["all", "image", "video"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY = { all: "agent.assetsAll", image: "agent.assetsImage", video: "agent.assetsVideo" } as const;

/**
 * 会话页：左 400 对话栏 + 右侧资产栏。
 *
 * 资产栏就是**本会话创建过的全部任务**（`session.jobs`，服务端按 `jobIds` 投影），
 * 不是另一份列表——它们同时也在主页作品流里，因为它们本来就是普通任务。
 * 轮询在 `AgentView` 里做（那里才知道要不要继续问），这里只负责渲染。
 */
export default function AgentChat(props: Props) {
  const {
    session,
    pendingText,
    busy,
    error,
    available,
    skills,
    tier,
    imageName,
    videoName,
    onSend,
    onBack,
    onDelete,
  } = props;
  const t = useT();
  const { locale } = useI18n();
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const messages = session?.messages ?? [];
  const jobs = useMemo(() => session?.jobs ?? [], [session]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingText]);

  const shown = jobs.filter((j) =>
    tab === "all" ? true : tab === "image" ? j.mode === "text_to_image" : j.mode !== "text_to_image",
  );
  // 选中态是**派生**的，不另存一份：会话被换掉、作品被删掉之后，`picked` 指着一个
  // 不存在的 id 时这里自然算成 null，不需要一个 effect 去「清理」它。
  const preview = picked ? (jobs.find((j) => j.id === picked) ?? null) : null;
  const skillName = (id: string | undefined) =>
    id ? (skills.find((s) => s.id === id)?.name[locale] ?? id) : null;

  const send = () => {
    const text = draft.trim();
    if (!text || busy || !available) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="agent-chat" data-available={available ? "true" : "false"}>
      <div className="agent-chat__left">
        <div className="agent-chat__head">
          <button type="button" className="agent-chat__back" aria-label={t("agent.back")} onClick={onBack}>
            <IconChevronLeft />
          </button>
          <span className="agent-chat__title">{session?.title ?? pendingText ?? t("agent.loading")}</span>
          {session ? (
            <button
              type="button"
              className="agent-chat__back"
              aria-label={t("agent.deleteSession", { title: session.title })}
              onClick={onDelete}
            >
              <IconTrash />
            </button>
          ) : null}
        </div>

        <div className="agent-chat__log" ref={logRef}>
          {messages.map((m) =>
            m.role === "user" ? (
              <span className="agent-chat__bubble" key={m.id}>
                {m.text}
              </span>
            ) : (
              <div className="agent-chat__answer" key={m.id} data-message-id={m.id}>
                <span className="agent-chat__text">{m.text}</span>
                {skillName(m.skillId) ? (
                  <div className="agent-chat__skill-line">
                    {t("agent.usedSkill")}
                    <span className="agent-chat__skill">
                      <IconSkill size={12} />
                      {skillName(m.skillId)}
                    </span>
                  </div>
                ) : null}
                {m.jobs?.length ? (
                  <div className="agent-chat__jobs">
                    {m.jobs.map((ref, i) => {
                      const job = ref.jobId ? jobs.find((j) => j.id === ref.jobId) : undefined;
                      return (
                        <button
                          type="button"
                          key={ref.jobId ?? `${m.id}-${i}`}
                          className="agent-chat__job"
                          data-job-id={ref.jobId}
                          data-kind={ref.kind}
                          disabled={!job}
                          onClick={() => (job ? setPicked(job.id) : undefined)}
                        >
                          <span
                            className="agent-chat__job-shot"
                            style={
                              job && stillOf(job)
                                ? { backgroundImage: `url(${stillOf(job)})` }
                                : undefined
                            }
                          />
                          <span className="agent-chat__job-body">
                            <span className="agent-chat__job-prompt">{ref.prompt}</span>
                            <span className="agent-chat__job-state">
                              {ref.error
                                ? ref.error === "rate_limited"
                                  ? t("agent.jobRateLimited")
                                  : `${t("agent.jobFailed")}：${ref.error}`
                                : job
                                  ? `${t(statusKey(job))}${job.priceCny > 0 ? ` · ⚡${creditsOf(job.priceCny)}` : ""}`
                                  : t("agent.statusQueued")}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {m.priceCny ? (
                  <span className="agent-chat__credits">
                    <IconBolt />
                    {t("agent.credits", { n: creditsOf(m.priceCny) })}
                  </span>
                ) : null}
              </div>
            ),
          )}

          {pendingText ? (
            <>
              <span className="agent-chat__bubble">{pendingText}</span>
              <div className="agent-chat__answer" data-thinking="true">
                <span className="agent-chat__text">{t("agent.thinking")}</span>
              </div>
            </>
          ) : null}

          {available ? null : (
            <p className="agent-chat__error" data-unavailable="true">
              {t("agent.unavailable")}
            </p>
          )}
          {error ? <p className="agent-chat__error">{error}</p> : null}
        </div>

        <div className="agent-chat__composer">
          <input
            className="agent-chat__input"
            value={draft}
            aria-label={t("agent.chatInputLabel")}
            placeholder={available ? t("agent.chatPlaceholder") : t("agent.unavailable")}
            disabled={!available}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="agent-chat__row">
            <button type="button" className="agent-chat__icon" aria-label={t("agent.addAsset")} disabled>
              <IconPlus size={14} />
            </button>
            <span className="agent-chat__tag">{t(TIER_KEY[tier])}</span>
            <span className="agent-chat__tag">{t("agent.imageChip", { name: imageName })}</span>
            <span className="agent-chat__tag">{t("agent.videoChip", { name: videoName })}</span>
            <button
              type="button"
              className="agent-chat__send"
              aria-label={t("agent.send")}
              disabled={busy || !available || !draft.trim()}
              onClick={send}
            >
              <IconArrowUp size={13} />
            </button>
          </div>
        </div>
      </div>

      <div className="agent-chat__right">
        <div className="agent-chat__assets-head">
          <span className="agent-chat__assets-title">{t("agent.assets")}</span>
          <span className="agent-chat__assets-count">{jobs.length}</span>
          <div className="agent-chat__assets-tabs">
            {TABS.map((item) => (
              <button
                type="button"
                key={item}
                className="agent-chat__assets-tab"
                aria-pressed={item === tab}
                data-on={item === tab ? "true" : undefined}
                onClick={() => setTab(item)}
              >
                {t(TAB_KEY[item])}
              </button>
            ))}
          </div>
        </div>

        {preview ? <AssetPreview job={preview} onClose={() => setPicked(null)} /> : null}

        <div className="agent-chat__assets">
          {shown.map((job, i) => {
            const still = stillOf(job);
            return (
              <button
                type="button"
                key={job.id}
                className="agent-asset"
                data-job-id={job.id}
                aria-label={t("agent.assetAria", { n: i + 1 })}
                aria-pressed={job.id === picked}
                data-on={job.id === picked ? "true" : undefined}
                style={still ? { backgroundImage: `url(${still})` } : undefined}
                onClick={() => setPicked(job.id === picked ? null : job.id)}
              >
                <span className="agent-asset__n">{t(statusKey(job))}</span>
              </button>
            );
          })}
        </div>
        {shown.length === 0 ? <p className="agent-chat__assets-empty">{t("agent.assetsEmpty")}</p> : null}
      </div>
    </div>
  );
}

/**
 * 栏内放大预览。图片给 `<img>`，视频给带控件的 `<video>`——资产栏里点开就能看，
 * 不用跳去创作页；成片地址就是任务自己的 `/api/media/...`（会话不另开一条媒体路径）。
 */
function AssetPreview({ job, onClose }: { job: JobPublic; onClose: () => void }) {
  const t = useT();
  const out = job.output;
  return (
    <div className="agent-chat__preview" data-job-id={job.id}>
      <button type="button" className="agent-chat__preview-close" aria-label={t("agent.closePreview")} onClick={onClose}>
        <IconX />
      </button>
      {job.artifactsPurgedAt || !out ? (
        <p className="agent-chat__preview-note">{t(statusKey(job))}</p>
      ) : out.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="agent-chat__preview-media" src={out.imageUrl} alt={job.prompt} />
      ) : (
        <video className="agent-chat__preview-media" src={out.videoUrl} poster={out.posterUrl} controls />
      )}
      <p className="agent-chat__preview-prompt">{job.prompt}</p>
    </div>
  );
}
