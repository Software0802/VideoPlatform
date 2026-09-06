import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import {
  dataDir,
  grokUpstreamKind,
  harnessEnabled,
  hasKlingKey,
  hasXaiKey,
  hasYmanKey,
  isMockMode,
  videoProviderOrder,
  xaiBase,
} from "@/lib/env";
import { assertFfmpeg, ffmpegBinary } from "@/lib/ffmpeg";
import { activeCount } from "@/lib/jobs/runner";
import { exhaustedList } from "@/lib/providers/exhaustion";
import { mockHasFont } from "@/lib/providers/mock";
import {
  audioAvailableFor,
  currentProviderId,
  videoAspectRatios,
  videoDurationsFor,
} from "@/lib/providers/router";

export const runtime = "nodejs";

export async function GET() {
  let ffmpegPath: string | null = null;
  try {
    await assertFfmpeg();
    ffmpegPath = ffmpegBinary();
  } catch {
    ffmpegPath = null;
  }
  const fontOk = await mockHasFont();
  const mock = isMockMode();
  let dataDirWritable = false;
  try {
    const dir = dataDir();
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }
  const queued = await activeCount();
  const videoProvider = currentProviderId("text_to_video");
  const ok = Boolean(ffmpegPath) && dataDirWritable && (!mock || fontOk);
  return Response.json(
    {
      ok,
      mockMode: mock,
      harnessRunnable: harnessEnabled(),
      ffmpeg: { present: Boolean(ffmpegPath), path: ffmpegPath },
      mockFont: { present: fontOk },
      dataDirWritable,
      // 文生视频这一刻真正会走的 provider（mock 模式下就是 "mock"）。
      videoProvider,
      // 路由的优先级列表（VIDEO_PROVIDER_ORDER 归一后的结果）。上面的 videoProvider
      // 只是这一刻文生视频的落点，排查「为什么走了这家」要看这条。
      videoProviderOrder: videoProviderOrder(),
      // 首页时长芯片的档位，由 provider 能力决定（grok/mock 4/6/8/10、可灵 5/10、
      // YMan 看所选 t2v 模型）——与 `src/app/page.tsx` 下发的同名 prop 同一个判据。
      videoDurations: videoDurationsFor(videoProvider),
      // 首页画幅芯片的取值：ORDER 里所有有 key 的视频 provider 支持画幅的并集
      // （与 `src/app/page.tsx` 下发的同名 prop 同一个判据）。一家都接不下的画幅
      // 不会出现在芯片上，也不会被提交。
      videoAspectRatios: videoAspectRatios(),
      // 这一刻的视频 provider 会不会真的**按我们的要求**出音轨。可灵由 KLING_VIDEO_AUDIO
      // 决定（默认 off，上游只在 1080p 出声）；YMan 的建任务接口根本没有音频参数，出不出声
      // 由模型自己决定，所以是「不可控」而不是「一定无声」——不可控就不能向用户收有声的
      // 加价，一律按无声记。grok / mock 一直支持。首页的「有声 / 无声」芯片按它决定是可切换
      // 还是「暂不可用」——与 `src/app/page.tsx` 下发的同名 prop 同一个判据。
      audioAvailable: audioAvailableFor(videoProvider),
      grokKeyPresent: hasXaiKey(),
      klingKeyPresent: hasKlingKey(),
      ymanKeyPresent: hasYmanKey(),
      grokUpstream: isMockMode()
        ? null
        : { kind: grokUpstreamKind(), baseUrl: xaiBase() },
      // 被判定「积分耗尽」而暂时绕开的上游（视频 / 图片分开记，到 until 自动恢复）。
      // 排查「为什么任务突然走了另一家」看这条。
      exhausted: exhaustedList(),
      queued,
    },
    { status: ok ? 200 : 503 },
  );
}
