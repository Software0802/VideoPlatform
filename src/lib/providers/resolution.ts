import type { Resolution } from "@/lib/providers/types";

/**
 * 分辨率是**有序**的三档，这份顺序是全项目唯一的一份（路由的筛选、provider 的归一、
 * 产品目录的校验都用它）。放在这个不依赖任何 provider 的小模块里，是为了让
 * `providers/*`、`jobs/*` 与 `products/*` 都能引用它而不产生环。
 */
export const RESOLUTION_TIERS: readonly Resolution[] = ["480p", "720p", "1080p"];

export function resolutionRank(resolution: Resolution): number {
  const index = RESOLUTION_TIERS.indexOf(resolution);
  // 认不出的值当成最低档：宁可把它归一到更高的一档，也不要让排序把它当成 1080p。
  return index < 0 ? 0 : index;
}

/**
 * 请求的档位 → 支持列表里**最接近的、不低于它**的那一档；一档都不够高时返回 undefined。
 *
 * 向上而不是向下：480p 的请求交付 720p，用户拿到的东西只多不少；反过来把 1080p 的请求
 * 悄悄降成 720p，是交付了另一个（更差的）东西，只能拒绝。所以「无更高档」的处理留给
 * 调用方——路由跳过这家、创建任务时 400，而不是在这里静默降级。
 */
export function normalizeUpResolution(
  requested: Resolution | undefined,
  supported: readonly Resolution[],
): Resolution | undefined {
  if (!supported.length) return undefined;
  const sorted = [...supported].sort((a, b) => resolutionRank(a) - resolutionRank(b));
  if (!requested) return undefined;
  const wanted = resolutionRank(requested);
  return sorted.find((r) => resolutionRank(r) >= wanted);
}

/** 这个支持列表里有没有一档接得下请求（= 有不低于它的一档）。 */
export function servesResolution(
  requested: Resolution | undefined,
  supported: readonly Resolution[],
): boolean {
  if (!requested) return true;
  return Boolean(normalizeUpResolution(requested, supported));
}
