import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LumenHome } from "@/components/lumen/LumenHome";
import { harnessEnabled, isMockMode, klingVideoModel, ymanT2vModel } from "@/lib/env";
import {
  audioAvailableFor,
  currentProviderId,
  videoAspectRatios,
  videoDurationsFor,
} from "@/lib/providers/router";
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
      // 时长枚举由 provider 能力决定（可灵 5/10、YMan 看所选模型、grok/mock 4/6/8/10），
      // 芯片得跟着变，用户看到的才是会被计费的那个时长。浏览器看不见 YMAN_T2V_MODEL
      // 之类的变量，所以在这里解析一次下发（与 /api/health 的 videoDurations 同源）。
      videoDurations={[...videoDurationsFor(videoProvider)]}
      // 画幅芯片同理，但取的是**并集**而不是第一顺位那一家：只要 ORDER 里有一家接得下
      // 1:1，这个芯片就该露出来（提交时路由会把它交给那一家）；一家都接不下就从芯片上
      // 消失，而不是让用户选一个提交必 400 的画幅。与 /api/health 的同名字段同源。
      videoAspectRatios={videoAspectRatios()}
      videoModel={videoModelName(videoProvider)}
      // 实例出不出声由 provider 能力说了算（可灵看 KLING_VIDEO_AUDIO，YMan 根本没有音频
      // 参数）。不下发的话用户能选「有声」、被按有声估价，却拿到一段无声视频；所以能力在
      // 这里判定一次，不支持时芯片显示「暂不可用」而不是藏起来（与 /api/health 同源）。
      audioAvailable={audioAvailableFor(videoProvider)}
      initialJobs={recs.slice(0, 40).map(toPublic)}
      initialEmail={user.email}
    />
  );
}

/** 工作室读数里的模型名。只是展示，跟着当前 provider 走。 */
function videoModelName(providerId: ReturnType<typeof currentProviderId>): string {
  if (providerId === "kling") return klingVideoModel();
  if (providerId === "yman") return ymanT2vModel();
  return "grok-imagine-video";
}
