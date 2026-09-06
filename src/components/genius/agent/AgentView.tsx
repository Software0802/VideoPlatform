"use client";

import { useState } from "react";
import AgentAsk, { type AskPop } from "./AgentAsk";
import AgentChat from "./AgentChat";
import AgentPlaza from "./AgentPlaza";
import { CHAT_TITLE, SKILLS, shot } from "./data";
import { IconPanelLeft, IconPencil } from "./icons";

type Screen = "home" | "plaza" | "chat";

/**
 * 智能体视图（交接包 §5，原型图 16–25）。
 * 全部本地 state，占位数据，不发任何请求：
 * 首屏 → 四个下拉（文本 / 生图 / 视频模型、技能 + 悬停预览卡）→ 技能广场 → 历史抽屉 → 会话页。
 */
export default function AgentView() {
  const [screen, setScreen] = useState<Screen>("home");
  const [prompt, setPrompt] = useState("");
  const [pop, setPop] = useState<AskPop>(null);
  const [textModel, setTextModel] = useState("自动 · 均衡");
  const [imgModel, setImgModel] = useState("自动");
  const [vidModel, setVidModel] = useState("自动");
  const [skillHover, setSkillHover] = useState(0);
  const [activeSkill, setActiveSkill] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [plazaOff, setPlazaOff] = useState<Record<number, boolean>>({});
  const [chatSeed, setChatSeed] = useState("");

  const openChat = (seed: string) => {
    setChatSeed(seed);
    setPop(null);
    setHistoryOpen(false);
    setScreen("chat");
  };

  return (
    <div className="agent-view" data-screen={screen}>
      {screen === "home" ? (
        <>
          <div className="agent-view__scroll">
            <div className="agent-hero">
              <h1 className="agent-hero__title">
                一切，始于<span className="agent-hero__grad">一个想法</span>
              </h1>
              <AgentAsk
                prompt={prompt}
                onPrompt={setPrompt}
                pop={pop}
                onPop={setPop}
                textModel={textModel}
                onTextModel={setTextModel}
                imgModel={imgModel}
                onImgModel={setImgModel}
                vidModel={vidModel}
                onVidModel={setVidModel}
                skillHover={skillHover}
                onSkillHover={setSkillHover}
                activeSkill={activeSkill}
                onActiveSkill={setActiveSkill}
                onManageSkills={() => {
                  setPop(null);
                  setScreen("plaza");
                }}
                onSend={() => openChat(prompt)}
              />
            </div>

            <section className="agent-picks">
              <h2 className="agent-picks__title">选择一个技能开始</h2>
              <div className="agent-picks__grid">
                {SKILLS.map((s, i) => (
                  <button
                    type="button"
                    key={s.name}
                    className="agent-card"
                    aria-pressed={activeSkill === i}
                    data-active={activeSkill === i ? "true" : undefined}
                    onClick={() => {
                      setActiveSkill(activeSkill === i ? null : i);
                      setSkillHover(i);
                    }}
                  >
                    <span className="agent-card__shot" style={{ backgroundImage: `url(${shot(i)})` }} />
                    <span className="agent-card__body">
                      <span className="agent-card__name">{s.name}</span>
                      <span className="agent-card__desc">{s.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <button
            type="button"
            className="agent-history-btn"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <IconPanelLeft />
            历史记录
          </button>

          {historyOpen ? (
            <aside className="agent-drawer" aria-label="智能体历史">
              <div className="agent-drawer__head">
                <span className="agent-drawer__title">智能体</span>
                <button
                  type="button"
                  className="agent-drawer__close"
                  aria-label="收起历史记录"
                  onClick={() => setHistoryOpen(false)}
                >
                  <IconPanelLeft size={15} />
                </button>
              </div>
              <button
                type="button"
                className="agent-drawer__new"
                onClick={() => {
                  setPrompt("");
                  setActiveSkill(null);
                  setHistoryOpen(false);
                }}
              >
                <IconPencil />
                新建对话
              </button>
              <span className="agent-drawer__label">任务</span>
              <button type="button" className="agent-drawer__item" onClick={() => openChat("")}>
                <span className="agent-drawer__item-name">{CHAT_TITLE}</span>
                <span className="agent-drawer__item-more" aria-hidden="true">
                  ⋯
                </span>
              </button>
            </aside>
          ) : null}
        </>
      ) : null}

      {screen === "plaza" ? (
        <AgentPlaza
          off={plazaOff}
          onToggle={(i) => setPlazaOff((prev) => ({ ...prev, [i]: !prev[i] }))}
          onBack={() => setScreen("home")}
        />
      ) : null}

      {screen === "chat" ? <AgentChat seedPrompt={chatSeed} onBack={() => setScreen("home")} /> : null}
    </div>
  );
}
