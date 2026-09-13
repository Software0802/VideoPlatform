import { ProviderHttpError } from "@/lib/providers/types";

/**
 * 「这次提交确定没被受理」的判定（方案 §4c 资金不变量）。
 *
 * 换家只在确定拒绝上发生：被拒的 submit 没有计费，交给下一家是同一次任务换个门；
 * 而「可能已受理」的失败（读超时、中途断连、裸 5xx）重发 = 同一条片子付两次钱，
 * 那一类走 `uncertain_submit`，绝不换家。
 *
 * 确定拒绝的判定：
 *  - 4xx 且不是参数类错误——鉴权 401/403、404 模型不存在、`quota_exhausted`、
 *    `rate_limited` 都是上游审过请求之后的明确答复。参数类错误（`invalid_argument` /
 *    `unsupported_mode` / `insufficient_balance`）换家也只会撞同一堵墙，按原错失败；
 *  - `upstreamRejected`：结构化 5xx 错误体（openai-image 通道打标），已确定没受理；
 *  - `upstream_unavailable` 且 `phase === "connect"`：ECONNREFUSED / ENOTFOUND，
 *    连接没建起来，请求不可能送达。
 *
 * 读超时（`upstream_timeout` / `phase:"read"`）、无 phase 的连接失败、裸 5xx 全部
 * 不在此列——那是「可能已受理」的一侧。
 */
export function isCertainRejection(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.upstreamRejected) return true;
  if (error.status >= 400 && error.status < 500) {
    return !PARAMETER_REJECTION_CODES.has(error.code);
  }
  if (error.code === "upstream_unavailable" && error.phase === "connect") return true;
  return false;
}

/**
 * 参数类拒绝：错误在请求内容本身，换一家上游得到的答复一样，不换家也不重试。
 * `insufficient_balance` 列在这里是沿用现有语义——它表示*我们给上游的*余额参数
 * 被拒（与 `quota_exhausted` 的平台额度耗尽是两回事），换家语义不成立。
 */
const PARAMETER_REJECTION_CODES: ReadonlySet<string> = new Set([
  "invalid_argument",
  "unsupported_mode",
  "insufficient_balance",
]);

/**
 * 「提交结果不确定」的失败（R06）：上游可能已经把这条请求接走了。
 *
 * 上游给过确定答复的失败——参数不对、鉴权拒绝、限流、余额——都是 4xx，那时 POST 没有
 * 被接受、没有被计费，照原路重发或换家即可。拿不准的只有两类：我们自己合成的超时 /
 * 断连（`upstream_timeout` / 无 `phase:"connect"` 标的 `upstream_unavailable`，请求
 * 可能已送达）和上游的裸 5xx（服务端内部错，单子可能已经建出来）。把它们当「确定
 * 失败」重发 = 同一条片子付两次钱。
 *
 * 例外：`missing_api_key` 抛在请求发出之前；`mock_failure` 是测试替身模拟的「上游明确
 * 拒收」。非 ProviderHttpError 是普通内部错误（rest-map 校验、读盘失败），同样确定。
 */
const CERTAIN_SUBMIT_FAILURE_CODES = new Set(["missing_api_key", "mock_failure"]);

export function isAmbiguousSubmitError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (isCertainRejection(error)) return false;
  if (error.status < 500) return false;
  // 结构化错误体 = 上游明确拒单，确定没受理没计费（openai-image 通道打这个标记）。
  if (error.upstreamRejected) return false;
  return !CERTAIN_SUBMIT_FAILURE_CODES.has(error.code);
}
