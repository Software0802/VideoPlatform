import { LumenHome } from "@/components/lumen/LumenHome";
import { isMockMode } from "@/lib/env";
import { listJobRecords, toPublic } from "@/lib/jobs/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const recs = await listJobRecords();
  return <LumenHome mock={isMockMode()} initialJobs={recs.slice(0, 40).map(toPublic)} />;
}
