import type { JobRecord } from "@/lib/jobs/schema";
import { readJob } from "@/lib/jobs/store";
import { verifyShareToken } from "@/lib/share/token";

/**
 * 公开分享页与公开媒体流共用的那一段：验签 → 读任务 → 判「现在还能不能分享」。
 *
 * 三条路径（`/s/<token>` 页面、`GET /api/share/<token>`、`.../media`）必须给出**同一个**
 * 答案，否则会出现「页面打得开、视频 404」这种半可见状态，所以判据只写一份。
 */

/** 可分享 = 出片成功、产物还在、且真的有成片。 */
export function isShareable(rec: JobRecord): boolean {
  return rec.status === "succeeded" && !rec.artifactsPurgedAt && Boolean(rec.output);
}

/**
 * 令牌对应的任务，任何一步不对都返回 null（调用方一律 404）。
 *
 * `ownerId` 要和签发时一致：这既让「无主的老任务」永远分享不出去（令牌里的 ownerId 必是
 * 合法用户 id），也让任务换了主人时旧链接自动失效。
 *
 * 用 `readJob` 而不是 `readJobForUser`：这条路径上没有会话，令牌本身就是授权凭据；
 * 权限判定在上一行的 ownerId 比对，不是在会话上。
 */
export async function resolveSharedJob(
  token: string,
  nowMs: number = Date.now(),
): Promise<JobRecord | null> {
  const claims = verifyShareToken(token, nowMs);
  if (!claims) return null;
  const rec = await readJob(claims.jobId);
  if (!rec || rec.ownerId !== claims.ownerId) return null;
  return isShareable(rec) ? rec : null;
}

/** 分享页展示的提示词：前 80 字（码点），够看出这是什么片，又不至于把长 prompt 全抄出去。 */
export function sharePromptPreview(prompt: string): string {
  const chars = [...prompt.trim()];
  return chars.length <= 80 ? chars.join("") : `${chars.slice(0, 80).join("")}…`;
}
