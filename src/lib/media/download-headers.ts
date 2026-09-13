import { grokApiKey, openaiApiKey, openaiBase, xaiBase, ymanApiKey, ymanBase } from "@/lib/env";
import { log } from "@/lib/log";
import { liveRelayViews } from "@/lib/providers/relay/live";
import type { ProviderId } from "@/lib/providers/types";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

type BoundUpstream = { key: () => string | undefined; base: () => string };

/**
 * 哪个 provider 的成片下载需要带哪把 key，以及那把 key 只允许发往哪个 origin。
 *
 * relay（含 yman env 预设）从 `live.ts` 的注册视图取——origin 与 keyEnv 都是配置
 * 来的，这里只动态配对；不在这张表里的 provider（可灵、openai 生图、mock、jimeng）
 * 下载走匿名直链，一个头都不带。
 */
function boundUpstreams(): Map<ProviderId, BoundUpstream> {
  const map = new Map<ProviderId, BoundUpstream>();
  map.set("grok", { key: grokApiKey, base: xaiBase });
  // 两个 env 预设的静态兜底：没经过装配（单测只 import 本文件）时 yman / openai
  // 的 origin 配对仍要成立；`data/relays.json` 里配了同 id 的 view 会覆盖这里。
  map.set("yman", { key: ymanApiKey, base: ymanBase });
  map.set("openai", { key: openaiApiKey, base: openaiBase });
  for (const view of liveRelayViews()) {
    // relay 的 /videos content 端点需要 Bearer；openai 预设只有生图通道、
    // 不发可下载的 remoteUrl，但它的 origin 配对留着也无害（key 只认 origin）。
    map.set(view.id, { key: view.apiKey, base: view.base });
  }
  return map;
}

/**
 * 下载成片时该带哪个 Authorization。
 *
 * 成片 URL 是**上游返回的字符串**，无条件带 key 就等于把凭据发给它写下的任何地址。
 * 所以带不带、带哪把，取决于目标 origin 是不是我们自己配置的那个上游。
 *
 * 给了 `providerId`（runner / harness 从 `job.provider` 传进来）时判据更严一层：这次下载
 * 属于哪家任务，就只允许「那家的 origin 配那家的 key」。只按 origin 匹配的话，一个被
 * 攻破或配错的上游只要在成片 URL 里写另一家的域名，就能把另一家的 key 骗出去——按
 * provider 绑定之后，YMan 任务返回一个 `api.x.ai` 的地址不会拿到 xAI 的 key，只会拿到一个
 * 空头 + 一条 warn。
 *
 * 不给 `providerId` 时保持旧行为（纯按 origin 分发），调用方还没接上时不至于把下载打挂。
 */
export function downloadHeadersFor(url: string, providerId?: ProviderId): Record<string, string> {
  const target = originOf(url);
  if (!target) return {};

  const bound = boundUpstreams();

  if (providerId) {
    const entry = bound.get(providerId);
    // 这家的下载本来就不需要鉴权（可灵 / openai 生图 / mock）：给空头是正确答案，不是异常。
    if (!entry) return {};
    const key = entry.key();
    if (!key) return {};
    if (target !== originOf(entry.base())) {
      log("warn", "成片 URL 的 origin 不属于该 provider 的上游，不带任何鉴权头", {
        providerId,
        origin: target,
      });
      return {};
    }
    return { Authorization: `Bearer ${key}` };
  }

  for (const entry of bound.values()) {
    const key = entry.key();
    if (key && target === originOf(entry.base())) {
      return { Authorization: `Bearer ${key}` };
    }
  }

  return {};
}
