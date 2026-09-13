import { jsonError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { relayHeaders } from "@/lib/providers/relay/client";
import { fetchUpstream } from "@/lib/providers/grok/client";
import { relayViewFor } from "@/lib/providers/relay/live";
import { ProviderHttpError } from "@/lib/providers/types";
import { withRequestContext } from "@/lib/request-context";

export const runtime = "nodejs";

/**
 * `POST /api/admin/relays/:id/probe`：直连探针，**不落任务、不记账**
 * （`billed:false`——探针本身可能在上游计费，但本项目账目不记）。
 * 有生图通道 → 一张 1K 1:1；否则 → chat 一句。返回耗时与 HTTP 状态。
 */
async function probe(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
    const { id } = await ctx.params;
    const view = relayViewFor(id);
    if (!view) {
      throw new ProviderHttpError(404, "not_found", `relay ${id} 不存在`);
    }
    if (!view.apiKey()) {
      throw new ProviderHttpError(400, "missing_api_key", `缺少 ${view.keyEnvName}`);
    }

    let path: string;
    let body: Record<string, unknown>;
    let kind: "image" | "chat";
    if (view.image) {
      kind = "image";
      path = "/images/generations";
      body = {
        model: view.image.model(),
        prompt: "lumen relay probe",
        size: "1024x1024",
        quality: view.image.shape().quality,
        n: 1,
      };
    } else {
      const model = view.chatModel();
      if (!model) {
        throw new ProviderHttpError(
          400,
          "no_probe_channel",
          `relay ${id} 既没有生图通道也没配 chat 模型，无法探测`,
        );
      }
      kind = "chat";
      path = "/chat/completions";
      body = { model, messages: [{ role: "user", content: "ping" }], max_tokens: 16 };
    }

    const started = Date.now();
    const res = await fetchUpstream(`${view.base()}${path}`, {
      method: "POST",
      headers: relayHeaders(view, true),
      body: JSON.stringify(body),
    }, { maxAttempts: 1 });
    const ms = Date.now() - started;
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errMsg =
      parsed && typeof parsed.error === "object" && parsed.error
        ? (parsed.error as Record<string, unknown>).message
        : undefined;
    return Response.json({
      ok: res.ok,
      kind,
      status: res.status,
      ms,
      billed: false,
      detail: res.ok
        ? "ok"
        : typeof errMsg === "string" && errMsg
          ? errMsg
          : `HTTP ${res.status}`,
    });
  } catch (e) {
    return jsonError(e);
  }
}

export const POST = withRequestContext(probe);
