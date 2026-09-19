"use client";

import { useCallback, useEffect, useRef } from "react";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import { creditsOf } from "@/components/genius/ShellContext";
import { AGENT_TIERS, type AgentChatModel, type AgentSkill, type AgentTier } from "@/lib/client/agent";
import { productDescription, productLabel, type Product } from "@/lib/client/models";
import { TIER_KEY, iconGrad, shot } from "./data";
import { IconChevronDown, IconChevronRight, IconList, IconSkill } from "./icons";

export type PickerPop = null | "text" | "img" | "vid" | "skill";

type Props = {
  pop: PickerPop;
  onPop: (v: PickerPop) => void;
  /** 对话模型白名单（`GET /api/agent/skills` 的 `chat`）；空表 = 芯片仍渲染但不展开模型组。 */
  chatModels: AgentChatModel[];
  chatDefault?: string;
  /** `null` = 用服务端默认那条。 */
  chatModel: string | null;
  onChatModel: (v: string) => void;
  tier: AgentTier;
  onTier: (v: AgentTier) => void;
  /** `null` = 自动（由服务端按当前配置路由）。 */
  imageProduct: string | null;
  onImageProduct: (v: string | null) => void;
  videoProduct: string | null;
  onVideoProduct: (v: string | null) => void;
  products: Product[];
  skills: AgentSkill[];
  skillHover: number;
  onSkillHover: (v: number) => void;
  activeSkill: string | null;
  onActiveSkill: (v: string | null) => void;
  onManageSkills: () => void;
};

/**
 * 输入行的四枚芯片：对话模型（含创意档）、图片产品、视频产品、技能。
 * AgentAsk 与 AgentChat 共用——切换都在下一轮生效，不改已经落盘的对话。
 * 对话模型芯片显示真名（白名单里的 `name`），不再有锁与「自动 ·」前缀。
 */
export default function AgentPickers(props: Props) {
  const {
    pop,
    onPop,
    chatModels,
    chatDefault,
    chatModel,
    onChatModel,
    tier,
    onTier,
    imageProduct,
    onImageProduct,
    videoProduct,
    onVideoProduct,
    products,
    skills,
    skillHover,
    onSkillHover,
    activeSkill,
    onActiveSkill,
    onManageSkills,
  } = props;

  const t = useT();
  const { locale } = useI18n();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => onPop(null), [onPop]);

  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => {
      const el = rowRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pop, close]);

  const toggle = (which: Exclude<PickerPop, null>) => onPop(pop === which ? null : which);
  const images = products.filter((p) => p.kind === "image");
  const videos = products.filter((p) => p.kind === "video");
  const nameOf = (id: string | null, pool: Product[]) =>
    (id ? pool.find((p) => p.id === id)?.name : undefined) ?? t("agent.auto");

  const currentChat = chatModel ?? chatDefault ?? chatModels[0]?.id;
  const chatName = chatModels.find((m) => m.id === currentChat)?.name ?? currentChat ?? t("agent.auto");

  const skillList = skills.slice(0, 10);
  const preview = skillList[skillHover] ?? skillList[0];
  const active = skills.find((s) => s.id === activeSkill) ?? null;

  const productRows = (pool: Product[], current: string | null, pick: (id: string | null) => void) => (
    <>
      <button
        type="button"
        role="menuitem"
        className="agent-pop__item"
        data-current={current === null ? "true" : undefined}
        onClick={() => {
          pick(null);
          close();
        }}
      >
        <span className="agent-pop__icon" style={{ background: iconGrad(0) }} />
        <span className="agent-pop__body">
          <span className="agent-pop__name">{t("agent.auto")}</span>
          <span className="agent-pop__desc">{t("agent.autoDesc", { n: pool.length })}</span>
        </span>
        <span className="agent-pop__auto">{t("agent.auto")}</span>
      </button>
      {pool.map((p, i) => (
        <button
          type="button"
          role="menuitem"
          key={p.id}
          className="agent-pop__item"
          data-product-id={p.id}
          data-current={p.id === current ? "true" : undefined}
          onClick={() => {
            pick(p.id);
            close();
          }}
        >
          <span className="agent-pop__icon" style={{ background: iconGrad(i + 1) }} />
          <span className="agent-pop__body">
            <span className="agent-pop__name">{productLabel(p, t)}</span>
            <span className="agent-pop__desc">{productDescription(p, t)}</span>
          </span>
          <span className="agent-pop__auto">
            {t("agent.creditsEach", { n: creditsOf(p.samplePriceCny) })}
          </span>
        </button>
      ))}
    </>
  );

  return (
    <div className="agent-pickers" ref={rowRef}>
      <div className="agent-ask__slot">
        <button
          type="button"
          className="agent-chip"
          data-open={pop === "text" ? "true" : undefined}
          aria-expanded={pop === "text"}
          aria-haspopup="menu"
          onClick={() => toggle("text")}
        >
          {chatName}
          <IconChevronDown />
        </button>
        {pop === "text" ? (
          <div className="agent-pop agent-pop--text" role="menu">
            {chatModels.length > 1 ? (
              <>
                <span className="agent-pop__group">{t("agent.chatModelGroup")}</span>
                {chatModels.map((m) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={m.id}
                    className="agent-pop__item"
                    data-chat-model={m.id}
                    data-current={m.id === currentChat ? "true" : undefined}
                    onClick={() => {
                      onChatModel(m.id);
                      close();
                    }}
                  >
                    <span className="agent-pop__body">
                      <span className="agent-pop__name">{m.name}</span>
                      <span className="agent-pop__desc">{m.id}</span>
                    </span>
                    <span className="agent-pop__auto">
                      {t("agent.turnCredits", { n: creditsOf(m.turnCny) })}
                    </span>
                  </button>
                ))}
              </>
            ) : null}
            <span className="agent-pop__group">{t("agent.tierGroup")}</span>
            {AGENT_TIERS.map((item) => (
              <button
                type="button"
                key={item}
                role="menuitem"
                className="agent-pop__plain"
                data-tier={item}
                data-current={item === tier ? "true" : undefined}
                onClick={() => {
                  onTier(item);
                  close();
                }}
              >
                <span className="agent-pop__dot" />
                {t(TIER_KEY[item])}
              </button>
            ))}
            <p className="agent-pop__hint">{t("agent.tierHint")}</p>
          </div>
        ) : null}
      </div>

      <div className="agent-ask__slot">
        <button
          type="button"
          className="agent-chip"
          data-open={pop === "img" ? "true" : undefined}
          aria-expanded={pop === "img"}
          aria-haspopup="menu"
          onClick={() => toggle("img")}
        >
          {t("agent.imageChip", { name: nameOf(imageProduct, images) })}
          <IconChevronDown />
        </button>
        {pop === "img" ? (
          <div className="agent-pop agent-pop--img" role="menu">
            {productRows(images, imageProduct, onImageProduct)}
          </div>
        ) : null}
      </div>

      <div className="agent-ask__slot">
        <button
          type="button"
          className="agent-chip"
          data-open={pop === "vid" ? "true" : undefined}
          aria-expanded={pop === "vid"}
          aria-haspopup="menu"
          onClick={() => toggle("vid")}
        >
          {t("agent.videoChip", { name: nameOf(videoProduct, videos) })}
          <IconChevronDown />
        </button>
        {pop === "vid" ? (
          <div className="agent-pop agent-pop--vid" role="menu">
            {productRows(videos, videoProduct, onVideoProduct)}
          </div>
        ) : null}
      </div>

      <div className="agent-ask__slot">
        <button
          type="button"
          className="agent-chip"
          data-open={pop === "skill" ? "true" : undefined}
          aria-expanded={pop === "skill"}
          aria-haspopup="menu"
          onClick={() => toggle("skill")}
        >
          {t("agent.skill")}
          <span className="agent-chip__badge">{active ? active.name[locale] : skills.length}</span>
        </button>
        {pop === "skill" && skillList.length ? (
          <div className="agent-skillpop">
            <div className="agent-skillpop__panel" role="menu">
              <div className="agent-skillpop__list">
                {skillList.map((s, i) => (
                  <button
                    type="button"
                    key={s.id}
                    role="menuitem"
                    className="agent-skillpop__item"
                    data-skill-id={s.id}
                    data-current={i === skillHover ? "true" : undefined}
                    onMouseEnter={() => onSkillHover(i)}
                    onFocus={() => onSkillHover(i)}
                    onClick={() => {
                      onActiveSkill(activeSkill === s.id ? null : s.id);
                      close();
                    }}
                  >
                    <span className="agent-skillpop__icon">
                      <IconSkill />
                    </span>
                    <span className="agent-skillpop__body">
                      <span className="agent-skillpop__name">{s.name[locale]}</span>
                      <span className="agent-skillpop__desc">{s.desc[locale]}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" className="agent-skillpop__manage" onClick={onManageSkills}>
                <IconList />
                {t("agent.manageSkills")}
                <IconChevronRight />
              </button>
            </div>
            {preview ? (
              <div className="agent-skillpop__preview" aria-hidden="true">
                <span
                  className="agent-skillpop__shot"
                  style={{ backgroundImage: `url(${shot(skillHover)})` }}
                />
                <span className="agent-skillpop__pbody">
                  <span className="agent-skillpop__pname">{preview.name[locale]}</span>
                  <span className="agent-skillpop__pdesc">{preview.desc[locale]}</span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
