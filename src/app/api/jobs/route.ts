import { jsonError } from "@/lib/http";
import { createJob } from "@/lib/jobs/create";
import { createJobBodySchema } from "@/lib/jobs/schema";
import { listJobRecords, toPublic } from "@/lib/jobs/store";

export const runtime = "nodejs";

export async function GET() {
  const recs = await listJobRecords();
  return Response.json(recs.slice(0, 50).map(toPublic));
}

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const body = createJobBodySchema.parse(json);
    const { job, replay } = await createJob(body);
    return Response.json(job, { status: replay ? 200 : 201 });
  } catch (e) {
    return jsonError(e);
  }
}
