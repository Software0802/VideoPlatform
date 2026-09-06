import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import {
  dataDir,
  grokUpstreamKind,
  harnessEnabled,
  hasKlingKey,
  hasXaiKey,
  isMockMode,
  klingVideoAudio,
  xaiBase,
} from "@/lib/env";
import { assertFfmpeg, ffmpegBinary } from "@/lib/ffmpeg";
import { activeCount } from "@/lib/jobs/runner";
import { mockHasFont } from "@/lib/providers/mock";
import { currentProviderId } from "@/lib/providers/router";

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
      // 文生视频这一刻真正会走的 provider（mock 模式下就是 "mock"）。首页的时长芯片
      // 按它决定是 4/6/8/10 还是可灵的 5/10。
      videoProvider,
      // 这一刻的视频 provider 会不会真的出音轨。可灵由 KLING_VIDEO_AUDIO 决定（默认 off，
      // 上游只在 1080p 出声），grok / mock 一直支持。首页的「有声 / 无声」芯片按它决定
      // 是可切换还是「暂不可用」——与 `src/app/page.tsx` 下发的同名 prop 同一个判据。
      audioAvailable: videoProvider === "kling" ? klingVideoAudio() === "native" : true,
      grokKeyPresent: hasXaiKey(),
      klingKeyPresent: hasKlingKey(),
      grokUpstream: isMockMode()
        ? null
        : { kind: grokUpstreamKind(), baseUrl: xaiBase() },
      queued,
    },
    { status: ok ? 200 : 503 },
  );
}
