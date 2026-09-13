/*
  四个壳域（`SessionProvider` / `NoticesProvider` / `JobsProvider` / `ComposerProvider`）
  共用的常量与类型。原 `ShellContext.tsx` 的逐字搬迁；`ShellContext.tsx` 仍 re-export
  全部名字，外部 import 路径不变。
*/

import type { JobPublic } from "@/lib/jobs/schema";
import type { ImageResolution, Resolution } from "@/lib/providers/types";
import type { JobKind } from "@/lib/client/jobs";
import type { MessageKey } from "@/lib/i18n/messages";

/* ── 常量 ── */

/** 面板三个标签页。音频整页置灰（后端没有这条路径）。标签文案存键名，渲染时 `t()`。 */
export const COMPOSER_TABS = [
  { id: "video", labelKey: "common.video" },
  { id: "image", labelKey: "common.image" },
  { id: "audio", labelKey: "common.audio" },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];
export type ComposerTab = (typeof COMPOSER_TABS)[number]["id"];

/**
 * 视频页的模式行。后端接得住的是「图文」（空槽 = 文生视频、有图 = 图生视频）、
 * 「参考」（`reference_to_video`）与「首尾帧」（`image_to_video` + 尾帧），后两者还要
 * 当前产品声明了对应能力；其余按用户 2026-09-06 的决定「画出来但置灰」，点击提示
 * 「即将上线」。
 *
 * id 是 ASCII 内部标识（多语言：显示名在字典里，见 `VIDEO_MODE_KEY`）——它同时是
 * `pickMode` / `nativeMode` 的判据，不能跟着语言变。
 */
export const VIDEO_MODES = [
  "prompt",
  "reference",
  "template",
  "firstLast",
  "edit",
  "motion",
  "extend",
  "voice",
] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

export const VIDEO_MODE_KEY: Record<VideoMode, MessageKey> = {
  prompt: "composer.mode.prompt",
  reference: "composer.mode.reference",
  template: "composer.mode.template",
  firstLast: "composer.mode.firstLast",
  edit: "composer.mode.edit",
  motion: "composer.mode.motion",
  extend: "composer.mode.extend",
  voice: "composer.mode.voice",
};

/** 芯片上的分辨率文案（后端枚举是小写的那份）。 */
export const RES_LABEL: Record<Resolution, string> = { "480p": "480P", "720p": "720P", "1080p": "1080P" };
export const IMAGE_RES_LABEL: Record<ImageResolution, string> = { "1k": "1K", "2k": "2K" };

/** 数量芯片的档位。一次提交 = n 条独立任务，各自一个幂等 key。 */
export const COUNTS = [1, 2, 3, 4] as const;
export const MAX_COUNT = 4;

/** 「加载更多」一次拉多少条（与 SSR 首屏的 40 同档）。 */
export const JOBS_PAGE = 40;

/**
 * 铃铛面板一次列几条（交接：点开列最近 10 条）。
 *
 * H1 起 `notices` 里存的是服务端同步下来的**全量**（≤200 条）——本地持有全量，
 * 「打开铃铛 = 全部已读」的 `upToSeq` 才能盖住没显示出来的部分；渲染仍只取前
 * `MAX_NOTICES` 条（TopBar 里 slice）。
 */
export const MAX_NOTICES = 10;

/** ¥1 = 100 积分（用户 2026-09-06 拍板的换算口径），余额模型与后端计费不变。 */
export const creditsOf = (cny: number): number => Math.round((Number.isFinite(cny) ? cny : 0) * 100);

/* ── 类型 ── */

export type ShellCaps = {
  mock: boolean;
  harness: boolean;
  videoDurations?: number[];
  videoResolutions?: string[];
  videoAspectRatios?: string[];
  imageAspectRatios?: string[];
  videoModel: string;
  imageModel: string;
  audioAvailable: boolean;
  initialEmail: string;
  initialJobs: JobPublic[];
  /**
   * SSR 只下发前 40 条，这个标记说「盘上还有更老的」。没有它前端无从判断首屏之后
   * 该不该露出「加载更多」——只能先发一次注定空手而归的请求。
   */
  moreJobs: boolean;
};

/** 一个图片槽：本地 / 远端预览 + 上传后的 uploadId（请求体只接受服务端发的 id） */
export type Frame = { preview: string; uploadId: string | null; state: "busy" | "ready" | "error"; message?: string };

/** 图片槽的去向。素材弹窗要知道这次选的图往哪个槽里放。 */
export type SlotTarget = "start" | "last" | "reference";

export type Pop = null | "specs" | "model" | "count" | "buddy" | "picker";

/**
 * 一条「任务完成」通知。两个来源（H1）：
 *  - 服务端落盘的通知文件（`GET /api/notifications` 全量同步，刷新 / 换设备后仍在）；
 *  - 账号级事件流里**观察到的**「非终态 → 终态」那一跳即时插入——toast 等不了下一次
 *    同步。随后那次 `syncNotifications` 会用服务端结果整体覆盖（去重键 `id`）。
 */
export type Notice = {
  /** jobId + 终态，同一条任务的同一次完成只入队一次 */
  id: string;
  jobId: string;
  ok: boolean;
  title: string;
  /** 成功时是提示词摘要，失败时是服务端给的原因 */
  detail: string;
  at: string;
};

/** 一条任务算视频还是图片（与 `GET /api/jobs?kind=` 同口径：看 mode，不看有没有产物）。 */
export const kindOfJob = (job: JobPublic): JobKind => (job.mode === "text_to_image" ? "image" : "video");
