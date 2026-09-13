import { makeRelayProvider } from "@/lib/providers/relay/native";
import { YMAN_RELAY } from "@/lib/providers/relay/presets";
import type { VideoProvider } from "@/lib/providers/types";

/**
 * YMan 中转渠道（OpenAI 兼容的 `/videos` 三步：建任务 → 轮询 → 取 content）。
 * 实现已提炼进 `providers/relay/` 的通用工厂；YMan 是它的一条 env 折算预设
 * （`YMAN_RELAY`，全部取值调用时读 `YMAN_*`），接文生视频 / 图生视频 / 参考生视频，
 * 外加同一条 REST 上的文生图；编辑与延长仍留在 xAI，30 / 45 / 60 秒长片走一致性管线。
 */
export const ymanProvider: VideoProvider = makeRelayProvider(YMAN_RELAY);
