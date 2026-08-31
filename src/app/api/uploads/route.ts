import { jsonError } from "@/lib/http";
import { handleUpload } from "@/lib/jobs/upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const side = await handleUpload(request);
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
