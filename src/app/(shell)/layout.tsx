import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GeniusShell } from "@/components/genius/GeniusShell";
import { harnessEnabled, isMockMode, klingVideoModel, openaiImageModel, ymanImageModel, ymanT2vModel } from "@/lib/env";
import {
  audioAvailableFor,
  imageAspectRatios,
  uiProviderId,
  videoAspectRatios,
  videoDurationsFor,
} from "@/lib/providers/router";
import { listJobRecordsForUser, toPublic } from "@/lib/jobs/store";
import { SESSION_COOKIE, sessionUserFromValue } from "@/lib/users/session";

export const dynamic = "force-dynamic";

/**
 * 五个视图共用的壳（方案 `docs/plan-ui-genius-app.md` §2）。承接旧 `src/app/page.tsx`
 * 的全部服务端职责：
 *
 * - `/…` 是页面不是 `/api/*`，`src/proxy.ts` 看不见，所以会话校验必须在这里做，
 *   也是 `ownerId` 被honour的第五处（plan-users-quota §5.1）；`redirect` 会抛，
 *   往下走的一定有 user。
 * - provider 能力（时长 / 画幅 / 有无音轨 / 模型名）浏览器看不见环境变量，在这里解析
 *   一次下发，与 `/api/health` 同源。
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const user = await sessionUserFromValue(store.get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const recs = await listJobRecordsForUser(user.id);
  // `uiProviderId` 而不是 `currentProviderId`：全家被判定积分耗尽时后者会 503（提交必须
  // 被拒），但壳不能因此整页 500——用户还得能看见自己的作品。
  const videoProvider = uiProviderId("text_to_video");
  const imageProvider = uiProviderId("text_to_image");
  return (
    <GeniusShell
      caps={{
        mock: isMockMode(),
        harness: harnessEnabled(),
        // 时长档由 provider 能力决定（可灵 5/10、YMan 看所选模型、grok/mock 4/6/8/10），
        // 芯片得跟着变，用户看到的才是会被计费的那个时长。
        videoDurations: [...videoDurationsFor(videoProvider)],
        // 画幅取**并集**：只要 ORDER 里有一家接得下 1:1，这个格子就该露出来。
        videoAspectRatios: videoAspectRatios(),
        // 文生图的画幅与视频**完全无关**：三条生图通道都能出全部七个，共用视频那份并集会
        // 让一台只配了 16:9/9:16 视频模型的实例把文生图的 4:3 / 3:2 一起吞掉。
        imageAspectRatios: imageAspectRatios(),
        videoModel: videoModelName(videoProvider),
        imageModel: imageModelName(imageProvider),
        // 出不出声由 provider 能力说了算；不支持时开关标「暂不可用」而不是藏起来。
        audioAvailable: audioAvailableFor(videoProvider),
        initialJobs: recs.slice(0, 40).map(toPublic),
        initialEmail: user.email,
      }}
    >
      {children}
    </GeniusShell>
  );
}

/** 面板上的模型读数。只是展示，跟着当前 provider 走（schema 里没有 model 字段）。 */
function videoModelName(providerId: ReturnType<typeof uiProviderId>): string {
  if (providerId === "kling") return klingVideoModel();
  if (providerId === "yman") return ymanT2vModel();
  return "grok-imagine-video";
}

function imageModelName(providerId: ReturnType<typeof uiProviderId>): string {
  if (providerId === "openai") return openaiImageModel();
  if (providerId === "yman") return ymanImageModel();
  return "grok-imagine-image";
}
