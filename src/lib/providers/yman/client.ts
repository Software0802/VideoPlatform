import { ymanApiKey, ymanBase } from "@/lib/env";
import {
  relayError,
  relayGet,
  relayHeaders,
  relayPost,
  type RelayEndpoint,
} from "@/lib/providers/relay/client";
import type { ProviderHttpError } from "@/lib/providers/types";

/**
 * YMan 的 HTTP 客户端：实现已提炼进 `providers/relay/client.ts`，这里只剩把
 * `YMAN_API_KEY` / `YMAN_BASE_URL` 绑进去的薄壳——导出签名不变。
 */

const RT: RelayEndpoint = {
  id: "yman",
  name: "YMan",
  keyEnvName: "YMAN_API_KEY",
  apiKey: ymanApiKey,
  base: ymanBase,
};

/** key 不进返回值、不进日志、不进错误消息。 */
export function ymanHeaders(json = true): Record<string, string> {
  return relayHeaders(RT, json);
}

/** 创建任务，固定 `maxAttempts: 1`（已计费不重发）。 */
export function ymanPost(
  pathSuffix: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return relayPost(RT, pathSuffix, body);
}

/** 查询任务。免费、无副作用，保留通用瞬时状态重试。 */
export function ymanGet(pathSuffix: string): Promise<Record<string, unknown>> {
  return relayGet(RT, pathSuffix);
}

export function ymanError(status: number, body: Record<string, unknown>): ProviderHttpError {
  return relayError(RT, status, body);
}
