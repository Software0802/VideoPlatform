import type { OpenaiImageConfig } from "@/lib/providers/openai-image/config";
import type { RelayCatalog } from "@/lib/providers/relay/catalog";
import type { NativeMode, ProviderId } from "@/lib/providers/types";

/**
 * 当前已装配 relay 的运行时视图。装配（`assemble.ts`）写，消费方（cost /
 * provider-settings / model-name / download-headers / openai-image/config）读。
 *
 * 故意做成**零运行时 import 的叶子模块**：读它的那些文件（cost.ts 等）被 provider
 * 实现反向 import，视图若住在 assemble 里就会绕成「assemble → native → config →
 * cost → assemble」的循环。这里只放可变 Map 与类型，不碰任何实现。
 */
export type RelayView = {
  id: ProviderId;
  /** 展示名，只进日志与错误文案。 */
  name: string;
  /** 读 key 的环境变量名；key 值本身永远不出现在响应与日志里。 */
  keyEnvName: string;
  apiKey(): string | undefined;
  base(): string;
  /** ORDER 没显式配置时是否自动进隐式次序（按 priority 降序）。老 env 折算的预设为 false。 */
  implicitOrder: boolean;
  priority: number;
  enabled: boolean;
  /** 视频通道：OpenAI 兼容 /videos 三步。catalog 为 null 表示这条 relay 不接视频。 */
  catalog: RelayCatalog | null;
  /** 目录来源：static 只看配置表；models-endpoint 还要合并 `/models` 快照。 */
  catalogSource?: "static" | "models-endpoint";
  videoTaskTimeoutMs(): number | undefined;
  /** 图片通道（OpenAI Images 兼容）；null 表示不接图。 */
  image: OpenaiImageConfig | null;
  chatModel(): string | undefined;
  /** 积分制中转：1 元人民币兑多少积分（YMan = 100）；非积分制省略。 */
  creditsPerCny: number | undefined;
  /** 积分 → USD 折算；非积分制中转也应实现（返回 0），调用方按 catalog 存在与否分流。 */
  creditsToUsd(credits: number): number;
  /** 来源：手工配置文件 / LUMEN_RELAYS 种子 / 老 env 折算。 */
  source: "file" | "env-seed" | "legacy";
};

const VIEWS = new Map<ProviderId, RelayView>();

export function setRelayView(view: RelayView): void {
  VIEWS.set(view.id, view);
}

export function removeRelayView(id: ProviderId): void {
  VIEWS.delete(id);
}

export function relayViewFor(id: ProviderId): RelayView | undefined {
  return VIEWS.get(id);
}

export function liveRelayViews(): RelayView[] {
  return [...VIEWS.values()];
}

/** 这条 relay 的视频通道声明了哪些原生 mode（由 defaults 里配了模型的那几项决定）。 */
export function relayVideoModes(view: RelayView): NativeMode[] {
  if (!view.catalog) return [];
  return (["text_to_video", "image_to_video", "reference_to_video"] as const).filter(
    (mode) => Boolean(view.catalog?.configuredModel(mode)),
  );
}
