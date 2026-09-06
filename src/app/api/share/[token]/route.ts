import { resolveSharedJob, sharePromptPreview } from "@/lib/share/resolve";

export const runtime = "nodejs";

/**
 * 公开的作品元信息（方案 §1.4）。`src/proxy.ts` 放行 `/api/share/*`：这条路径没有会话，
 * 令牌就是授权。
 *
 * 只回渲染播放页需要的几样东西。**不回** jobId、ownerId、邮箱、售价、provider、模型名
 * ——分享出去的是一段成片，不是一条任务记录。
 *
 * 验签失败 / 过期 / 任务已删 / 产物已清理，一律 404 且措辞相同：把这几种情况分开回答，
 * 等于告诉扫链接的人哪一段是对的。
 */
export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const rec = await resolveSharedJob(token);
  if (!rec || !rec.output) {
    return Response.json(
      { error: { code: "not_found", message: "链接已失效" } },
      { status: 404 },
    );
  }
  const output = rec.output;
  return Response.json(
    {
      kind: output.kind,
      mediaUrl: `/api/share/${encodeURIComponent(token)}/media`,
      prompt: sharePromptPreview(rec.prompt),
      productName: rec.productName ?? null,
      durationSec: output.kind === "video" ? (output.durationSec || rec.durationSec) : null,
    },
    {
      // 短缓存：元信息对同一条令牌是恒定的，而令牌到期后至多再多活一分钟。
      headers: { "Cache-Control": "public, max-age=60" },
    },
  );
}
