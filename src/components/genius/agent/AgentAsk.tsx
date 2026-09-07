"use client";

import { useCallback, useEffect, useRef } from "react";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import { creditsOf } from "@/components/genius/ShellContext";
import { AGENT_TIERS, type AgentSkill, type AgentTier } from "@/lib/client/agent";
import type { Product } from "@/lib/client/models";
import { TIER_KEY, iconGrad, shot } from "./data";
import {
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconList,
  IconLock,
  IconPlus,
  IconSkill,
} from "./icons";

export type AskPop = null | "text" | "img" | "vid" | "skill";

type Props = {
  prompt: string;
  onPrompt: (v: string) => void;
  pop: AskPop;
  onPop: (v: AskPop) => void;
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
  onSend: () => void;
  busy?: boolean;
  /** 这台实例配了对话提供方吗。`false` = 整张卡片置灰，一个字也发不出去。 */
  available?: boolean;
};

/**
 * 首屏输入卡：textarea + 一行芯片 + 渐变发送钮。
 *
 * 三个下拉都接了真数据：文本是三档（映射温度 / 输出上限，不是模型名），图片 / 视频是
 * `GET /api/models` 下发的**产品**（只露产品名与积分读数，不露供应商），技能是
 * `GET /api/agent/skills`。原型里那些假模型名已经删掉。
 */
export default function AgentAsk(props: Props) {
  const {
    prompt,
    onPrompt,
    pop,
    onPop,
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
    onSend,
    busy,
    available = true,
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

  const toggle = (which: Exclude<AskPop, null>) => onPop(pop === which ? null : which);
  const images = products.filter((p) => p.kind === "image");
  const videos = products.filter((p) => p.kind === "video");
  const nameOf = (id: string | null, pool: Product[]) =>
    (id ? pool.find((p) => p.id === id)?.name : undefined) ?? t("agent.auto");

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
          <span className="agent-pop__desc">{t("agent.autoDesc")}</span>
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
            <span className="agent-pop__name">{p.name}</span>
            <span className="agent-pop__desc">{p.description}</span>
          </span>
          <span className="agent-pop__auto">
            {t("agent.creditsEach", { n: creditsOf(p.samplePriceCny) })}
          </span>
        </button>
      ))}
    </>
  );

  return (
    <div className="agent-ask" data-available={available ? "true" : "false"}>
      <textarea
        className="agent-ask__input"
        rows={2}
        value={prompt}
        aria-label={t("agent.askLabel")}
        placeholder={available ? t("agent.askPlaceholder") : t("agent.unavailable")}
        disabled={!available}
        onChange={(e) => onPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!busy && available) onSend();
          }
        }}
      />
      <div className="agent-ask__row" ref={rowRef}>
        <button type="button" className="agent-ask__icon" aria-label={t("agent.addAsset")} disabled>
          <IconPlus />
        </button>

        <div className="agent-ask__slot">
          <button
            type="button"
            className="agent-chip"
            data-open={pop === "text" ? "true" : undefined}
            aria-expanded={pop === "text"}
            aria-haspopup="menu"
            onClick={() => toggle("text")}
          >
            <IconLock />
            {t(TIER_KEY[tier])}
            <IconChevronDown />
          </button>
          {pop === "text" ? (
            <div className="agent-pop agent-pop--text" role="menu">
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

        <button
          type="button"
          className="agent-send"
          aria-label={t("agent.send")}
          disabled={busy || !available || !prompt.trim()}
          onClick={onSend}
        >
          <IconArrowUp />
        </button>
      </div>
    </div>
  );
}
