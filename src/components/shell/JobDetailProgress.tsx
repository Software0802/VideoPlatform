"use client";

import { useCallback, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { AccessTokenPrompt } from "./AccessTokenPrompt";
import { JobProgress } from "@/components/studio/JobProgress";

/** Keeps direct job-detail links usable when the optional access gate is on. */
export function JobDetailProgress({ initial }: { initial: JobPublic }) {
  const [authRequired, setAuthRequired] = useState(false);
  const requireAuth = useCallback(() => setAuthRequired(true), []);
  return (
    <>
      <JobProgress initial={initial} onUnauthorized={requireAuth} />
      {authRequired ? <AccessTokenPrompt onAuthorized={() => setAuthRequired(false)} /> : null}
    </>
  );
}
