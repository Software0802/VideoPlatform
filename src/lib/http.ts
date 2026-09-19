import { ZodError } from "zod";
import { ProviderHttpError } from "@/lib/providers/types";

export function jsonError(e: unknown) {
  if (e instanceof ProviderHttpError) {
    // `publicFields` 是显式声明可以下发的那几个标量（重试新价、限流剩余秒数…）；
    // 没声明就还是老形状 `{code,message}`。
    return Response.json(
      { error: { code: e.code, message: e.message, ...(e.publicFields ?? {}) } },
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
