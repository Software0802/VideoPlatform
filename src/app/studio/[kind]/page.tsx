import { notFound, redirect } from "next/navigation";
import { StudioShell } from "@/components/shell/StudioShell";
import { forceMock, grokUpstreamKind, hasXaiKey, isMockMode } from "@/lib/env";
import { listJobRecords, toPublic } from "@/lib/jobs/store";
import { isStudioKind } from "@/lib/studio-kind";

export const dynamic = "force-dynamic";

export default async function StudioKindPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ prompt?: string | string[] }>;
}) {
  const { kind } = await params;
  if (!isStudioKind(kind)) notFound();
  if (kind === "audio") redirect("/studio/video");
  const raw = (await searchParams).prompt;
  const prompt = (Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")).slice(0, 2000);
  const recs = await listJobRecords();
  const mock = isMockMode();
  const mockReason = mock && forceMock() && hasXaiKey() ? "forced" : "missing-key";
  return (
    <StudioShell
      kind={kind}
      initialPrompt={prompt}
      mock={mock}
      mockReason={mock ? mockReason : undefined}
      upstream={mock ? "mock" : grokUpstreamKind()}
      initialJobs={recs.slice(0, 20).map(toPublic)}
    />
  );
}
