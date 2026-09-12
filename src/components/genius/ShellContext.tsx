"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { JobPublic } from "@/lib/jobs/schema";
import type { AspectRatio, ImageResolution, NativeMode, Resolution } from "@/lib/providers/types";
import { priceCny } from "@/lib/billing/prices";
import { HARNESS_DURATIONS } from "@/lib/providers/grok/mode-matrix";
import {
  cancelJob,
  createJob,
  deleteJob,
  fetchJob,
  fetchJobsPage,
  newIdempotencyKey,
  patchJobTags,
  reconcileJob,
  retryJob,
  uploadFile,
  uploadFromJob,
  type JobKind,
} from "@/lib/client/jobs";
import { fetchMe, logout, type MePublic } from "@/lib/client/auth";
import { fetchProducts, supportsMode, type Product } from "@/lib/client/models";
import type { Template } from "@/lib/client/templates";
import { useEvents } from "@/lib/client/useEvents";
import { useJobLive } from "@/lib/client/useJobLive";
import { isActive, isTerminal } from "@/lib/client/labels";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  Genius App 的唯一客户端状态所有者（方案 `docs/plan-ui-genius-app.md` §3）。
  主页与创作页共用同一个创作面板实例，所以面板状态必须挂在壳上而不是某个视图里；
  组件只经 `@/lib/client/*` 访问 `/api/*`，这里是它们唯一的调用处（AGENTS.md）。

  阶段 A 起，面板的可选项不再由「服务端下发的一组枚举」决定，而是由**当前选中的产品**
  （`/api/models`）决定：分辨率 / 画幅 / 时长 / 音轨 / 首尾帧 / 参考图上限全部来自
  `Product`。`/api/models` 拿不到时（老服务端、网络抖动）整套回落到 `caps.*` 下发的
  枚举，界面照常可用，只是参考 / 首尾帧两个模式保持置灰——宁可少露出一个功能，也不能
  让用户选一个提交必然 400 的东西。
*/

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

const ALL_RES: readonly Resolution[] = ["480p", "720p", "1080p"];
const ALL_IMAGE_RES: readonly ImageResolution[] = ["1k", "2k"];
const ALL_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
/** 服务端没下发画幅时的兜底（三家视频 provider 都接得下的那几个） */
const VIDEO_RATIO_FALLBACK: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];
/** 服务端没下发时长时的兜底（grok / mock 的档位） */
const DUR_FALLBACK = [4, 6, 8, 10] as const;
const DEFAULT_DUR = 5;
const DEFAULT_RES: Resolution = "720p";

/** 数量芯片的档位。一次提交 = n 条独立任务，各自一个幂等 key。 */
export const COUNTS = [1, 2, 3, 4] as const;
export const MAX_COUNT = 4;

/** 「加载更多」一次拉多少条（与 SSR 首屏的 40 同档）。 */
export const JOBS_PAGE = 40;

/** 通知面板最多留几条（交接：铃铛点开列最近 10 条）。 */
export const MAX_NOTICES = 10;

/** ¥1 = 100 积分（用户 2026-09-06 拍板的换算口径），余额模型与后端计费不变。 */
export const creditsOf = (cny: number): number => Math.round((Number.isFinite(cny) ? cny : 0) * 100);

/** 服务端下发的画幅里认得的那些；一个都不认得就用兜底表。 */
function usableRatios(given: string[] | undefined, fallback: readonly AspectRatio[]): readonly AspectRatio[] {
  const usable = (given ?? []).filter((r): r is AspectRatio => (ALL_RATIOS as readonly string[]).includes(r));
  return usable.length ? usable : fallback;
}

/** 同上，分辨率。 */
function usableRes(given: string[] | undefined): readonly Resolution[] {
  const usable = (given ?? []).filter((r): r is Resolution => (ALL_RES as readonly string[]).includes(r));
  return usable.length ? usable : ALL_RES;
}

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
 * 一条「任务完成」通知。只由账号级事件流（`GET /api/events`）里**观察到的**
 * 「非终态 → 终态」那一跳产生：页面加载时就已经是终态的任务不算，否则每次刷新都会被
 * 历史任务的通知糊一脸。
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

/** 列表恒按 createdAt 倒序；同一毫秒时按 id 兜底，保证顺序稳定（分页不会左右横跳）。 */
function byNewest(a: JobPublic, b: JobPublic): number {
  const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (d !== 0 && Number.isFinite(d)) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 追加一页：已在列表里的 id 保持原对象（那份可能正被 SSE / 轮询更新着），其余按时间插入。 */
function appendJobs(prev: JobPublic[], page: JobPublic[]): JobPublic[] {
  const known = new Set(prev.map((j) => j.id));
  const add = page.filter((j) => j && typeof j.id === "string" && !known.has(j.id));
  if (!add.length) return prev;
  return [...prev, ...add].sort(byNewest);
}

type Shell = {
  /* 能力与账号 */
  caps: ShellCaps;
  me: MePublic | null;
  email: string;
  credits: number | null;
  refreshMe: () => void;
  signOut: () => void;
  signingOut: boolean;

  /* 产品（`/api/models`） */
  products: Product[];
  /** 当前标签页下可选的产品（视频页只列 video、图片页只列 image） */
  productChoices: Product[];
  /** 当前生效的产品；`/api/models` 还没回来或这台实例没有该类产品时为 null */
  product: Product | null;
  pickProduct: (id: string) => void;

  /* 任务 */
  jobs: JobPublic[];
  currentJob: JobPublic | null;
  setCurrentJob: (job: JobPublic | null) => void;
  busy: boolean;
  working: boolean;
  cancel: () => void;
  retry: () => void;
  /** 核验上游（恢复中心）：仅 `retryBlocked.code === "uncertain_submit"` 时出现 */
  reconcile: () => void;

  /* 作品列表分页（`GET /api/jobs?before=&limit=&kind=`） */
  /** 这一类还有更老的没拉过来 */
  hasMoreJobs: (kind: JobKind) => boolean;
  loadMoreJobs: (kind: JobKind) => void;
  jobsLoading: boolean;
  /** 分页失败时的那句话；再点一次「加载更多」会清掉 */
  jobsError: string | null;

  /* 作品操作（详情浮层） */
  /** `PATCH /api/jobs/:id { tags }`，整组替换 */
  saveTags: (id: string, tags: string[]) => Promise<void>;
  /** `DELETE /api/jobs/:id`，成功后从列表里移除 */
  removeJob: (id: string) => Promise<void>;

  /* 面板 */
  open: boolean;
  openComposer: () => void;
  tab: ComposerTab;
  pickTab: (tab: ComposerTab) => void;
  mode: VideoMode;
  pickMode: (mode: VideoMode) => void;
  /** 这个模式此刻能不能用（产品能力 + 后端支持）。置灰项照常渲染。 */
  modeUsable: (mode: VideoMode) => boolean;
  collapsed: boolean;
  toggleCollapsed: () => void;
  pop: Pop;
  setPop: (pop: Pop) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  res: Resolution;
  setRes: (value: Resolution) => void;
  resolutions: readonly Resolution[];
  imageRes: ImageResolution;
  setImageRes: (value: ImageResolution) => void;
  imageResolutions: readonly ImageResolution[];
  ratio: AspectRatio;
  setRatio: (value: AspectRatio) => void;
  ratios: readonly AspectRatio[];
  /** 首尾帧模式不给选画幅（成片比例跟着两张帧走），规格芯片也不显示它。 */
  ratioUsable: boolean;
  dur: number;
  setDur: (value: number) => void;
  durs: readonly number[];
  audio: boolean;
  audioAvailable: boolean;
  toggleAudio: () => void;
  multi: boolean;
  toggleMulti: () => void;
  count: number;
  setCount: (value: number) => void;

  /* 图片槽 */
  image: Frame | null;
  lastImage: Frame | null;
  refs: Frame[];
  maxRefs: number;
  pickImage: (file: File | undefined) => void;
  pickLastImage: (file: File | undefined) => void;
  addRefImages: (files: FileList | File[] | null) => void;
  clearImage: () => void;
  clearLastImage: () => void;
  removeRef: (index: number) => void;
  clearAll: () => void;
  /** 素材弹窗当前服务的槽位 */
  slotTarget: SlotTarget;
  openPicker: (target: SlotTarget) => void;
  /** 「已创建」页签：把自己一条成功的图片任务认领成上传，填进当前槽位 */
  pickCreated: (job: JobPublic) => void;

  /* 提交 */
  nativeMode: NativeMode;
  price: number;
  sendCredits: number;
  balanceShort: boolean;
  quotaExhausted: boolean;
  error: string | null;
  /** 面板错误行的实际文案：`error`，或「按钮为什么是灰的」（余额 / 额度）。 */
  notice: string | null;
  setError: (value: string | null) => void;
  submit: () => void;
  /** 「用这条提示词再生成」：回填面板并展开 */
  reuse: (prompt: string, kind: "video" | "image") => void;
  /** 模板卡片：把预置的提示词与参数回填进面板并展开 */
  applyTemplate: (template: Template) => void;

  /* 置灰项的提示 */
  toast: string | null;
  showToast: (message: string) => void;

  /* 任务完成通知（账号级 SSE） */
  notices: Notice[];
  unread: number;
  markNoticesRead: () => void;
  /** 点通知：选中那条任务并跳创作页 */
  openNotice: (notice: Notice) => void;
  /** 右上角那一条（自动消失）；同时也在通知列表里 */
  noticeToast: Notice | null;
  dismissNoticeToast: () => void;
};

const Ctx = createContext<Shell | null>(null);

export function useShell(): Shell {
  const value = useContext(Ctx);
  if (!value) throw new Error("useShell 必须在 ShellProvider 内使用");
  return value;
}

// useJobLive 需要一个 job；没有任务时给它一个终态哑对象，effect 直接跳过
const NO_JOB = { id: "", status: "succeeded" } as const;

export function ShellProvider({ caps, children }: { caps: ShellCaps; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // 面板里的提示 / 错误 / toast 全部经字典（`I18nProvider` 挂在根布局，壳一定在它里面）。
  // `t` 随语言变，所以凡是把文案存进 state 的回调都要把它列进依赖。
  const t = useT();

  const [jobs, setJobs] = useState<JobPublic[]>(caps.initialJobs);
  /*
    「当前任务」不是一个纯粹的 state：冷加载 /create 时本会话还没提交过任何东西，但页面
    仍要把最新的一条当作当前任务（方案 §7.1 #8），所以生效值是「显式选中的那条 ?? 最新一条」。
    `pickedJob` 记显式选择（提交 / 点最近任务 / 轮询回写），`dismissed` 记「用户点了关闭」——
    没有它的话关闭会立刻被 jobs[0] 顶回来。jobs 由 store 按 createdAt 倒序下发，新任务 unshift。
  */
  const [pickedJob, setPickedJob] = useState<JobPublic | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const currentJob: JobPublic | null = pickedJob ?? (dismissed ? null : (jobs[0] ?? null));
  const setCurrentJob = useCallback((job: JobPublic | null) => {
    setPickedJob(job);
    setDismissed(job === null);
  }, []);
  const [me, setMe] = useState<MePublic | null>(null);
  const [meTick, setMeTick] = useState(0);
  const [signingOut, setSigningOut] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [videoProductId, setVideoProductId] = useState<string | null>(null);
  const [imageProductId, setImageProductId] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ComposerTab>("video");
  const [mode, setMode] = useState<VideoMode>("prompt");
  const [collapsed, setCollapsed] = useState(false);
  const [pop, setPop] = useState<Pop>(null);
  const [slotTarget, setSlotTarget] = useState<SlotTarget>("start");
  const [prompt, setPromptState] = useState("");
  const [resChoice, setResChoice] = useState<Resolution | null>(null);
  const [imageResChoice, setImageResChoice] = useState<ImageResolution | null>(null);
  const [audio, setAudio] = useState(true);
  const [multi, setMulti] = useState(true);
  const [count, setCountState] = useState(1);
  const [image, setImage] = useState<Frame | null>(null);
  const [lastImage, setLastImage] = useState<Frame | null>(null);
  const [refs, setRefs] = useState<Frame[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /* 分页：两类各一个游标与「还有没有」。首屏 40 条是混着的，所以初值都取服务端那个标记。 */
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [more, setMore] = useState<Record<JobKind, boolean>>({ video: caps.moreJobs, image: caps.moreJobs });
  const [cursor, setCursor] = useState<Partial<Record<JobKind, string>>>({});

  /* 通知 */
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [noticeToast, setNoticeToast] = useState<Notice | null>(null);

  /*
    幂等 key：一次逻辑创作 n 个（数量芯片），第 i 条任务一个（方案 §3 + 阶段 A §5）。
    提交失败（网络抖动、5xx）时整批复用同一组 key 重试：已经建成的那几条会被服务端按
    key 回放成原任务而不重复计费，没建成的继续用自己的 key 建。用户改了提示词或任一
    选项就算另一次创作，整组作废。
  */
  const keys = useRef<string[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dropKey = useCallback(() => {
    keys.current = [];
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /* ── 产品：/api/models 是唯一来源 ── */
  useEffect(() => {
    let alive = true;
    void fetchProducts().then(
      (list) => {
        if (alive) setProducts(list);
      },
      () => {
        // 老服务端没有这个路由、或一次网络抖动：面板回落 caps 下发的枚举，不打断使用
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const isImageTab = tab === "image";
  const productChoices = useMemo(
    () => products.filter((p) => p.kind === (isImageTab ? "image" : "video")),
    [products, isImageTab],
  );

  /*
    这次提交会走的后端模式。它先于产品算出来：产品的默认选择就是「列表里第一个接得下
    这条路径的」（阶段 A §1）。「首尾帧」恒定报 `image_to_video`——它送的是首帧 + 尾帧，
    只是多一个 `lastUploadId`。
  */
  const nativeMode: NativeMode = isImageTab
    ? "text_to_image"
    : mode === "reference"
      ? "reference_to_video"
      : mode === "firstLast"
        ? "image_to_video"
        : image
          ? "image_to_video"
          : "text_to_video";

  const chosenId = isImageTab ? imageProductId : videoProductId;
  const product: Product | null =
    productChoices.find((p) => p.id === chosenId) ??
    productChoices.find((p) => supportsMode(p, nativeMode)) ??
    productChoices[0] ??
    null;

  /* ── 面板可选项：有产品就听产品的，没有就回落服务端下发的枚举 ── */
  const capVideoRatios = useMemo(() => usableRatios(caps.videoAspectRatios, VIDEO_RATIO_FALLBACK), [caps.videoAspectRatios]);
  const capImageRatios = useMemo(() => usableRatios(caps.imageAspectRatios, ALL_RATIOS), [caps.imageAspectRatios]);
  const capRes = useMemo(() => usableRes(caps.videoResolutions), [caps.videoResolutions]);

  const ratios: readonly AspectRatio[] = product?.aspectRatios.length
    ? product.aspectRatios
    : isImageTab
      ? capImageRatios
      : capVideoRatios;
  const productRes: readonly Resolution[] = product && product.kind === "video" && product.resolutions.length
    ? product.resolutions
    : capRes;
  /*
    带尾帧的图生视频上游只在 1080p 接受，服务端会把分辨率抬上去**并按抬完的档计价**
    （`providers/kling/rest-map.ts`）。所以首尾帧模式下只留 1080p 一档：留着 720p 等于
    让用户选一个不会生效、还会按 1080p 收钱的档，⚡ 上的预估也就跟着错。
  */
  const resolutions: readonly Resolution[] =
    tab === "video" && mode === "firstLast" && productRes.includes("1080p") ? (["1080p"] as const) : productRes;
  const imageResolutions: readonly ImageResolution[] = product?.imageResolutions?.length
    ? product.imageResolutions
    : ALL_IMAGE_RES;

  const baseDurs: readonly number[] = product?.durations?.length
    ? product.durations
    : caps.videoDurations?.length
      ? caps.videoDurations
      : DUR_FALLBACK;
  /*
    长片（30 / 45 / 60）是一致性管线的档位，由 `HARNESS_ENABLED` 追加。但它只对**时长
    连续**的那条通道成立：按档计费的产品（`durations` 非空）在服务端会被
    `product-choice.ts` 直接 400（「所选模型不支持 30 / 45 / 60 秒长片」），把 30 留在芯片上
    等于给用户一个点了必被拒的档。产品还没拉到时照旧追加（回落到换产品之前的行为）。
  */
  // 长片档位由产品声明（`supportsLongForm`），没有产品信息时才退回「管线开着就给」。
  const longForm = caps.harness && (product ? product.supportsLongForm : true);
  const durs: readonly number[] = longForm ? [...baseDurs, ...HARNESS_DURATIONS] : baseDurs;

  const audioAvailable = product ? product.audio === "native" : caps.audioAvailable;
  const maxRefs = product?.maxReferenceImages ?? 0;
  const supportsLastFrame = product?.supportsLastFrame ?? false;
  const ratioUsable = !(tab === "video" && mode === "firstLast");

  const [ratioChoice, setRatioChoice] = useState<AspectRatio | null>(null);
  /*
    生效画幅 / 分辨率 / 时长都是**推导**出来的，不是存下来的：换产品或换标签页时枚举会变，
    存的那个不在新表里就回落到产品默认 / 第一项（阶段 A §1「产品切换导致当前 res / ratio /
    dur 不在范围时回落」）。用户的选择原样留着，切回去还是他选的那个。
  */
  const ratio: AspectRatio = ratioChoice && ratios.includes(ratioChoice)
    ? ratioChoice
    : ratios.includes("16:9")
      ? "16:9"
      : ratios[0];
  const res: Resolution = resChoice && resolutions.includes(resChoice)
    ? resChoice
    : product?.defaultResolution && resolutions.includes(product.defaultResolution)
      ? product.defaultResolution
      : resolutions.includes(DEFAULT_RES)
        ? DEFAULT_RES
        : resolutions[0];
  const imageRes: ImageResolution = imageResChoice && imageResolutions.includes(imageResChoice)
    ? imageResChoice
    : imageResolutions[0];

  const [durChoice, setDurChoice] = useState<number | null>(null);
  const dur: number = durChoice !== null && durs.includes(durChoice)
    ? durChoice
    : durs.includes(DEFAULT_DUR)
      ? DEFAULT_DUR
      : durs[0];

  /* ── 账号：/api/me 是唯一来源 ── */
  const refreshMe = useCallback(() => setMeTick((n) => n + 1), []);
  const jobId = currentJob?.id ?? "";
  const jobTerminal = !!currentJob && isTerminal(currentJob.status);
  useEffect(() => {
    let alive = true;
    void fetchMe().then(
      (next) => {
        if (alive) setMe(next);
      },
      () => {
        // 401 已由 client 层跳登录页；其它错误不该打断正在进行的出图
      },
    );
    return () => {
      alive = false;
    };
  }, [jobId, jobTerminal, meTick]);

  const email = me?.email ?? caps.initialEmail;
  const balance = me?.balance;
  const quota = me?.quota;
  const quotaExhausted = !!quota && quota.remaining <= 0 && tab === "image";
  const credits = balance ? creditsOf(balance.availableCny) : null;

  const signOut = useCallback(() => {
    if (signingOut) return;
    setSigningOut(true);
    void logout().then(
      () => {
        // 整页跳转：会话没了，客户端缓存里的任务数据也该一起丢掉
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      },
      (e: unknown) => {
        setSigningOut(false);
        setError(e instanceof Error ? e.message : t("shell.signOutFailed"));
      },
    );
  }, [signingOut, t]);

  /* ── 任务跟踪 ── */
  const upsert = useCallback((j: JobPublic) => {
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [j, ...prev]));
  }, []);
  const onLive = useCallback(
    (j: JobPublic) => {
      setCurrentJob(j);
      upsert(j);
    },
    [setCurrentJob, upsert],
  );
  useJobLive(currentJob ?? NO_JOB, onLive);

  /* ── 分页：`GET /api/jobs?before=&limit=&kind=` ── */
  /*
    游标从「这一类里最老的那条」算：首屏 40 条是 SSR 混着下发的，服务端没给过游标，
    所以第一次「加载更多」得自己推。之后一律用服务端回的 `nextBefore`——它在不在，
    就是「还有没有下一页」的唯一判据（契约）。
  */
  // ref 只在事件回调里读（点「加载更多」、收到 SSE），所以在 effect 里同步就够了；
  // render 期间写 ref 会被 react-hooks/refs 拦下。
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const hasMoreJobs = useCallback((kind: JobKind) => more[kind], [more]);

  const loadMoreJobs = useCallback(
    (kind: JobKind) => {
      if (jobsLoading || !more[kind]) return;
      const before = cursor[kind] ?? jobsRef.current.filter((j) => kindOfJob(j) === kind).at(-1)?.createdAt;
      setJobsLoading(true);
      setJobsError(null);
      void fetchJobsPage({ before, limit: JOBS_PAGE, kind }).then(
        (page) => {
          setJobsLoading(false);
          setJobs((prev) => appendJobs(prev, page.jobs));
          setCursor((c) => ({ ...c, [kind]: page.nextBefore }));
          setMore((m) => ({ ...m, [kind]: Boolean(page.nextBefore) }));
        },
        (e: unknown) => {
          setJobsLoading(false);
          setJobsError(e instanceof Error ? e.message : t("home.loadFailed"));
        },
      );
    },
    [cursor, jobsLoading, more, t],
  );

  /* ── 作品操作：标签 / 删除 ── */

  const saveTags = useCallback(
    async (id: string, tags: string[]) => {
      const next = await patchJobTags(id, tags);
      // 服务端回的是整条任务：直接换掉本地那份，标签之外的字段也跟着对齐
      upsert(next);
    },
    [upsert],
  );

  const removeJob = useCallback(
    async (id: string) => {
      await deleteJob(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
      // 删掉的正好是「当前任务」时把它关掉，否则创作页会指着一条不存在的记录
      setPickedJob((prev) => (prev?.id === id ? null : prev));
    },
    [],
  );

  /* ── 任务完成通知：账号级 SSE ── */
  /*
    只对**观察到的**「非终态 → 终态」那一跳发通知：连上时后端会把本人的任务推一遍，
    页面加载时就已经完成的那些不该再弹一次。所以先把已知状态记进 `seenStatus`
    （首屏 40 条 + 之后每一条事件），没见过的 id 第一次只记不弹。
  */
  const seenStatus = useRef<Map<string, JobPublic["status"]>>(
    new Map(caps.initialJobs.map((j) => [j.id, j.status])),
  );
  /**
   * 刚建出来的任务先记一笔「非终态」。不记的话，一条快到「第一条事件就是终态」的任务
   * 会被当成「本来就完成了的历史任务」而不弹通知——本会话亲手提交的那条，恰恰是最该
   * 通知的一条。
   */
  const remember = useCallback((job: JobPublic) => {
    if (!seenStatus.current.has(job.id)) seenStatus.current.set(job.id, job.status);
  }, []);
  // 在 /create 上看着的那条任务转终态时不再弹 toast：页面上已经在放成片了
  const quietRef = useRef({ path: pathname ?? "/", jobId: "" });
  const quietPath = pathname ?? "/";
  const quietJobId = currentJob?.id ?? "";
  useEffect(() => {
    quietRef.current = { path: quietPath, jobId: quietJobId };
  }, [quietPath, quietJobId]);

  const onEventJob = useCallback(
    (job: JobPublic) => {
      const prev = seenStatus.current.get(job.id);
      seenStatus.current.set(job.id, job.status);
      upsert(job);
      if (prev === undefined || isTerminal(prev) || !isTerminal(job.status)) return;
      const ok = job.status === "succeeded";
      const notice: Notice = {
        id: `${job.id}:${job.status}`,
        jobId: job.id,
        ok,
        title: ok
          ? t("shell.notice.done")
          : job.status === "canceled"
            ? t("shell.notice.canceled")
            : t("shell.notice.failed"),
        detail: ok
          ? job.prompt ||
            (kindOfJob(job) === "image" ? t("create.mode.text_to_image") : t("create.firstFrame"))
          : (job.error?.message ?? t("shell.notice.unknownReason")),
        at: job.updatedAt || new Date().toISOString(),
      };
      setNotices((list) => (list.some((n) => n.id === notice.id) ? list : [notice, ...list].slice(0, MAX_NOTICES)));
      setUnread((n) => Math.min(MAX_NOTICES, n + 1));
      const quiet = quietRef.current.path === "/create" && quietRef.current.jobId === job.id;
      if (!quiet) setNoticeToast(notice);
    },
    [t, upsert],
  );
  useEvents(true, onEventJob);

  /* toast 自动消失（6s）：比「即将上线」那条长，它带的是要读的信息 */
  useEffect(() => {
    if (!noticeToast) return;
    const t = setTimeout(() => setNoticeToast(null), 6000);
    return () => clearTimeout(t);
  }, [noticeToast]);

  const markNoticesRead = useCallback(() => setUnread(0), []);
  const dismissNoticeToast = useCallback(() => setNoticeToast(null), []);
  const openNotice = useCallback(
    (notice: Notice) => {
      setNoticeToast(null);
      const job = jobsRef.current.find((j) => j.id === notice.jobId);
      if (job) setCurrentJob(job);
      router.push("/create");
    },
    [router, setCurrentJob],
  );

  /*
    一次提交 n 条时，`useJobLive` 只盯住「当前任务」那一条，另外几条会一直停在提交时的
    状态直到刷新。这里给它们补一个 2.5s 的轮询：只查非终态、且不是当前任务的那几条，
    最多三条，出片后自然停下——「最近任务」列表才会跟着动（阶段 A §5）。
  */
  const backlog = jobs
    .filter((j) => j.id !== jobId && isActive(j.status))
    .slice(0, 3)
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!backlog) return;
    const ids = backlog.split(",");
    let stopped = false;
    const tick = async () => {
      for (const id of ids) {
        if (stopped) return;
        try {
          const next = await fetchJob(id);
          if (next && !stopped) upsert(next);
        } catch {
          // 401 已跳登录页；其它错误下一轮再说
        }
      }
    };
    const timer = setInterval(() => void tick(), 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [backlog, upsert]);

  const active = !!currentJob && isActive(currentJob.status);
  const working = busy || active;

  /* ── 面板取值 ── */
  const audioOn = audioAvailable && audio;
  /*
    本次售价：客户端与服务端跑同一个纯函数、同一张表（表随 /api/me 下来），所以
    ⚡ 上的数就是 createJob 会写进 priceCny 的那个数（除可灵实例的分辨率档外，见旧注释）。
    数量芯片选 n 时按 n 倍预判——真会扣 n 份钱，按钮上就该显示 n 份。
  */
  const price = priceCny(
    isImageTab
      ? { mode: "text_to_image", imageResolution: imageRes }
      : { mode: nativeMode, durationSec: dur, resolution: res, generateAudio: audioOn },
    me?.prices,
  );
  const batchPrice = price * count;
  const sendCredits = tab === "audio" ? 0 : creditsOf(batchPrice);
  const balanceShort = !!balance && batchPrice > balance.availableCny && tab !== "audio";
  /*
    错误行（契约 §7 `.composer__error[role=alert]`）：真提交失败时显示服务端那句话；
    没提交过但按钮本来就按不下去时，把原因常驻显示——否则用户只看见一个灰按钮，
    不知道是余额不够还是今天的额度用完了（方案 §4「余额不足按钮禁用 + 错误行」）。
  */
  const notice =
    error ?? (quotaExhausted ? t("composer.quotaExhausted") : balanceShort ? t("composer.balanceShort") : null);

  /* ── 面板动作（任何一次改动都作废幂等 key） ── */
  const setPrompt = useCallback(
    (value: string) => {
      setPromptState(value);
      dropKey();
    },
    [dropKey],
  );
  const pickTab = useCallback(
    (next: ComposerTab) => {
      setTab(next);
      setPop(null);
      setError(null);
      dropKey();
    },
    [dropKey],
  );

  /** 这个模式此刻能不能用：后端有这条路径 + 当前产品声明了对应能力。 */
  const modeUsable = useCallback(
    (m: VideoMode): boolean => {
      if (m === "prompt") return true;
      if (m === "reference") return maxRefs > 0 && !!product && supportsMode(product, "reference_to_video");
      if (m === "firstLast") return productChoices.some((p) => p.supportsLastFrame);
      return false;
    },
    [maxRefs, product, productChoices],
  );

  const pickMode = useCallback(
    (next: VideoMode) => {
      if (next === "firstLast") {
        // 切到首尾帧时当前产品不支持，就自动换到第一个支持的产品并说一声（阶段 A §4）
        if (!supportsLastFrame) {
          const alt = productChoices.find((p) => p.supportsLastFrame);
          if (!alt) {
            showToast(t("composer.lastFrame.none"));
            return;
          }
          setVideoProductId(alt.id);
          showToast(t("composer.lastFrame.switched", { name: alt.name }));
        }
        setMode(next);
        setPop(null);
        dropKey();
        return;
      }
      if (next === "reference" && !modeUsable("reference")) {
        showToast(product ? t("composer.ref.noSupport") : t("common.comingSoon"));
        return;
      }
      if (next !== "prompt" && next !== "reference") {
        showToast(t("common.comingSoon"));
        return;
      }
      setMode(next);
      setPop(null);
      dropKey();
    },
    [dropKey, modeUsable, product, productChoices, showToast, supportsLastFrame, t],
  );

  /**
   * 换产品。当前模式在新产品上不成立时退回「图文」——留在一个提交必然被拒的模式里，
   * 比少一次自动回落更糟。
   */
  const pickProduct = useCallback(
    (id: string) => {
      const next = productChoices.find((p) => p.id === id);
      if (!next) return;
      if (next.kind === "image") setImageProductId(next.id);
      else setVideoProductId(next.id);
      setMode((m) => {
        if (m === "firstLast" && !next.supportsLastFrame) return "prompt";
        if (m === "reference" && (next.maxReferenceImages === 0 || !supportsMode(next, "reference_to_video")))
          return "prompt";
        return m;
      });
      setPop(null);
      setError(null);
      dropKey();
    },
    [dropKey, productChoices],
  );

  const setRes = useCallback(
    (value: Resolution) => {
      setResChoice(value);
      dropKey();
    },
    [dropKey],
  );
  const setImageRes = useCallback(
    (value: ImageResolution) => {
      setImageResChoice(value);
      dropKey();
    },
    [dropKey],
  );
  const setRatio = useCallback(
    (value: AspectRatio) => {
      setRatioChoice(value);
      dropKey();
    },
    [dropKey],
  );
  const setDur = useCallback(
    (value: number) => {
      setDurChoice(value);
      dropKey();
    },
    [dropKey],
  );
  const setCount = useCallback(
    (value: number) => {
      setCountState(Math.min(MAX_COUNT, Math.max(1, Math.trunc(value))));
      setPop(null);
      dropKey();
    },
    [dropKey],
  );
  const toggleAudio = useCallback(() => {
    if (!audioAvailable) {
      showToast(t("composer.audio.unavailable"));
      return;
    }
    setAudio((a) => !a);
    dropKey();
  }, [audioAvailable, dropKey, showToast, t]);
  const toggleMulti = useCallback(() => setMulti((m) => !m), []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => !c);
    setPop(null);
  }, []);
  const openComposer = useCallback(() => {
    setOpen(true);
    setCollapsed(false);
  }, []);

  /* ── 图片槽 ── */

  const revoke = (frame: Frame | null) => {
    // 只回收本地 ObjectURL；「已创建」填进来的是 /api/media 地址，撤销它没有意义
    if (frame?.preview.startsWith("blob:")) URL.revokeObjectURL(frame.preview);
  };

  const clearImage = useCallback(() => {
    setImage((prev) => {
      revoke(prev);
      return null;
    });
    dropKey();
  }, [dropKey]);

  const clearLastImage = useCallback(() => {
    setLastImage((prev) => {
      revoke(prev);
      return null;
    });
    dropKey();
  }, [dropKey]);

  const removeRef = useCallback(
    (index: number) => {
      setRefs((prev) => {
        revoke(prev[index] ?? null);
        return prev.filter((_, i) => i !== index);
      });
      dropKey();
    },
    [dropKey],
  );

  /** 一张图 → 一次上传 → 落进指定槽。首帧 / 尾帧是单槽（替换），参考是列表（追加）。 */
  const uploadInto = useCallback(
    (target: SlotTarget, file: File) => {
      setError(null);
      dropKey();
      const preview = URL.createObjectURL(file);
      const role = target === "start" ? "start" : target === "last" ? "last" : "reference";
      const busyFrame: Frame = { preview, uploadId: null, state: "busy" };
      const settle = (next: Frame) => {
        if (target === "start") setImage((prev) => (prev?.preview === preview ? next : prev));
        else if (target === "last") setLastImage((prev) => (prev?.preview === preview ? next : prev));
        else setRefs((prev) => prev.map((f) => (f.preview === preview ? next : f)));
      };
      if (target === "start") {
        setImage((prev) => {
          revoke(prev);
          return busyFrame;
        });
      } else if (target === "last") {
        setLastImage((prev) => {
          revoke(prev);
          return busyFrame;
        });
      } else {
        setRefs((prev) => [...prev, busyFrame]);
      }
      void uploadFile(file, role).then(
        (up) => settle({ preview, uploadId: up.uploadId, state: "ready" }),
        (e: unknown) =>
          settle({
            preview,
            uploadId: null,
            state: "error",
            message: e instanceof Error ? e.message : t("composer.err.upload"),
          }),
      );
    },
    [dropKey, t],
  );

  const pickImage = useCallback(
    (file: File | undefined) => {
      if (file) uploadInto("start", file);
    },
    [uploadInto],
  );
  const pickLastImage = useCallback(
    (file: File | undefined) => {
      if (file) uploadInto("last", file);
    },
    [uploadInto],
  );
  const addRefImages = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const list = Array.from(files);
      // 上限由产品说了算：多选时超出的那几张直接不收，并说一声，而不是传上去再被 400
      const room = Math.max(0, maxRefs - refs.length);
      if (room <= 0) {
        showToast(t("composer.ref.max", { n: maxRefs }));
        return;
      }
      if (list.length > room) showToast(t("composer.ref.maxTaken", { n: maxRefs, room }));
      for (const file of list.slice(0, room)) uploadInto("reference", file);
    },
    [maxRefs, refs.length, showToast, t, uploadInto],
  );

  const openPicker = useCallback((target: SlotTarget) => {
    setSlotTarget(target);
    setPop("picker");
  }, []);

  /**
   * 「已创建」页签选一张自己生成的图当素材。它只有 `/api/media/...` 地址，请求体要的是
   * `uploadId`，所以让服务端把这条任务的产物认领成一次上传（`POST /api/uploads/from-job`），
   * 拿到 id 再填进槽里。
   */
  const pickCreated = useCallback(
    (job: JobPublic) => {
      const preview = job.output?.kind === "image" ? job.output.imageUrl : "";
      if (!preview) return;
      const target = slotTarget;
      const role = target === "start" ? "start" : target === "last" ? "last" : "reference";
      if (target === "reference" && refs.length >= maxRefs) {
        showToast(t("composer.ref.max", { n: maxRefs }));
        return;
      }
      setError(null);
      dropKey();
      setPop(null);
      const busyFrame: Frame = { preview, uploadId: null, state: "busy" };
      const settle = (next: Frame) => {
        if (target === "start") setImage((prev) => (prev?.preview === preview ? next : prev));
        else if (target === "last") setLastImage((prev) => (prev?.preview === preview ? next : prev));
        else setRefs((prev) => prev.map((f) => (f.preview === preview ? next : f)));
      };
      if (target === "start") {
        setImage((prev) => {
          revoke(prev);
          return busyFrame;
        });
      } else if (target === "last") {
        setLastImage((prev) => {
          revoke(prev);
          return busyFrame;
        });
      } else {
        setRefs((prev) => [...prev, busyFrame]);
      }
      void uploadFromJob(job.id, role).then(
        (up) => settle({ preview, uploadId: up.uploadId, state: "ready" }),
        (e: unknown) =>
          settle({
            preview,
            uploadId: null,
            state: "error",
            message: e instanceof Error ? e.message : t("composer.err.pick"),
          }),
      );
    },
    [dropKey, maxRefs, refs.length, showToast, slotTarget, t],
  );

  const clearAll = useCallback(() => {
    setPromptState("");
    setImage((prev) => {
      revoke(prev);
      return null;
    });
    setLastImage((prev) => {
      revoke(prev);
      return null;
    });
    setRefs((prev) => {
      for (const f of prev) revoke(f);
      return [];
    });
    setError(null);
    dropKey();
  }, [dropKey]);

  /* ── 提交：请求体以 createJobBodySchema（strict）为准 ── */
  const submit = useCallback(() => {
    if (working) return;
    if (tab === "audio") {
      showToast(t("common.comingSoon"));
      return;
    }
    setError(null);
    if (quotaExhausted) {
      setError(t("composer.quotaExhausted"));
      return;
    }
    if (balanceShort) {
      setError(t("composer.balanceShort"));
      return;
    }
    const framesFor: Frame[] =
      tab !== "video"
        ? []
        : mode === "reference"
          ? refs
          : mode === "firstLast"
            ? [image, lastImage].filter((f): f is Frame => f !== null)
            : image
              ? [image]
              : [];
    const pendingFrame = framesFor.find((f) => f.state !== "ready");
    if (pendingFrame) {
      setError(
        pendingFrame.state === "busy"
          ? t("composer.err.uploading")
          : (pendingFrame.message ?? t("composer.err.uploadFailed")),
      );
      return;
    }
    if (tab === "video" && mode === "reference" && refs.length === 0) {
      setError(t("composer.err.needRef"));
      return;
    }
    if (tab === "video" && mode === "firstLast" && (!image || !lastImage)) {
      setError(t("composer.err.needBothFrames"));
      return;
    }
    if (!prompt.trim() && !(tab === "video" && framesFor.length > 0)) {
      setError(t("composer.err.needPrompt"));
      return;
    }

    setBusy(true);
    const n = Math.min(MAX_COUNT, Math.max(1, count));
    while (keys.current.length < n) keys.current.push(newIdempotencyKey());
    const base: Record<string, unknown> = { mode: nativeMode, prompt };
    // 产品 id 就是请求体的 `model`；`/api/models` 没回来时不带这个字段，服务端按 mode 自选
    if (product) base.model = product.id;
    if (isImageTab) {
      base.aspectRatio = ratio;
      base.imageResolution = imageRes;
    } else {
      base.durationSec = dur;
      // 首尾帧不给选画幅，也就不该发一个用户没选过的值上去（成片比例跟着两张帧走）
      if (ratioUsable) base.aspectRatio = ratio;
      base.resolution = res;
      base.generateAudio = audioOn;
      if (mode === "reference") {
        base.referenceUploadIds = refs.map((f) => f.uploadId).filter((id): id is string => !!id);
      } else {
        if (image?.uploadId) base.startUploadId = image.uploadId;
        if (mode === "firstLast" && lastImage?.uploadId) base.lastUploadId = lastImage.uploadId;
      }
    }

    void (async () => {
      const made: JobPublic[] = [];
      try {
        for (let i = 0; i < n; i += 1) {
          const created = await createJob({ ...base, idempotencyKey: keys.current[i] });
          made.push(created);
          remember(created);
          upsert(created);
        }
        keys.current = [];
        setBusy(false);
        // 「当前任务」显示最新一条，其余进最近列表（阶段 A §5）
        setCurrentJob(made[made.length - 1] ?? null);
        setOpen(true);
        router.push("/create");
      } catch (e: unknown) {
        // 402 insufficient_balance / 429 quota_exceeded / failure_limit_reached：服务端消息原样展示。
        // 已经建成的那几条留在列表里，幂等 key 也留着——再点一次「创作」不会重复计费。
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
        if (made.length) setCurrentJob(made[made.length - 1]);
        refreshMe();
      }
    })();
  }, [
    audioOn,
    balanceShort,
    count,
    dur,
    image,
    imageRes,
    isImageTab,
    lastImage,
    mode,
    nativeMode,
    product,
    prompt,
    quotaExhausted,
    ratio,
    ratioUsable,
    refreshMe,
    refs,
    remember,
    res,
    router,
    setCurrentJob,
    showToast,
    t,
    tab,
    upsert,
    working,
  ]);

  const cancel = useCallback(() => {
    const job = currentJob;
    if (!job || busy || !isActive(job.status)) return;
    setError(null);
    setBusy(true);
    void cancelJob(job.id).then(
      (next) => {
        setBusy(false);
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [busy, currentJob, onLive]);

  const retry = useCallback(() => {
    const job = currentJob;
    if (!job || busy || (job.status !== "failed" && job.status !== "expired")) return;
    // 服务端 409 之外的第二道防线：上游可能已经接单计费，这条任务不能重发（方案 §5）。
    if (job.retryBlocked) return;
    // 留存期满、素材已删的任务也不给重试（方案 §5）。
    if (job.artifactsPurgedAt) return;
    setError(null);
    setBusy(true);
    void retryJob(job.id).then(
      (next) => {
        setBusy(false);
        // 重试建的是一条**新任务**，与提交同理要先记一笔，它出片时才会有通知
        remember(next);
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
        refreshMe();
      },
    );
  }, [busy, currentJob, onLive, refreshMe, remember]);

  /**
   * 核验上游（A 包恢复中心）：`uncertain_submit` 的任务拿我们自己的 jobId 去查上游——
   * 查到了任务接管成 pending 照常出片；查不到就把标记降级成普通失败，「重新生成」
   * 随之解锁。两种结局都不新花钱。
   */
  const reconcile = useCallback(() => {
    const job = currentJob;
    if (!job || busy || job.retryBlocked?.code !== "uncertain_submit") return;
    setError(null);
    setBusy(true);
    void reconcileJob(job.id).then(
      ({ job: next }) => {
        setBusy(false);
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [busy, currentJob, onLive]);

  const reuse = useCallback(
    (text: string, kind: "video" | "image") => {
      // 先清空（含所有图片槽），再填提示词——顺序反了会被 clearAll 抹掉
      clearAll();
      setPromptState(text);
      setTab(kind === "image" ? "image" : "video");
      setMode("prompt");
      setError(null);
      setOpen(true);
      setCollapsed(false);
      dropKey();
    },
    [clearAll, dropKey],
  );

  /**
   * 模板卡片 → 面板。`ratio` / `dur` 都是**推导**出来的（见上面那段注释）：模板给的档位
   * 不在当前产品的能力里时会自动回落，所以这里可以照单填，填不进去也提交不出 400。
   */
  const applyTemplate = useCallback(
    (template: Template) => {
      clearAll();
      setPromptState(template.prompt);
      setTab(template.mode === "text_to_image" ? "image" : "video");
      // 模板只带提示词与规格，不带素材，所以恒定落在「图文」这条不需要上传的路径上
      setMode("prompt");
      if (template.aspectRatio) setRatioChoice(template.aspectRatio);
      if (template.durationSec) setDurChoice(template.durationSec);
      setError(null);
      setPop(null);
      setOpen(true);
      setCollapsed(false);
      dropKey();
    },
    [clearAll, dropKey],
  );

  const value: Shell = {
    caps,
    me,
    email,
    credits,
    refreshMe,
    signOut,
    signingOut,
    products,
    productChoices,
    product,
    pickProduct,
    jobs,
    currentJob,
    setCurrentJob,
    busy,
    working,
    cancel,
    retry,
    reconcile,
    hasMoreJobs,
    loadMoreJobs,
    jobsLoading,
    jobsError,
    saveTags,
    removeJob,
    open,
    openComposer,
    tab,
    pickTab,
    mode,
    pickMode,
    modeUsable,
    collapsed,
    toggleCollapsed,
    pop,
    setPop,
    prompt,
    setPrompt,
    res,
    setRes,
    resolutions,
    imageRes,
    setImageRes,
    imageResolutions,
    ratio,
    setRatio,
    ratios,
    ratioUsable,
    dur,
    setDur,
    durs,
    audio: audioOn,
    audioAvailable,
    toggleAudio,
    multi,
    toggleMulti,
    count,
    setCount,
    image,
    lastImage,
    refs,
    maxRefs,
    pickImage,
    pickLastImage,
    addRefImages,
    clearImage,
    clearLastImage,
    removeRef,
    clearAll,
    slotTarget,
    openPicker,
    pickCreated,
    nativeMode,
    price,
    sendCredits,
    balanceShort,
    quotaExhausted,
    error,
    notice,
    setError,
    submit,
    reuse,
    applyTemplate,
    toast,
    showToast,
    notices,
    unread,
    markNoticesRead,
    openNotice,
    noticeToast,
    dismissNoticeToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
