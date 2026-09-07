import { ProviderHttpError } from "@/lib/providers/types";
import { consumeRateLimit } from "@/lib/users/rate-limit";

/**
 * 每人每分钟能发几轮（方案 §1）。一轮 = 一次计费的 LLM 调用 + 最多两条生成任务，
 * 和 `POST /api/jobs` 的 10 次/分钟是同一类闸门：挡的是脚本，不是人。
 * 键只按用户不按 IP——会话已经把请求绑到账号上了，再按 IP 分桶只会误伤同一个出口
 * 后面的几个人。
 *
 * 开新会话与续一轮共用同一个桶：两者花的钱一模一样，分成两个桶等于把上限翻倍。
 * 放在 lib 而不是某个 `route.ts` 里，是因为 App Router 的路由文件只允许导出它认识的
 * 那几个名字，多导一个常量就会在构建时被判成非法的 Route 导出。
 */
export const AGENT_RATE_LIMIT = 20;

export function assertAgentRate(userId: string): void {
  const gate = consumeRateLimit([`agent:user:${userId}`], { limit: AGENT_RATE_LIMIT });
  if (!gate.allowed) {
    throw new ProviderHttpError(429, "rate_limited", `发送过于频繁，请 ${gate.retryAfterSec} 秒后再试`);
  }
}
