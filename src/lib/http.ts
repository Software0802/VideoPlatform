import { ZodError } from "zod";
import { ProviderHttpError } from "@/lib/providers/types";

export function jsonError(e: unknown) {
  if (e instanceof ProviderHttpError) {
    return Response.json(
      { error: { code: e.code, message: e.message } },
      { status: e.status },
    );
  }
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const where = first?.path?.length ? first.path.join(".") : "";
    const message = where ? `请求参数不合法: ${where}` : "请求参数不合法";
    return Response.json({ error: { code: "invalid_argument", message } }, { status: 400 });
  }
  if (e instanceof SyntaxError) {
    return Response.json(
      { error: { code: "invalid_argument", message: "请求体必须是合法 JSON" } },
      { status: 400 },
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  const status =
    msg.includes("HARNESS") || msg.includes("尚未开放") || msg.includes("不能") || msg.includes("需要")
      ? 400
      : 500;
  return Response.json({ error: { code: "internal", message: msg } }, { status });
}
