"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { JobPublic } from "@/lib/jobs/schema";
import type { AspectRatio, ImageResolution, NativeMode, Resolution } from "@/lib/providers/types";
import { priceCny } from "@/lib/billing/prices";
import { HARNESS_DURATIONS } from "@/lib/providers/grok/mode-matrix";
import { cancelJob, createJob, newIdempotencyKey, retryJob, uploadFile } from "@/lib/client/jobs";
import { fetchMe, logout, type MePublic } from "@/lib/client/auth";
import { useJobLive } from "@/lib/client/useJobLive";
import { isActive, isTerminal } from "@/lib/client/labels";

/*
  Genius App 的唯一客户端状态所有者（方案 `docs/plan-ui-genius-app.md` §3）。
  主页与创作页共用同一个创作面板实例，所以面板状态必须挂在壳上而不是某个视图里；
  组件只经 `@/lib/client/*` 访问 `/api/*`，这里是它们唯一的调用处（AGENTS.md）。
*/

/* ── 常量 ── */

/** 面板三个标签页。音频整页置灰（后端没有这条路径）。 */
export const COMPOSER_TABS = [
  { id: "video", label: "视频" },
  { id: "image", label: "图片" },
  { id: "audio", label: "音频" },
] as const;
export type ComposerTab = (typeof COMPOSER_TABS)[number]["id"];

/**
 * 视频页的模式行。后端只接得住「图文」（空槽 = 文生视频、有图 = 图生视频），
 * 其余按用户 2026-09-06 的决定「画出来但置灰」，点击提示「即将上线」。
 */
export const VIDEO_MODES = ["图文", "参考", "模板", "首尾帧", "编辑", "动作模仿", "续写", "人声"] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

/** 视频分辨率档（后端 `RESOLUTIONS`），芯片文案是大写的那份。 */
export const VIDEO_RES: { id: Resolution; label: string }[] = [
  { id: "480p", label: "480P" },
  { id: "720p", label: "720P" },
  { id: "1080p", label: "1080P" },
];
/** 文生图分辨率档（后端 `IMAGE_RESOLUTIONS`）。 */
export const IMAGE_RES: { id: ImageResolution; label: string }[] = [
  { id: "1k", label: "1K" },
  { id: "2k", label: "2K" },
];

const ALL_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
/** 服务端没下发画幅时的兜底（三家视频 provider 都接得下的那几个） */
const VIDEO_RATIO_FALLBACK: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];
/** 服务端没下发时长时的兜底（grok / mock 的档位） */
const DUR_FALLBACK = [4, 6, 8, 10] as const;
const DEFAULT_DUR = 5;

export const QUOTA_EXHAUSTED = "今日额度已用完，北京时间 0 点重置";
export const BALANCE_SHORT = "当前配置，余额可能不够，请充值";
export const SOON = "即将上线";

/** ¥1 = 100 积分（用户 2026-09-06 拍板的换算口径），余额模型与后端计费不变。 */
export const creditsOf = (cny: number): number => Math.round((Number.isFinite(cny) ? cny : 0) * 100);

/** 服务端下发的画幅里认得的那些；一个都不认得就用兜底表。 */
function usableRatios(given: string[] | undefined, fallback: readonly AspectRatio[]): readonly AspectRatio[] {
  const usable = (given ?? []).filter((r): r is AspectRatio => (ALL_RATIOS as readonly string[]).includes(r));
  return usable.length ? usable : fallback;
}

/* ── 类型 ── */

export type ShellCaps = {
  mock: boolean;
  harness: boolean;
  videoDurations?: number[];
  videoAspectRatios?: string[];
  imageAspectRatios?: string[];
  videoModel: string;
  imageModel: string;
  audioAvailable: boolean;
  initialEmail: string;
  initialJobs: JobPublic[];
};

/** 首帧：本地预览 + 上传后的 uploadId（`startUploadId` 只接受服务端发的 id） */
export type Frame = { preview: string; uploadId: string | null; state: "busy" | "ready" | "error"; message?: string };

export type Pop = null | "specs" | "model" | "buddy" | "picker";

type Shell = {
  /* 能力与账号 */
  caps: ShellCaps;
  me: MePublic | null;
  email: string;
  credits: number;
  refreshMe: () => void;
  signOut: () => void;
  signingOut: boolean;

  /* 任务 */
  jobs: JobPublic[];
  currentJob: JobPublic | null;
  setCurrentJob: (job: JobPublic | null) => void;
  busy: boolean;
  working: boolean;
  cancel: () => void;
  retry: () => void;

  /* 面板 */
  open: boolean;
  openComposer: () => void;
  tab: ComposerTab;
  pickTab: (tab: ComposerTab) => void;
  mode: VideoMode;
  pickMode: (mode: VideoMode) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  pop: Pop;
  setPop: (pop: Pop) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  res: Resolution;
  setRes: (value: Resolution) => void;
  imageRes: ImageResolution;
  setImageRes: (value: ImageResolution) => void;
  ratio: AspectRatio;
  setRatio: (value: AspectRatio) => void;
  ratios: readonly AspectRatio[];
  dur: number;
  setDur: (value: number) => void;
  durs: readonly number[];
  audio: boolean;
  toggleAudio: () => void;
  multi: boolean;
  toggleMulti: () => void;
  image: Frame | null;
  pickImage: (file: File | undefined) => void;
  clearImage: () => void;
  clearAll: () => void;

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

  /* 置灰项的提示 */
  toast: string | null;
  showToast: (message: string) => void;
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

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ComposerTab>("video");
  const [mode, setMode] = useState<VideoMode>("图文");
  const [collapsed, setCollapsed] = useState(false);
  const [pop, setPop] = useState<Pop>(null);
  const [prompt, setPromptState] = useState("");
  const [res, setResState] = useState<Resolution>("720p");
  const [imageRes, setImageResState] = useState<ImageResolution>("1k");
  const [audio, setAudio] = useState(true);
  const [multi, setMulti] = useState(true);
  const [image, setImage] = useState<Frame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const videoRatios = useMemo(() => usableRatios(caps.videoAspectRatios, VIDEO_RATIO_FALLBACK), [caps.videoAspectRatios]);
  const imageRatios = useMemo(() => usableRatios(caps.imageAspectRatios, ALL_RATIOS), [caps.imageAspectRatios]);
  const ratios = tab === "image" ? imageRatios : videoRatios;
  const [ratioChoice, setRatioChoice] = useState<AspectRatio>(videoRatios.includes("16:9") ? "16:9" : videoRatios[0]);
  /*
    生效画幅是推导出来的，不是存下来的：切标签页时枚举会换（视频三档 / 文生图七档），
    存的那个不在新表里就落到第一项（方案 §4「切换标签页时回落」）。用户的选择原样留着。
  */
  const ratio: AspectRatio = ratios.includes(ratioChoice) ? ratioChoice : ratios[0];

  const baseDurs: readonly number[] = caps.videoDurations?.length ? caps.videoDurations : DUR_FALLBACK;
  const durs: readonly number[] = caps.harness ? [...baseDurs, ...HARNESS_DURATIONS] : baseDurs;
  const [dur, setDurState] = useState<number>(baseDurs.includes(DEFAULT_DUR) ? DEFAULT_DUR : baseDurs[0]);

  const idempotencyKey = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
    幂等 key：一次逻辑创作一个（方案 §3）。提交失败（网络抖动、5xx）时复用同一个 key
    与同一请求体重试，服务端按 key 回放原任务而不重复计费；用户改了提示词或任一选项
    就算另一次创作，key 作废，下次提交现取一个新的。
  */
  const dropKey = useCallback(() => {
    idempotencyKey.current = null;
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

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
  const credits = balance ? creditsOf(balance.availableCny) : 0;

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
        setError(e instanceof Error ? e.message : "退出失败");
      },
    );
  }, [signingOut]);

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

  const active = !!currentJob && isActive(currentJob.status);
  const working = busy || active;

  /* ── 面板取值 ── */
  const nativeMode: NativeMode = tab === "image" ? "text_to_image" : image ? "image_to_video" : "text_to_video";
  const audioOn = caps.audioAvailable && audio;
  /*
    本次售价：客户端与服务端跑同一个纯函数、同一张表（表随 /api/me 下来），所以
    ⚡ 上的数就是 createJob 会写进 priceCny 的那个数（除可灵实例的分辨率档外，见旧注释）。
  */
  const price = priceCny(
    tab === "image"
      ? { mode: "text_to_image", imageResolution: imageRes }
      : { mode: nativeMode, durationSec: dur, resolution: res, generateAudio: audioOn },
    me?.prices,
  );
  const sendCredits = tab === "audio" ? 0 : creditsOf(price);
  const balanceShort = !!balance && price > balance.availableCny && tab !== "audio";
  /*
    错误行（契约 §7 `.composer__error[role=alert]`）：真提交失败时显示服务端那句话；
    没提交过但按钮本来就按不下去时，把原因常驻显示——否则用户只看见一个灰按钮，
    不知道是余额不够还是今天的额度用完了（方案 §4「余额不足按钮禁用 + 错误行」）。
  */
  const notice = error ?? (quotaExhausted ? QUOTA_EXHAUSTED : balanceShort ? BALANCE_SHORT : null);

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
  const pickMode = useCallback(
    (next: VideoMode) => {
      if (next !== "图文") {
        showToast(SOON);
        return;
      }
      setMode(next);
      setPop(null);
      dropKey();
    },
    [dropKey, showToast],
  );
  const setRes = useCallback(
    (value: Resolution) => {
      setResState(value);
      dropKey();
    },
    [dropKey],
  );
  const setImageRes = useCallback(
    (value: ImageResolution) => {
      setImageResState(value);
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
      setDurState(value);
      dropKey();
    },
    [dropKey],
  );
  const toggleAudio = useCallback(() => {
    if (!caps.audioAvailable) {
      showToast("当前视频服务未开启音轨，暂不可用");
      return;
    }
    setAudio((a) => !a);
    dropKey();
  }, [caps.audioAvailable, dropKey, showToast]);
  const toggleMulti = useCallback(() => setMulti((m) => !m), []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => !c);
    setPop(null);
  }, []);
  const openComposer = useCallback(() => {
    setOpen(true);
    setCollapsed(false);
  }, []);

  /* ── 首帧上传：图片槽为空 → 文生视频，放了图 → 图生视频 ── */
  const clearImage = useCallback(() => {
    setImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return null;
    });
    dropKey();
  }, [dropKey]);

  const pickImage = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setError(null);
      dropKey();
      const preview = URL.createObjectURL(file);
      setImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.preview);
        return { preview, uploadId: null, state: "busy" };
      });
      void uploadFile(file, "start").then(
        (up) => setImage({ preview, uploadId: up.uploadId, state: "ready" }),
        (e: unknown) =>
          setImage({ preview, uploadId: null, state: "error", message: e instanceof Error ? e.message : "上传失败" }),
      );
    },
    [dropKey],
  );

  const clearAll = useCallback(() => {
    setPromptState("");
    clearImage();
    setError(null);
    dropKey();
  }, [clearImage, dropKey]);

  /* ── 提交：请求体以 createJobBodySchema（strict）为准，没有 model 字段 ── */
  const submit = useCallback(() => {
    if (working) return;
    if (tab === "audio") {
      showToast(SOON);
      return;
    }
    setError(null);
    if (quotaExhausted) {
      setError(QUOTA_EXHAUSTED);
      return;
    }
    if (balanceShort) {
      setError(BALANCE_SHORT);
      return;
    }
    if (tab === "video" && image && image.state !== "ready") {
      setError(image.state === "busy" ? "首帧还在上传，请稍候" : (image.message ?? "首帧上传失败，请重试"));
      return;
    }
    if (!prompt.trim() && !(tab === "video" && image)) {
      setError("这条路径需要提示词");
      return;
    }
    setBusy(true);
    idempotencyKey.current ??= newIdempotencyKey();
    const body: Record<string, unknown> = { mode: nativeMode, prompt, idempotencyKey: idempotencyKey.current };
    if (tab === "image") {
      body.aspectRatio = ratio;
      body.imageResolution = imageRes;
    } else {
      body.durationSec = dur;
      body.aspectRatio = ratio;
      body.resolution = res;
      body.generateAudio = audioOn;
      if (image?.uploadId) body.startUploadId = image.uploadId;
    }
    void createJob(body).then(
      (created) => {
        idempotencyKey.current = null;
        setBusy(false);
        setCurrentJob(created);
        upsert(created);
        setOpen(true);
        router.push("/create");
      },
      (e: unknown) => {
        // 402 insufficient_balance / 429 quota_exceeded / failure_limit_reached：服务端消息原样展示
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
        refreshMe();
      },
    );
  }, [
    audioOn,
    balanceShort,
    dur,
    image,
    imageRes,
    nativeMode,
    prompt,
    quotaExhausted,
    ratio,
    refreshMe,
    res,
    router,
    setCurrentJob,
    showToast,
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
        onLive(next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
        refreshMe();
      },
    );
  }, [busy, currentJob, onLive, refreshMe]);

  const reuse = useCallback(
    (text: string, kind: "video" | "image") => {
      setPromptState(text);
      clearImage();
      setTab(kind === "image" ? "image" : "video");
      setMode("图文");
      setError(null);
      setOpen(true);
      setCollapsed(false);
      dropKey();
    },
    [clearImage, dropKey],
  );

  const value: Shell = {
    caps,
    me,
    email,
    credits,
    refreshMe,
    signOut,
    signingOut,
    jobs,
    currentJob,
    setCurrentJob,
    busy,
    working,
    cancel,
    retry,
    open,
    openComposer,
    tab,
    pickTab,
    mode,
    pickMode,
    collapsed,
    toggleCollapsed,
    pop,
    setPop,
    prompt,
    setPrompt,
    res,
    setRes,
    imageRes,
    setImageRes,
    ratio,
    setRatio,
    ratios,
    dur,
    setDur,
    durs,
    audio: audioOn,
    toggleAudio,
    multi,
    toggleMulti,
    image,
    pickImage,
    clearImage,
    clearAll,
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
    toast,
    showToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
