import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LumenHome } from "@/components/lumen/LumenHome";
import { harnessEnabled, isMockMode } from "@/lib/env";
import { listJobRecordsForUser, toPublic } from "@/lib/jobs/store";
import { SESSION_COOKIE, sessionUserFromValue } from "@/lib/users/session";

export const dynamic = "force-dynamic";

/**
 * `/` is a page, not `/api/*`, so `src/proxy.ts` never sees it. The initial job
 * list is server-rendered into the payload, which makes this the fifth place
 * `ownerId` has to be honoured (plan §5.1) — and now the place a signed-out
 * visitor is turned away, because the studio has nothing to show them
 * (plan §7). `redirect` throws, so everything below it has a user.
 *
 * The email is handed to the shell so the top bar is right on the first paint;
 * the client still reads `GET /api/me` for the quota line.
 */
export default async function Home() {
  const store = await cookies();
  const user = await sessionUserFromValue(store.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const recs = await listJobRecordsForUser(user.id);
  return (
    <LumenHome
      mock={isMockMode()}
      harness={harnessEnabled()}
      initialJobs={recs.slice(0, 40).map(toPublic)}
      initialEmail={user.email}
    />
  );
}
