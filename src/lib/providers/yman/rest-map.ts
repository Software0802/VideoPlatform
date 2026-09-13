import { ymanCreditsToUsd } from "@/lib/cost";
import { ymanBase } from "@/lib/env";
import { ymanRelayCatalog } from "@/lib/providers/yman/catalog";
import {
  mapRelayTask,
  mapToRelayRequest,
  relaySize,
  resolveRelaySettings,
  type RelayRestContext,
} from "@/lib/providers/relay/rest-map";
import type { ProviderGenerateRequest, ProviderPoll } from "@/lib/providers/types";

/**
 * YMan 的 `/videos` 三步映射：实现已提炼进 `providers/relay/rest-map.ts`，这里只剩
 * 把 YMan 的目录 / base / 积分折算绑进去的薄壳——导出签名不变，测试与
 * `jobs/provider-settings.ts` 照旧用这两个入口。
 */

export type YmanRestCall = { body: Record<string, unknown> };
export type YmanSettings = ReturnType<typeof resolveYmanSettings>;

export const YMAN_REST: RelayRestContext = {
  id: "yman",
  name: "YMan",
  base: ymanBase,
  catalog: ymanRelayCatalog,
  creditsToUsd: ymanCreditsToUsd,
};

/** 一次 YMan 调用真正会用的四个参数（语义注释见 `relay/rest-map.ts` 的 `resolveRelaySettings`）。 */
export function resolveYmanSettings(
  req: ProviderGenerateRequest,
  defaults?: { resolution?: "720p" | "1080p" },
): ReturnType<typeof resolveRelaySettings> {
  return resolveRelaySettings(YMAN_REST, req, defaults);
}

/** 短边判档 → `宽x高`（见 `relay/rest-map.ts`）。 */
export function ymanSize(ratio: Parameters<typeof relaySize>[0], resolution: "720p" | "1080p"): string {
  return relaySize(ratio, resolution);
}

export function mapToYmanRequest(req: ProviderGenerateRequest): YmanRestCall {
  return mapToRelayRequest(YMAN_REST, req);
}

export function mapYmanTask(task: Record<string, unknown>): ProviderPoll {
  return mapRelayTask(YMAN_REST, task);
}
