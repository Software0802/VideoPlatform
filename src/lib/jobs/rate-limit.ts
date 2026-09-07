import { consumeRateLimit, type RateLimitResult } from "@/lib/users/rate-limit";

/**
 * 「每人每分钟能创建多少个生成任务」这一个桶（方案 §3.2「安全收口」）。
 *
 * 与余额、配额、在途上限各管一件事：余额管「一共能花多少钱」，在途上限管「同时能占
 * 几个执行槽」，这一条管「按键的速度」——它挡的是脚本，而脚本正是把前两条一次性撞满
 * 的东西。键只按用户不按 IP：会话已经把请求绑到账号上了，再按 IP 分桶只会误伤同一个
 * 出口后面的几个人。
 *
 * 放在 lib 而不是 `src/app/api/jobs/route.ts` 里，是因为 App Router 的路由文件只允许
 * 导出它认识的那几个名字，多导一个常量就会在构建时被判成非法的 Route 导出——而这个桶
 * 必须被两个入口共用：`POST /api/jobs` 与智能体（`src/lib/agent/run-turn.ts`，它绕过
 * HTTP 直接调 `createJob`）。两处各写一份限流的话，「让智能体替我一次开二十条」就是
 * 现成的绕过路径。
 */
export const JOBS_RATE_LIMIT = 10;

/** 消费一次该用户的任务创建配额。返回值原样带着 `retryAfterSec`，好组装 429 的文案。 */
export function consumeJobCreation(userId: string): RateLimitResult {
  return consumeRateLimit([`jobs:user:${userId}`], { limit: JOBS_RATE_LIMIT });
}
