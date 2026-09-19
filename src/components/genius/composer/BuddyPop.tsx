"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconArrowUp, IconBroom, IconClose } from "@/components/genius/icons";
import { useComposer } from "@/components/genius/ShellContext";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  创作搭子（交接包 §4.1 图 8）：面板正上方的浮层，作用是「把一句话写成一条好用的
  提示词」。这件事平台真的会做——智能体（`/agent`）就是干这个的，每一轮走真的 LLM。
  所以这里不再自己假装对话（原来输入框只读、发送只弹「即将上线」），而是把当前提示词
  带过去打开智能体：`/agent?q=…`。写完的提示词再复制回创作面板，或者直接在智能体里
  让它建任务。
*/

const LINES: MessageKey[] = [
  "composer.buddy.line1",
  "composer.buddy.line2",
  "composer.buddy.line3",
  "composer.buddy.line4",
];

/** 与智能体输入框同一个上限（服务端 schema 也是 2000）。 */
const MAX_LEN = 2000;

export function BuddyPop() {
  const { setPop, prompt } = useComposer();
  const router = useRouter();
  const t = useT();
  const [text, setText] = useState(prompt);

  const send = () => {
    const one = text.trim();
    setPop(null);
    router.push(one ? `/agent?q=${encodeURIComponent(one.slice(0, MAX_LEN))}` : "/agent");
  };

  return (
    <div className="buddy" role="dialog" aria-label={t("composer.buddy.title")}>
      <div className="buddy__head">
        <span className="buddy__title">{t("composer.buddy.title")}</span>
        <button
          type="button"
          className="buddy__icon"
          aria-label={t("composer.buddy.clear")}
          onClick={() => setText("")}
        >
          <IconBroom size={15} />
        </button>
        <button type="button" className="buddy__icon" aria-label={t("composer.buddy.close")} onClick={() => setPop(null)}>
          <IconClose size={15} />
        </button>
      </div>
      <div className="buddy__stage">
        {LINES.map((line, i) => (
          <span key={line} className="buddy__line" data-i={i}>
            {t(line)}
          </span>
        ))}
      </div>
      <div className="buddy__foot">
        <input
          className="buddy__input"
          value={text}
          maxLength={MAX_LEN}
          placeholder={t("composer.buddy.placeholder")}
          aria-label={t("composer.buddy.inputAria")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="buddy__send" aria-label={t("composer.buddy.send")} onClick={send}>
          <IconArrowUp size={14} />
        </button>
      </div>
      <p className="buddy__note">{t("composer.buddy.note")}</p>
    </div>
  );
}
