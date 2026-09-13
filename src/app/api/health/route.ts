import { constants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";
import { notifyAlert } from "@/lib/alerts";
import { buildInfo } from "@/lib/build-info";
import {
  DISK_FREE_PCT_FLOOR,
  dataDir,
  grokUpstreamKind,
  harnessEnabled,
  hasKlingKey,
  hasXaiKey,
  hasYmanKey,
  isMockMode,
  xaiBase,
} from "@/lib/env";
import { assertFfmpeg, ffmpegBinary } from "@/lib/ffmpeg";
import { queueStats, runnerStarted } from "@/lib/jobs/active";
import { admissionStats } from "@/lib/jobs/admission";
import { exhaustedList, healthList } from "@/lib/providers/health";
import { mockHasFont } from "@/lib/providers/mock";
import {
  audioAvailableFor,
  effectiveVideoProviderOrder,
  imageAspectRatios,
  uiProviderId,
  videoAspectRatios,
  videoDurationsFor,
  videoResolutions,
} from "@/lib/providers/router";
import { withRequestContext } from "@/lib/request-context";
import { sessionUser } from "@/lib/users/session";

export const runtime = "nodejs";

type DiskStatus = {
  freeBytes: number | null;
  freePct: number | null;
};

/**
 * `DATA_DIR` 所在卷的剩余空间。
 *
 * 用 `bavail`（非特权进程真正能用的块）而不是 `bfree`：ext4 默认给 root 留 5%，
 * 按 `bfree` 算会在服务已经写不下东西时仍然报「还剩 5%」。
 * 取不到（不支持 statfs 的文件系统 / 目录不存在）时回 null——「不知道」不能被当成
 * 「磁盘满了」而把整个实例判成不健康。
 */
async function diskStatus(dir: string): Promise<DiskStatus> {
  try {
    const fs = await statfs(dir);
    const total = Number(fs.blocks) * Number(fs.bsize);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) {
      return { freeBytes: null, freePct: null };
    }
    return { freeBytes: Math.round(free), freePct: Math.round((free / total) * 1000) / 10 };
  } catch {
    return { freeBytes: null, freePct: null };
  }
}

/**
 * 健康检查（方案 §3.2「安全收口」「可观测性」）。
 *
 * **匿名只回 `{ ok }`**：其余字段是一份实例配置清单——用了哪几家上游、哪几家的 key
 * 在、哪家正被判定耗尽、队列有多深。它对运维有用，对踩点的人同样有用，而
 * `/api/health` 必须能被不带 Cookie 的监控探到。带会话就给全量，登录本身就是门槛。
 *
 * `ok` 的判据是「这台机器现在还能不能把一次任务做完并落盘」：ffmpeg 在、数据目录
 * 可写、mock 模式下字体在、磁盘还有余量。队列深度与 runner 状态**不**进 `ok`——
 * 它们是要人看一眼的读数，不是「应该把流量切走」的信号。
 */
async function handler(request: Request) {
  // 会话失效 / 未登录都只是「匿名」，不是错误：健康检查不该因为鉴权抛而变成 500。
  const viewer = await sessionUser(request).catch(() => null);

  let ffmpegPath: string | null = null;
  try {
    await assertFfmpeg();
    ffmpegPath = ffmpegBinary();
  } catch {
    ffmpegPath = null;
  }
  const fontOk = await mockHasFont();
  const mock = isMockMode();
  const dir = dataDir();
  let dataDirWritable = false;
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }
  const disk = await diskStatus(dir);
  const diskOk = disk.freePct === null || disk.freePct >= DISK_FREE_PCT_FLOOR;
  if (!diskOk) {
    // 去重键固定：磁盘满是一个持续状态，每次探测都发一遍等于把告警变成噪音。
    void notifyAlert(
      "disk_low",
      { dataDir: dir, freeBytes: disk.freeBytes, freePct: disk.freePct, floorPct: DISK_FREE_PCT_FLOOR },
      "disk_low",
    );
  }
  const queue = await queueStats();
  const ok = Boolean(ffmpegPath) && dataDirWritable && diskOk && (!mock || fontOk);

  if (!viewer) {
    return Response.json({ ok }, { status: ok ? 200 : 503 });
  }

  // 与首页同源，且同样用不抛的那个：健康检查在「全家耗尽」时必须还能回话，
  // 那正是最需要看 `exhausted` 这一段的时刻。
  const videoProvider = uiProviderId("text_to_video");
  return Response.json(
    {
      ok,
      // 发布指纹：deploy.sh 写入 BUILD_INFO.json；本地开发 / 旧部署没有该文件时为 null。
      // 对照 `git rev-parse HEAD` 即可确认线上跑的是哪个 commit（dirty:true 表示
      // 该包出自未提交的工作树，不等于 sha 对应的干净构建）。`build.node` 是
      // 构建机的 Node 版本，不是运行时版本。
      build: buildInfo(),
      mockMode: mock,
      harnessRunnable: harnessEnabled(),
      ffmpeg: { present: Boolean(ffmpegPath), path: ffmpegPath },
      mockFont: { present: fontOk },
      dataDirWritable,
      // `DATA_DIR` 所在卷的余量。低于 5% 时 `ok` 为假并发一条告警——成片落盘失败发生在
      // 钱已经花出去之后，比「服务 500」更贵。
      disk,
      // 队列积压：`queued` 是还没被拿起来的，`running` 是正在跑的（含长片各阶段）。
      // 两个数分开才看得出是并发不够还是上游慢。
      queue,
      // runner 的定时器 / 恢复流程有没有起来。false 意味着任务只会堆在 queued 里不动。
      runner: { started: runnerStarted() },
      // 文生视频这一刻真正会走的 provider（mock 模式下就是 "mock"）。
      videoProvider,
      // 路由的优先级列表（VIDEO_PROVIDER_ORDER 归一后的结果）。上面的 videoProvider
      // 只是这一刻文生视频的落点，排查「为什么走了这家」要看这条。
      videoProviderOrder: effectiveVideoProviderOrder(),
      // 首页时长芯片的档位，由 provider 能力决定（grok/mock 4/6/8/10、可灵 5/10、
      // YMan 看所选 t2v 模型）——与 `src/app/page.tsx` 下发的同名 prop 同一个判据。
      videoDurations: videoDurationsFor(videoProvider),
      // 首页画幅芯片的取值：ORDER 里所有有 key 的视频 provider 支持画幅的并集
      // （与 `src/app/page.tsx` 下发的同名 prop 同一个判据）。一家都接不下的画幅
      // 不会出现在芯片上，也不会被提交。
      videoAspectRatios: videoAspectRatios(),
      // 文生图的画幅芯片：恒定七个，与视频 provider 的能力无关（三条生图通道都能出）。
      // 与 `src/app/page.tsx` 下发的同名 prop 同源。
      imageAspectRatios: imageAspectRatios(),
      // 分辨率格子的取值：有 key、未耗尽的视频 provider 出得了的档位并集（2026-09-06 起
      // 用户选的分辨率不再被 env 覆盖，所以这条也是排查「为什么 1080p 提交被拒」的入口）。
      videoResolutions: videoResolutions(),
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
      // provider × 通道的健康态（ok / cooldown / half-open + 窗口成功率），
      // 耗尽是其中 `state:"cooldown"` 且 reason=quota_exhausted 的一档。
      providerHealth: healthList(),
      // 全站在途任务数，口径与 `MAX_QUEUED_JOBS` 的准入判据一致（= queued + running）。
      queued: queue.queued + queue.running,
      // 准入锁的等锁 / 持锁耗时（最近 256 次，最近邻分位）——F-09「准入 IO 随历史
      // 线性增长」的观测入口；`hold.p95Ms` 持续走高是 R4.2（SQLite 迁移）触发条件之一。
      // 进程启动后还没有过一次准入时为 null。
      admission: admissionStats(),
    },
    { status: ok ? 200 : 503 },
  );
}

export const GET = withRequestContext(handler);
