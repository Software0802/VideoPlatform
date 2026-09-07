import type { MessageKey } from "@/lib/i18n/messages";
import type { AgentTier } from "@/lib/client/agent";
import type { JobPublic } from "@/lib/jobs/schema";

/**
 * 智能体视图的**装饰**常量。
 *
 * 技能、模型、会话、作品全部来自服务端（`/api/agent/*`、`/api/models`）；这里只剩下
 * 三样与后端无关的东西：技能卡的占位缩略图、下拉图标的渐变色板、以及把枚举翻译成
 * 文案键的映射表。原型里那几张假模型名与假技能表已经删掉了。
 */

const LUMINA_NAMES = [
  "2e9cde0e2fb0803e",
  "a72d8b509c55bcd0",
  "a1f3319d0d783e66",
  "f3bfe52263d0656d",
  "d99c0972e1f99b67",
  "a9008119d34b8fc1",
  "5a09f4952b5ad9b6",
  "6f297b60448c30c9",
  "0450bc8d80da9173",
  "5edd8af76572172a",
  "8c0d9035649bec1f",
  "fd7b4eb5c10483f5",
] as const;

/**
 * 技能卡的封面。技能是一段提示词约束，没有「自己的作品」，所以封面用站内示例图按
 * 序号取——比留一片灰底可读，也不会让人误以为那是这个技能生成的东西。
 */
export const SHOTS: string[] = LUMINA_NAMES.map((n) => `/lumina/${n}.webp`);

export function shot(i: number): string {
  return SHOTS[((i % SHOTS.length) + SHOTS.length) % SHOTS.length];
}

/** 模型图标的渐变色板（原型 ICONS）。 */
export const ICON_GRADS = [
  "linear-gradient(140deg,#ff8a3d,#ff4d8d)",
  "linear-gradient(140deg,#5b8cff,#a855f7)",
  "linear-gradient(140deg,#3fd4a0,#1f8f6a)",
  "linear-gradient(140deg,#f0d9a8,#c9a25e)",
  "linear-gradient(140deg,#e08fc8,#8b5cf6)",
  "linear-gradient(140deg,#8b8b91,#4a4a52)",
] as const;

export function iconGrad(i: number): string {
  return ICON_GRADS[i % ICON_GRADS.length];
}

/**
 * 文本模型下拉的三档。用户看到的是「极速 / 均衡 / 精创」，背后是温度与输出上限
 * （`src/lib/agent/llm.ts` 的 `TIER_SETTINGS`）——模型名是实现细节，不露出。
 */
export const TIER_KEY: Record<AgentTier, MessageKey> = {
  fast: "agent.tier.fast",
  balanced: "agent.tier.balanced",
  quality: "agent.tier.quality",
};

/**
 * 后端状态机有 13 个状态，用户只需要分得清四档：排队、生成中、成了、没成。
 * 把中间那一串（submitting / pending / directing / stitching…）都归成「生成中」，
 * 因为对着资产格子的人能做的事在这四档里是一样的。
 */
export function statusKey(job: JobPublic): MessageKey {
  if (job.artifactsPurgedAt) return "agent.statusPurged";
  switch (job.status) {
    case "queued":
      return "agent.statusQueued";
    case "succeeded":
      return "agent.statusSucceeded";
    case "failed":
      return "agent.statusFailed";
    case "canceled":
      return "agent.statusCanceled";
    case "expired":
      return "agent.statusExpired";
    default:
      return "agent.statusRunning";
  }
}

/** 资产格子上要显示的静帧：图片用它自己，视频用海报帧；已清理的作品没有字节可取。 */
export function stillOf(job: JobPublic): string | null {
  if (job.artifactsPurgedAt || !job.output) return null;
  return job.output.kind === "image" ? job.output.imageUrl : job.output.posterUrl;
}
