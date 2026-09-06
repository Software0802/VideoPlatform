import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LumenHome } from "@/components/lumen/LumenHome";
import { harnessEnabled, isMockMode, klingVideoAudio, klingVideoModel } from "@/lib/env";
import { currentProviderId } from "@/lib/providers/router";
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
  const videoProvider = currentProviderId("text_to_video");
  return (
    <LumenHome
      mock={isMockMode()}
      harness={harnessEnabled()}
      // 与 /api/health 的 videoProvider 同一个判据；可灵的时长枚举只有 5 / 10，
      // 芯片得跟着变，用户看到的才是会被计费的那个时长。
      videoProvider={videoProvider}
      videoModel={videoProvider === "kling" ? klingVideoModel() : "grok-imagine-video"}
      // 可灵实例出不出声由 KLING_VIDEO_AUDIO 说了算，浏览器看不见那个变量。不下发的话
      // 用户能选「有声」、被按有声估价，却拿到一段无声视频；所以能力在这里判定一次，
      // 不支持时芯片显示「暂不可用」而不是藏起来（与 /api/health 的 audioAvailable 同源）。
      audioAvailable={videoProvider === "kling" ? klingVideoAudio() === "native" : true}
      initialJobs={recs.slice(0, 40).map(toPublic)}
      initialEmail={user.email}
    />
  );
}
