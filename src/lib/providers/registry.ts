import { hasKlingKey, hasOpenaiKey, hasXaiKey, hasYmanKey } from "@/lib/env";
import type { ProviderId, VideoProvider } from "@/lib/providers/types";

/**
 * Provider 注册表：系统认得哪些 provider 的唯一事实源。
 *
 * `ProviderId` 放宽为字符串之后，「这个 id 是谁」只能在这里回答——编译期联合已经
 * 装不下运行时注册的 relay provider。注册本身不在本模块做（见 `builtin.ts`）：
 * 注册表若反向 import 各 provider 实现，就会和「provider 实现 → env → 注册表」
 * 绕成循环依赖，所以内置五家由 `builtin.ts` 显式 `registerProvider`，relay 由
 * 自己的装配代码注册。需要注册表已就绪的调用方必须（间接）import `builtin.ts`。
 */

const PROVIDERS = new Map<ProviderId, VideoProvider>();

/**
 * 已注销但保留对象的影子表。relay 被下线 / 改配置时旧 provider 从新任务路由里消失，
 * 但历史 job.json 里的 provider id 与正在跑的任务手里握着的对象引用都必须还能解析——
 * 所以注销是「挪进影子表」，不是真删。影子表只参与 `providerForId` 解析，
 * `isRegisteredProviderId` / ORDER 过滤 / `hasProviderKey` 一律看不到它。
 */
const SHADOW = new Map<ProviderId, VideoProvider>();

/** 代码内建的 provider；relay 不在这个列表里，它们是运行时注册的。 */
export const BUILTIN_PROVIDER_IDS = [
  "grok",
  "mock",
  "jimeng",
  "openai",
  "kling",
  "yman",
] as const;

/** 重复注册同一个 id 是装配错误，直接抛——静默覆盖会让任务落到没人预期的实现上。 */
export function registerProvider(provider: VideoProvider): void {
  // 同一个对象再注册一次是 no-op（dev HMR 重评估装配模块时会发生），换了实现才是错。
  if (PROVIDERS.get(provider.id) === provider) return;
  if (PROVIDERS.has(provider.id)) {
    throw new Error(`provider already registered: ${provider.id}`);
  }
  PROVIDERS.set(provider.id, provider);
  // 重新注册同 id 意味着它回来了，影子条目作废。
  SHADOW.delete(provider.id);
}

/**
 * 注销：新任务路由不再可见（ORDER 过滤 / `hasProviderKey` 都查 `PROVIDERS`），
 * 对象挪进影子表继续为已存在的任务解析。幂等——没注册过的 id 是 no-op。
 */
export function unregisterProvider(id: ProviderId): void {
  const provider = PROVIDERS.get(id);
  if (!provider) return;
  PROVIDERS.delete(id);
  SHADOW.set(id, provider);
}

/** 未注册的 id 抛错，与注册表出现之前 `providerForId` 的行为一致；影子条目仍可解析。 */
export function providerForId(id: ProviderId): VideoProvider {
  const provider = PROVIDERS.get(id) ?? SHADOW.get(id);
  if (!provider) throw new Error(`unknown provider: ${String(id)}`);
  return provider;
}

export function isRegisteredProviderId(id: string): id is ProviderId {
  return PROVIDERS.has(id);
}

export function registeredProviderIds(): ProviderId[] {
  return [...PROVIDERS.keys()];
}

/**
 * 一个 provider 有没有可用的 key。路由第一关问的就是它——没有 key 的 provider
 * 无论排在多前面都不参与。
 *
 * 优先用 provider 自己声明的 `hasKey()`；没声明的走内置各家的既有判据（与注册表
 * 出现之前逐字一致），不认识的 id 一律 false——宁可跳过也不误判成别家。
 */
export function hasProviderKey(id: ProviderId): boolean {
  const provider = PROVIDERS.get(id);
  if (provider?.hasKey) return provider.hasKey();
  switch (id) {
    case "grok":
      return hasXaiKey();
    case "kling":
      return hasKlingKey();
    case "yman":
      return hasYmanKey();
    case "openai":
      return hasOpenaiKey();
    case "mock":
      return true;
    // 即梦还是占位实现（submit 直接抛），永远不该被自动路由选中。
    case "jimeng":
      return false;
    default:
      return false;
  }
}
