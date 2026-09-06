"use client";

import { IconArrowUp, IconBroom, IconClose, IconImage } from "@/components/genius/icons";
import { useShell } from "@/components/genius/ShellContext";

/*
  创作搭子（交接包 §4.1 图 8）：面板正上方的浮层。本轮**仅样式 + 占位文案**（方案 §4）：
  没有对应后端，输入与发送都只提示「即将上线」，不发任何请求。
*/

const LINES = ["你好，我是你的创作搭子", "一个词、一个想法，或者一张图片", "发给我，我会把它写成", "一条好用的提示词"];

export function BuddyPop() {
  const { setPop, showToast } = useShell();
  return (
    <div className="buddy" role="dialog" aria-label="创作搭子">
      <div className="buddy__head">
        <span className="buddy__title">创作搭子</span>
        <button type="button" className="buddy__icon" aria-label="清空对话" onClick={() => showToast("即将上线")}>
          <IconBroom size={15} />
        </button>
        <button type="button" className="buddy__icon" aria-label="关闭创作搭子" onClick={() => setPop(null)}>
          <IconClose size={15} />
        </button>
      </div>
      <div className="buddy__stage">
        {LINES.map((line, i) => (
          <span key={line} className="buddy__line" data-i={i}>
            {line}
          </span>
        ))}
      </div>
      <div className="buddy__foot">
        <span className="buddy__slot" aria-hidden="true">
          <IconImage size={18} />
        </span>
        <input
          className="buddy__input"
          placeholder="从一句话或一张图片开始，我来帮你写提示词"
          aria-label="和创作搭子说话"
          readOnly
          onFocus={() => showToast("即将上线")}
        />
        <button type="button" className="buddy__send" aria-label="发送给创作搭子" onClick={() => showToast("即将上线")}>
          <IconArrowUp size={14} />
        </button>
      </div>
    </div>
  );
}
