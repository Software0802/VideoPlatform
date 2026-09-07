"use client";

import { IconArrowUp, IconBroom, IconClose, IconImage } from "@/components/genius/icons";
import { useShell } from "@/components/genius/ShellContext";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  创作搭子（交接包 §4.1 图 8）：面板正上方的浮层。本轮**仅样式 + 占位文案**（方案 §4）：
  没有对应后端，输入与发送都只提示「即将上线」，不发任何请求。
*/

const LINES: MessageKey[] = [
  "composer.buddy.line1",
  "composer.buddy.line2",
  "composer.buddy.line3",
  "composer.buddy.line4",
];

export function BuddyPop() {
  const { setPop, showToast } = useShell();
  const t = useT();
  const soon = t("common.comingSoon");
  return (
    <div className="buddy" role="dialog" aria-label={t("composer.buddy.title")}>
      <div className="buddy__head">
        <span className="buddy__title">{t("composer.buddy.title")}</span>
        <button type="button" className="buddy__icon" aria-label={t("composer.buddy.clear")} onClick={() => showToast(soon)}>
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
        <span className="buddy__slot" aria-hidden="true">
          <IconImage size={18} />
        </span>
        <input
          className="buddy__input"
          placeholder={t("composer.buddy.placeholder")}
          aria-label={t("composer.buddy.inputAria")}
          readOnly
          onFocus={() => showToast(soon)}
        />
        <button type="button" className="buddy__send" aria-label={t("composer.buddy.send")} onClick={() => showToast(soon)}>
          <IconArrowUp size={14} />
        </button>
      </div>
    </div>
  );
}
