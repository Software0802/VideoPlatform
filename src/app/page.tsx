import { StudioShell } from "@/components/shell/StudioShell";
import { forceMock, grokUpstreamKind, hasXaiKey, isMockMode } from "@/lib/env";
import { listJobRecords, toPublic } from "@/lib/jobs/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const recs = await listJobRecords();
  const mock = isMockMode();
  const mockReason = mock && forceMock() && hasXaiKey() ? "forced" : "missing-key";
  return (
    <StudioShell
      kind="video"
      mock={mock}
      mockReason={mock ? mockReason : undefined}
      upstream={mock ? "mock" : grokUpstreamKind()}
      initialJobs={recs.slice(0, 20).map(toPublic)}
    />
  );
}
