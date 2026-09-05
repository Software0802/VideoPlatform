import { jsonError } from "@/lib/http";
import { createJob } from "@/lib/jobs/create";
import { createJobBodySchema } from "@/lib/jobs/schema";
import { listJobRecordsForUser, toPublic } from "@/lib/jobs/store";
import { requireUser } from "@/lib/users/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const recs = await listJobRecordsForUser(user.id);
    return Response.json(recs.slice(0, 50).map(toPublic));
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const json = await request.json();
    const body = createJobBodySchema.parse(json);
    const { job, replay } = await createJob(body, user.id);
    return Response.json(job, { status: replay ? 200 : 201 });
  } catch (e) {
    return jsonError(e);
  }
}
