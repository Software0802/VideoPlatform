"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  ALL_SKILLS,
  IMG_MODELS,
  SKILL_COUNT,
  TEXT_MODELS,
  VID_MODELS,
  iconGrad,
  shot,
  type ModelItem,
} from "./data";
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
  textModel: string;
  onTextModel: (v: string) => void;
  imgModel: string;
  onImgModel: (v: string) => void;
  vidModel: string;
  onVidModel: (v: string) => void;
  skillHover: number;
  onSkillHover: (v: number) => void;
  activeSkill: number | null;
  onActiveSkill: (v: number | null) => void;
  onManageSkills: () => void;
  onSend: () => void;
};

/** 下拉列表里带图标 + 描述的模型行。 */
function ModelRow({
  item,
  index,
  current,
  onPick,
}: {
  item: ModelItem;
  index: number;
  current: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="agent-pop__item"
      data-current={item.name === current ? "true" : undefined}
      onClick={onPick}
    >
      <span className="agent-pop__icon" style={{ background: iconGrad(index) }} />
      <span className="agent-pop__body">
        <span className="agent-pop__name">{item.name}</span>
        <span className="agent-pop__desc">{item.desc}</span>
      </span>
      {item.auto ? <span className="agent-pop__auto">自动</span> : null}
    </button>
  );
}

/** 首屏 / 会话页共用的 680 宽输入卡：textarea + 一行芯片 + 渐变发送钮。 */
export default function AgentAsk(props: Props) {
  const {
    prompt,
    onPrompt,
    pop,
    onPop,
    textModel,
    onTextModel,
    imgModel,
    onImgModel,
    vidModel,
    onVidModel,
    skillHover,
    onSkillHover,
    activeSkill,
    onActiveSkill,
    onManageSkills,
    onSend,
  } = props;

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
  const skillList = ALL_SKILLS.slice(0, 10);
  const preview = skillList[skillHover] ?? skillList[0];
  const active = activeSkill === null ? null : ALL_SKILLS[activeSkill];

  return (
    <div className="agent-ask">
      <textarea
        className="agent-ask__input"
        rows={2}
        value={prompt}
        aria-label="智能体提示词"
        placeholder="为这个角色生成一组多镜头场景"
        onChange={(e) => onPrompt(e.target.value)}
      />
      <div className="agent-ask__row" ref={rowRef}>
        <button type="button" className="agent-ask__icon" aria-label="添加素材">
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
            {textModel}
            <IconChevronDown />
          </button>
          {pop === "text" ? (
            <div className="agent-pop agent-pop--text" role="menu">
              {TEXT_MODELS.map((m) => (
                <button
                  type="button"
                  key={m}
                  role="menuitem"
                  className="agent-pop__plain"
                  data-current={m === textModel ? "true" : undefined}
                  onClick={() => {
                    onTextModel(m);
                    close();
                  }}
                >
                  <span className="agent-pop__dot" />
                  {m}
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
            图片: {imgModel}
            <IconChevronDown />
          </button>
          {pop === "img" ? (
            <div className="agent-pop agent-pop--img" role="menu">
              {IMG_MODELS.map((m, i) => (
                <ModelRow
                  key={m.name}
                  item={m}
                  index={i}
                  current={imgModel}
                  onPick={() => {
                    onImgModel(m.name);
                    close();
                  }}
                />
              ))}
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
            视频: {vidModel}
            <IconChevronDown />
          </button>
          {pop === "vid" ? (
            <div className="agent-pop agent-pop--vid" role="menu">
              {VID_MODELS.map((m, i) => (
                <ModelRow
                  key={m.name}
                  item={m}
                  index={i}
                  current={vidModel}
                  onPick={() => {
                    onVidModel(m.name);
                    close();
                  }}
                />
              ))}
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
            技能
            <span className="agent-chip__badge">{active ? active.name : SKILL_COUNT}</span>
          </button>
          {pop === "skill" ? (
            <div className="agent-skillpop">
              <div className="agent-skillpop__panel" role="menu">
                <div className="agent-skillpop__list">
                  {skillList.map((s, i) => (
                    <button
                      type="button"
                      key={s.name}
                      role="menuitem"
                      className="agent-skillpop__item"
                      data-current={i === skillHover ? "true" : undefined}
                      onMouseEnter={() => onSkillHover(i)}
                      onFocus={() => onSkillHover(i)}
                      onClick={() => {
                        onActiveSkill(activeSkill === i ? null : i);
                        close();
                      }}
                    >
                      <span className="agent-skillpop__icon">
                        <IconSkill />
                      </span>
                      <span className="agent-skillpop__body">
                        <span className="agent-skillpop__name">{s.name}</span>
                        <span className="agent-skillpop__desc">{s.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <button type="button" className="agent-skillpop__manage" onClick={onManageSkills}>
                  <IconList />
                  管理工具
                  <IconChevronRight />
                </button>
              </div>
              <div className="agent-skillpop__preview" aria-hidden="true">
                <span
                  className="agent-skillpop__shot"
                  style={{ backgroundImage: `url(${shot(skillHover)})` }}
                />
                <span className="agent-skillpop__pbody">
                  <span className="agent-skillpop__pname">{preview.name}</span>
                  <span className="agent-skillpop__pdesc">{preview.desc}</span>
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <button type="button" className="agent-send" aria-label="发送" onClick={onSend}>
          <IconArrowUp />
        </button>
      </div>
    </div>
  );
}
