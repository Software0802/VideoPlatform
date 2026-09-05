import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dataDir, grokUpstreamKind, harnessEnabled, hasXaiKey, isMockMode, xaiBase } from "@/lib/env";
import { assertFfmpeg, ffmpegBinary } from "@/lib/ffmpeg";
import { activeCount } from "@/lib/jobs/runner";
import { mockHasFont } from "@/lib/providers/mock";

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
  const ok = Boolean(ffmpegPath) && dataDirWritable && (!mock || fontOk);
  return Response.json(
    {
      ok,
      mockMode: mock,
      harnessRunnable: harnessEnabled(),
      ffmpeg: { present: Boolean(ffmpegPath), path: ffmpegPath },
      mockFont: { present: fontOk },
      dataDirWritable,
      grokKeyPresent: hasXaiKey(),
      grokUpstream: isMockMode()
        ? null
        : { kind: grokUpstreamKind(), baseUrl: xaiBase() },
      queued,
    },
    { status: ok ? 200 : 503 },
  );
}
