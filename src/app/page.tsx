import { LumenHome } from "@/components/lumen/LumenHome";
import { harnessEnabled, isMockMode } from "@/lib/env";
import { listJobRecords, toPublic } from "@/lib/jobs/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const recs = await listJobRecords();
  return <LumenHome mock={isMockMode()} harness={harnessEnabled()} initialJobs={recs.slice(0, 40).map(toPublic)} />;
}
