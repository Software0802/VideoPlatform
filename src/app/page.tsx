import { cookies } from "next/headers";
import { LumenHome } from "@/components/lumen/LumenHome";
import { harnessEnabled, isMockMode } from "@/lib/env";
import { listJobRecordsForUser, toPublic } from "@/lib/jobs/store";
import { SESSION_COOKIE, sessionUserFromValue } from "@/lib/users/session";

export const dynamic = "force-dynamic";

/**
 * `/` is a page, not `/api/*`, so `src/proxy.ts` never sees it. The initial job
 * list is server-rendered into the payload, which makes this the fifth place
 * `ownerId` has to be honoured (plan §5.1): a signed-out visitor gets nothing,
 * and the shell falls back to its sample works. Redirecting to a login page
 * comes with that page (plan §7).
 */
export default async function Home() {
  const store = await cookies();
  const user = await sessionUserFromValue(store.get(SESSION_COOKIE)?.value);
  const recs = user ? await listJobRecordsForUser(user.id) : [];
  return <LumenHome mock={isMockMode()} harness={harnessEnabled()} initialJobs={recs.slice(0, 40).map(toPublic)} />;
}
