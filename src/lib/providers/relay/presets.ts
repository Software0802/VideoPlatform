import { ymanCreditsToUsd } from "@/lib/cost";
import { openaiApiKey, openaiBase, ymanApiKey, ymanBase, ymanTaskTimeoutMs } from "@/lib/env";
import { OPENAI_IMAGE_CONFIG, YMAN_IMAGE_CONFIG } from "@/lib/providers/openai-image/config";
import { ymanRelayCatalog } from "@/lib/providers/yman/catalog";
import type { RelayView } from "@/lib/providers/relay/live";

/**
 * 老 env 折算出来的两条 relay 预设。所有取值都是**调用时读 env 的 thunk**——
 * 测试改 `process.env` 后行为与旧实现逐字一致，生产 `.env` 一行不用改。
 *
 * `implicitOrder: false`：它们不进入「无显式 ORDER 时自动生成」的次序——今天的默认
 * 次序（video `grok`、image `openai,grok`）一个字都不能动；要进次序得显式写进
 * ORDER 或被管理接口登记成正式 relay。
 */
export const YMAN_RELAY: RelayView = {
  id: "yman",
  name: "YMan",
  keyEnvName: "YMAN_API_KEY",
  apiKey: ymanApiKey,
  base: ymanBase,
  implicitOrder: false,
  priority: 0,
  enabled: true,
  catalog: ymanRelayCatalog,
  videoTaskTimeoutMs: ymanTaskTimeoutMs,
  image: YMAN_IMAGE_CONFIG,
  chatModel: () => undefined,
  creditsPerCny: 100,
  creditsToUsd: ymanCreditsToUsd,
  source: "legacy",
};

/** openai 预设只有生图通道（视频路径从来不由它承接）。 */
export const OPENAI_RELAY: RelayView = {
  id: "openai",
  name: "OpenAI",
  keyEnvName: "OPENAI_API_KEY",
  apiKey: openaiApiKey,
  base: openaiBase,
  implicitOrder: false,
  priority: 0,
  enabled: true,
  catalog: null,
  videoTaskTimeoutMs: () => undefined,
  image: OPENAI_IMAGE_CONFIG,
  chatModel: () => undefined,
  creditsPerCny: undefined,
  creditsToUsd: () => 0,
  source: "legacy",
};
