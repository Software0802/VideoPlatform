import { jsonError } from "@/lib/http";
import { onJob } from "@/lib/jobs/events";
import { readJobForUser, toPublic } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let rec;
  try {
    const user = await requireUser(request);
    rec = await readJobForUser(id, user.id);
  } catch (e) {
    return jsonError(e);
  }
  if (!rec) return Response.json({ error: { code: "not_found", message: "任务不存在" } }, { status: 404 });

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let off: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        off();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };
      const sendEvent = (type: string, job: unknown) => {
        send(`event: ${type}\ndata: ${JSON.stringify(job)}\n\n`);
      };
      off = onJob(id, ({ type, job }) => {
        sendEvent(type, job);
        if (["succeeded", "failed", "expired", "canceled"].includes(job.status)) {
          close();
        }
      });
      const ping = setInterval(() => send(": ping\n\n"), 15_000);
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener("abort", close);
      const snapshot = toPublic(rec);
      sendEvent("snapshot", snapshot);
      // A terminal job has no future event to wake this stream. Close it
      // immediately instead of keeping a heartbeat/listener alive for 15 min.
      if (["succeeded", "failed", "expired", "canceled"].includes(snapshot.status)) {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
