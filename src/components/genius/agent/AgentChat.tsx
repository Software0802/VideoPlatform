"use client";

import { useEffect, useRef, useState } from "react";
import {
  CHAT_PLACEHOLDER_REPLY,
  CHAT_SEED_PROMPT,
  CHAT_SEED_REPLY,
  CHAT_SEED_USER,
  CHAT_TITLE,
  shot,
} from "./data";
import { IconArrowUp, IconBolt, IconChevronLeft, IconPlus, IconSkill } from "./icons";

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; skill?: string; prompt?: string; credits?: number };

type Props = {
  seedPrompt: string;
  onBack: () => void;
};

const ASSET_TABS = ["最终产物", "图片", "2K"] as const;

/** 会话页（原型图 25）：左 400 对话栏 + 右侧资产栏，占位对话，不发请求。 */
export default function AgentChat({ seedPrompt, onBack }: Props) {
  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: "seed-u", role: "user", text: seedPrompt.trim() || CHAT_SEED_USER },
    {
      id: "seed-a",
      role: "assistant",
      text: CHAT_SEED_REPLY,
      skill: "电影叙事",
      prompt: CHAT_SEED_PROMPT,
      credits: 21,
    },
  ]);
  const [draft, setDraft] = useState("");
  const [assetTab, setAssetTab] = useState<string>(ASSET_TABS[0]);
  const [picked, setPicked] = useState(2);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    seq.current += 1;
    const n = seq.current;
    setDraft("");
    setMessages((prev) => [...prev, { id: `u${n}`, role: "user", text }]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setMessages((prev) => [...prev, { id: `a${n}`, role: "assistant", text: CHAT_PLACEHOLDER_REPLY }]);
    }, 600);
  };

  return (
    <div className="agent-chat">
      <div className="agent-chat__left">
        <div className="agent-chat__head">
          <button type="button" className="agent-chat__back" aria-label="返回智能体" onClick={onBack}>
            <IconChevronLeft />
          </button>
          <span className="agent-chat__title">{CHAT_TITLE}</span>
          <span className="agent-chat__more" aria-hidden="true">
            ⋮
          </span>
        </div>

        <div className="agent-chat__log" ref={logRef}>
          {messages.map((m) =>
            m.role === "user" ? (
              <span className="agent-chat__bubble" key={m.id}>
                {m.text}
              </span>
            ) : (
              <div className="agent-chat__answer" key={m.id}>
                <span className="agent-chat__text">{m.text}</span>
                {m.skill ? (
                  <div className="agent-chat__skill-line">
                    已调用技能
                    <span className="agent-chat__skill">
                      <IconSkill size={12} />
                      {m.skill}
                    </span>
                  </div>
                ) : null}
                {m.prompt ? <span className="agent-chat__text">{m.prompt}</span> : null}
                {m.credits ? (
                  <span className="agent-chat__credits">
                    <IconBolt />
                    {m.credits} 积分
                  </span>
                ) : null}
              </div>
            ),
          )}
        </div>

        <div className="agent-chat__composer">
          <input
            className="agent-chat__input"
            value={draft}
            aria-label="会话输入"
            placeholder="描述你想创建的内容，或提出问题"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="agent-chat__row">
            <button type="button" className="agent-chat__icon" aria-label="添加素材">
              <IconPlus size={14} />
            </button>
            <span className="agent-chat__tag">自动 · 均衡</span>
            <span className="agent-chat__tag">图片: 自动</span>
            <span className="agent-chat__tag">视频: 自动</span>
            <button type="button" className="agent-chat__send" aria-label="发送" onClick={send}>
              <IconArrowUp size={13} />
            </button>
          </div>
        </div>
      </div>

      <div className="agent-chat__right">
        <div className="agent-chat__assets-head">
          <span className="agent-chat__assets-title">资产</span>
          <span className="agent-chat__assets-count">9</span>
          <div className="agent-chat__assets-tabs">
            {ASSET_TABS.map((t) => (
              <button
                type="button"
                key={t}
                className="agent-chat__assets-tab"
                aria-pressed={t === assetTab}
                data-on={t === assetTab ? "true" : undefined}
                onClick={() => setAssetTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="agent-chat__assets">
          {Array.from({ length: 9 }, (_, i) => (
            <button
              type="button"
              key={i}
              className="agent-asset"
              aria-label={`资产 ${14 + i}`}
              aria-pressed={i === picked}
              data-on={i === picked ? "true" : undefined}
              style={{ backgroundImage: `url(${shot(i)})` }}
              onClick={() => setPicked(i)}
            >
              <span className="agent-asset__n">{14 + i}</span>
            </button>
          ))}
        </div>

        <div className="agent-chat__fail">
          <span className="agent-chat__fail-label">视频</span>
          <span className="agent-chat__fail-state">失败</span>
        </div>
      </div>
    </div>
  );
}
