import { grokApiKey, xaiBase, ymanApiKey, ymanBase } from "@/lib/env";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 下载成片时该带哪个 Authorization。
 *
 * 只在目标 origin 就是我们**自己配置的**某个上游时才带 key，且只带那个上游的 key：
 * 成片 URL 是上游返回的字符串，无条件带 key 就等于把凭据发给任何它写下的地址
 * （Sub2API 落盘 URL 需要带 key，xAI 的 CDN 直链不需要，YMan 的 `/videos/{id}/content`
 * 需要）。认不出 origin、或两个 base 都对不上，就一个头都不带。
 */
export function downloadHeadersFor(url: string): Record<string, string> {
  const target = originOf(url);
  if (!target) return {};

  const xaiKey = grokApiKey();
  if (xaiKey && target === originOf(xaiBase())) {
    return { Authorization: `Bearer ${xaiKey}` };
  }

  const yman = ymanApiKey();
  if (yman && target === originOf(ymanBase())) {
    return { Authorization: `Bearer ${yman}` };
  }

  return {};
}
