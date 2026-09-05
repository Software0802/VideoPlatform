import { jsonError } from "@/lib/http";
import { handleUpload } from "@/lib/jobs/upload";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const side = await handleUpload(request, user.id);
    return Response.json({
      uploadId: side.uploadId,
      role: side.role,
      width: side.width,
      height: side.height,
      bytes: side.bytes,
      durationSec: side.durationSec,
    });
  } catch (e) {
    return jsonError(e);
  }
}
