"use client";

import { useT } from "@/components/genius/i18n/I18nProvider";
import type { AgentChatModel, AgentSkill, AgentTier } from "@/lib/client/agent";
import type { Product } from "@/lib/client/models";
import AgentPickers, { type PickerPop } from "./AgentPickers";
import { IconArrowUp, IconPlus } from "./icons";

export type AskPop = PickerPop;

type Props = {
  prompt: string;
  onPrompt: (v: string) => void;
  pop: AskPop;
  onPop: (v: AskPop) => void;
  /** 对话模型白名单与当前选择（`null` = 服务端默认那条）。 */
  chatModels: AgentChatModel[];
  chatDefault?: string;
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
  onSend: () => void;
  busy?: boolean;
  /** 这台实例配了对话提供方吗。`false` = 整张卡片置灰，一个字也发不出去。 */
  available?: boolean;
};

/**
 * 首屏输入卡：textarea + 一行芯片 + 渐变发送钮。
 *
 * 芯片行是共享的 `AgentPickers`：对话模型芯片显示白名单里的真名（弹层里还有
 * 「创意档」三档——映射温度 / 输出上限），图片 / 视频是 `GET /api/models`
 * 下发的产品，技能是 `GET /api/agent/skills`。
 */
export default function AgentAsk(props: Props) {
  const { prompt, onPrompt, onSend, busy, available = true, ...pickers } = props;

  const t = useT();

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
      <div className="agent-ask__row">
        <button type="button" className="agent-ask__icon" aria-label={t("agent.addAsset")} disabled>
          <IconPlus />
        </button>

        <AgentPickers {...pickers} />

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
