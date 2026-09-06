"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import type { NativeMode, ProviderId } from "@/lib/providers/types";
import { estimateHarnessCostUsd } from "@/lib/cost";
import { formatCny, priceCny } from "@/lib/billing/prices";
import { packHarnessDuration } from "@/lib/harness/pack-duration";
import { HARNESS_DURATIONS, isHarnessDuration } from "@/lib/providers/grok/mode-matrix";
import { cancelJob, createJob, newIdempotencyKey, retryJob, uploadFile } from "@/lib/client/jobs";
import { fetchMe, logout, type MePublic } from "@/lib/client/auth";
import { useJobLive } from "@/lib/client/useJobLive";
import { formatElapsed, isActive, isFailed, isTerminal } from "@/lib/client/labels";
import { SceneHost } from "@/components/scene/SceneHost";
import { ClothVeil } from "@/components/lumen/ClothVeil";
import { mountDawn, mountRingDark, type DawnHandle, type RingHandle } from "@/lib/scene/lumen-three";

/*
  Genius — 单屏工作室（design_handoff/design_handoff_genius_home）。
  三个视图：首页（标题 + 输入卡 + 最近成片）→ 工作室（操作台 / 展览区 / 输入卡落底）→ 作品（环形画廊）。
  本组件是唯一的状态所有者；浏览器只经 lib/client/* 访问 /api/*。
*/

/* ── 常量：三条路径、画幅、时长、操作台分组、样片 ── */

type UiMode = "t2v" | "i2v" | "t2i";
const MODES: { id: UiMode; label: string; native: NativeMode }[] = [
  { id: "t2v", label: "文生视频", native: "text_to_video" },
  { id: "i2v", label: "图生视频", native: "image_to_video" },
  { id: "t2i", label: "文生图", native: "text_to_image" },
];
const UI_MODE_OF: Partial<Record<NativeMode, UiMode>> = { text_to_video: "t2v", image_to_video: "i2v", text_to_image: "t2i" };
const RATIOS = ["16:9", "9:16", "1:1"] as const;
type Ratio = (typeof RATIOS)[number];
const DURS = [4, 6, 8, 10] as const;
/** 可灵的 duration 枚举只有 5 / 10，别的值上游会按这两档计费，所以芯片直接跟着换 */
const KLING_DURS = [5, 10] as const;
const DEFAULT_DUR = 8;

type GroupId = "filter" | "skin" | "color" | "cam";
type Option = { id: string; label: string; text: string };
type Group = { id: GroupId; title: string; options: Option[] };
/** 操作台：每组单选；选中后该选项的提示词飞入输入框，多段之间空一行 */
const GROUPS: Group[] = [
  {
    id: "filter",
    title: "滤镜",
    options: [
      { id: "film", label: "胶片", text: "胶片颗粒质感，轻微暗角，柔和高光" },
      { id: "bw", label: "黑白", text: "黑白影像，高对比，银盐质感" },
      { id: "teal", label: "青橙", text: "青橙色调，阴影偏青、肤色偏暖" },
      { id: "soft", label: "柔光", text: "柔光滤镜，轻微光晕，低对比" },
    ],
  },
  {
    id: "skin",
    title: "磨皮",
    options: [
      { id: "light", label: "轻度", text: "人物皮肤轻度磨皮，保留毛孔与纹理" },
      { id: "mid", label: "中度", text: "人物皮肤中度磨皮，肤色均匀自然" },
      { id: "strong", label: "强", text: "人物皮肤强磨皮，柔焦人像效果" },
    ],
  },
  {
    id: "color",
    title: "色彩",
    options: [
      { id: "warm", label: "暖调", text: "整体暖色调，金色阳光氛围" },
      { id: "cool", label: "冷调", text: "整体冷色调，蓝灰清晨氛围" },
      { id: "sat", label: "高饱和", text: "高饱和色彩，鲜明浓烈" },
      { id: "desat", label: "低饱和", text: "低饱和色彩，克制素净" },
    ],
  },
  {
    id: "cam",
    title: "镜头",
    options: [
      { id: "push", label: "缓慢推进", text: "镜头缓慢推进，稳定平滑" },
      { id: "orbit", label: "环绕", text: "镜头环绕主体，弧形运动" },
      { id: "hand", label: "手持", text: "手持镜头，轻微自然晃动" },
    ],
  },
];
type Opts = Partial<Record<GroupId, string>>;
const optionOf = (g: GroupId, o: string) => GROUPS.find((x) => x.id === g)!.options.find((x) => x.id === o)!;
const stripSeg = (p: string, text: string) =>
  p
    .split("\n\n")
    .filter((seg) => seg.trim() !== text)
    .join("\n\n");

/** 阶段读数，全部中文；长片用一致性管线的阶段名 */
const STAGE_LABEL: Record<JobPublic["status"], string> = {
  queued: "排队中",
  submitting: "已提交",
  pending: "生成中",
  persisting: "写入中",
  directing: "分镜",
  keyframing: "锁帧",
  generating_shots: "生成分镜",
  qc: "质检",
  stitching: "拼接",
  succeeded: "完成",
  failed: "失败",
  expired: "已过期",
  canceled: "已取消",
};

type Kind = "video" | "image";
const SAMPLES: { id: string; prompt: string; kind: Kind }[] = [
  { id: "2e9cde0e2fb0803e", prompt: "玉米田深处，一个穿银色防护服的人走来", kind: "video" },
  { id: "a72d8b509c55bcd0", prompt: "像素风峡谷日出，河流蜿蜒穿过山谷", kind: "video" },
  { id: "a1f3319d0d783e66", prompt: "雨夜的外滩，一位穿深青色风衣的女人走向江边", kind: "image" },
  { id: "f3bfe52263d0656d", prompt: "清晨的山谷薄雾，镜头缓慢推进", kind: "video" },
  { id: "d99c0972e1f99b67", prompt: "霓虹街道，慢速推轨", kind: "image" },
  { id: "a9008119d34b8fc1", prompt: "海岸线航拍，日落前", kind: "video" },
  { id: "5a09f4952b5ad9b6", prompt: "旧仓库里的一束光", kind: "image" },
  { id: "6f297b60448c30c9", prompt: "雪后的胡同口", kind: "video" },
];

/* ── 作品：成功任务按 output.kind 分视频 / 图片；没有成片时回落样片 ── */

type Work = {
  key: string;
  jobId: string | null;
  kind: Kind;
  /** 环上挂的静帧：视频取 poster */
  still: string;
  media: string;
  prompt: string;
  mode: UiMode;
  dur: number;
  ratio: string;
  quality: string;
  /** 售价（元）。样片没有账，为 null；余额模型之前的老任务是 0，同样不显示。 */
  priceCny: number | null;
  /** 有声 / 无声——上游是否真的出了音轨，界面必须说清楚（方案 §3.4 的诚实性） */
  audio: boolean;
  sample: boolean;
  /** 留存期满、成片与素材已删（方案 §8）：环上换占位卡，不给播放 / 下载 / 重试 */
  purged: boolean;
};

/** 已清理作品在环上的那一格；本地静态图，绝不去请求已删掉的 /api/media/... */
const PURGED_STILL = "/lumina/purged.svg";

function worksFromJobs(jobs: JobPublic[]): Work[] {
  const real = jobs
    .filter((j) => j.status === "succeeded" && j.output && UI_MODE_OF[j.mode])
    .map<Work>((j) => {
      const out = j.output!;
      const purged = Boolean(j.artifactsPurgedAt);
      return {
        key: j.id,
        jobId: j.id,
        kind: out.kind,
        still: purged ? PURGED_STILL : out.kind === "video" ? out.posterUrl : out.imageUrl,
        media: purged ? "" : out.kind === "video" ? out.videoUrl : out.imageUrl,
        prompt: j.prompt || "（无提示词，以首帧为准）",
        mode: UI_MODE_OF[j.mode]!,
        dur: j.durationSec,
        ratio: j.aspectRatio ?? "16:9",
        quality: out.kind === "image" ? (j.imageResolution ?? "1k").toUpperCase() : (j.resolution ?? "720p"),
        priceCny: j.priceCny,
        audio: j.generateAudio,
        sample: false,
        purged,
      };
    });
  if (real.length) return real;
  return SAMPLES.map<Work>((s, i) => ({
    key: `sample-${s.id}`,
    jobId: null,
    kind: s.kind,
    still: `/lumina/${s.id}.webp`,
    media: `/lumina/${s.id}.webp`,
    prompt: s.prompt,
    mode: s.kind === "image" ? "t2i" : i % 3 === 0 ? "i2v" : "t2v",
    dur: 6 + (i % 3) * 2,
    ratio: "16:9",
    quality: s.kind === "image" ? "1K" : "720p",
    priceCny: null,
    audio: false,
    sample: true,
    purged: false,
  }));
}

const modeLabel = (m: UiMode) => MODES.find((x) => x.id === m)!.label;
/**
 * 卡片上的钱是**售价**（人民币），不是我们付给上游的成本：`costUsdActual` 只留给
 * 管理员对账，用户看的和被扣的必须是同一个数（方案 §3.2）。
 */
const audioLabel = (audio: boolean) => (audio ? "有声" : "无声");

function workMeta(w: Work): string {
  const parts =
    w.kind === "image"
      ? [modeLabel(w.mode), w.quality, w.ratio]
      : [modeLabel(w.mode), `${w.dur}s`, w.ratio, w.quality, audioLabel(w.audio)];
  if (w.priceCny != null && w.priceCny > 0) parts.push(formatCny(w.priceCny));
  return parts.join(" · ");
}

function jobMeta(j: JobPublic): string {
  const mode = UI_MODE_OF[j.mode] ?? "t2v";
  const image = j.mode === "text_to_image";
  const parts = [modeLabel(mode), image ? (j.imageResolution ?? "1k").toUpperCase() : `${j.durationSec}s · ${j.resolution ?? "720p"}`, j.aspectRatio ?? "16:9"];
  // 音轨只对视频有意义；给一张图标「无声」是噪音。
  if (!image) parts.push(audioLabel(j.generateAudio));
  if (j.priceCny > 0) parts.push(formatCny(j.priceCny));
  parts.push(j.prompt || "首帧起始");
  return parts.join(" · ");
}

type Frame = { preview: string; uploadId: string | null; state: "busy" | "ready" | "error"; message?: string };

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// useJobLive 需要一个 job；没有任务时给它一个终态哑对象，effect 直接跳过
const NO_JOB = { id: "", status: "succeeded" } as const;

/** 顶栏只放 @ 前的部分；完整邮箱留在 title / aria-label 里 */
const shortName = (email: string) => email.split("@")[0] || email;
const QUOTA_EXHAUSTED = "今日额度已用完，北京时间 0 点重置";
/** 当前这套参数的售价超过可用余额时的提示（方案 §5 的用户原话）。 */
const BALANCE_SHORT = "当前配置，余额可能不够，请充值";

const Chevron = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export function LumenHome({
  initialJobs,
  mock,
  harness = false,
  videoProvider = "grok",
  videoModel = "grok-imagine-video",
  audioAvailable = true,
  initialEmail,
}: {
  initialJobs: JobPublic[];
  mock: boolean;
  harness?: boolean;
  /** 服务端解析的当前视频 provider（与 /api/health 的 videoProvider 同源），决定时长芯片 */
  videoProvider?: ProviderId;
  /** 服务端解析的视频模型名，只用于工作室读数（可灵实例显示 kling-2.6 而不是 grok） */
  videoModel?: string;
  /**
   * 当前实例的视频 provider 会不会真的出音轨（与 /api/health 的 audioAvailable 同源）。
   * 为假时「有声」芯片锁死在无声、标「暂不可用」——功能照常交付，供应商差异在这里吸收，
   * 而不是把入口藏掉让用户以为没这功能。
   */
  audioAvailable?: boolean;
  /** SSR 已经解析过会话，先用它渲染顶栏，避免首帧右上角空着 */
  initialEmail: string;
}) {
  const [jobs, setJobs] = useState<JobPublic[]>(initialJobs);
  const [view, setView] = useState<"home" | "works">("home");
  const [studio, setStudio] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [opts, setOpts] = useState<Opts>({});
  const [mode, setMode] = useState<UiMode>("t2v");
  // 可灵的时长枚举是 5 / 10，默认的 8 不在里面，所以初值直接落到第一档（5）；
  // 芯片上永远只出现「会被上游计费的那个时长」（方案 §4）。
  const baseDurs: readonly number[] = videoProvider === "kling" ? KLING_DURS : DURS;
  const [dur, setDur] = useState<number>(baseDurs.includes(DEFAULT_DUR) ? DEFAULT_DUR : baseDurs[0]);
  const [ratio, setRatio] = useState<Ratio>("16:9");
  // 有声是加价项（价目表里 +¥1），默认开——这是绝大多数人想要的，也是改动前的行为。
  const [audio, setAudio] = useState(true);
  const [first, setFirst] = useState<Frame | null>(null);
  const [job, setJob] = useState<JobPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [me, setMe] = useState<MePublic | null>(null);
  const [meTick, setMeTick] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [kind, setKind] = useState<Kind>("video");
  const [sel, setSel] = useState(0);
  const [hov, setHov] = useState(-1);
  const [angle, setAngle] = useState(0);
  const [entering, setEntering] = useState(true);
  const [ready, setReady] = useState(false);

  const dawn = useRef<DawnHandle | null>(null);
  const ring = useRef<RingHandle | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  const dragX = useRef<number | null>(null);
  const turn = useRef(0);
  const focusPending = useRef(false);

  const isVideo = mode !== "t2i";
  /*
    这次提交真正会不会出声：芯片状态 ∧ 实例能力。估价、请求体、芯片文案全都读它，
    所以「本次约 ¥x」与服务端写进 priceCny 的数不会因为芯片而分叉。
  */
  const audioOn = audioAvailable && audio;
  const works = useMemo(() => worksFromJobs(jobs), [jobs]);
  const recent = works.slice(0, 6);
  const list = useMemo(() => works.filter((w) => w.kind === kind), [works, kind]);
  const ringKey = `${kind}|${list.map((w) => w.still).join("|")}`;
  const ringRadius = Math.max(2.6, list.length * 0.58);

  /* ── 首屏进场只播一次；data-ready 供 e2e 判断已水合 ── */
  useEffect(() => {
    const t0 = window.setTimeout(() => setReady(true), 0);
    const t = window.setTimeout(() => setEntering(false), 2400);
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t);
    };
  }, []);

  /* ── 账号与配额：/api/me 是唯一来源，quota 由配额批次补上，缺失就整行不渲染 ── */
  // 事件处理里手动补一次读取（提交被拒时任务 id 不变，光靠下面的依赖触发不了）
  const refreshMe = useCallback(() => setMeTick((n) => n + 1), []);

  const email = me?.email ?? initialEmail;
  const quota = me?.quota;
  const quotaExhausted = !!quota && quota.remaining <= 0;
  const balance = me?.balance;
  /*
    本次售价：客户端和服务端跑的是同一个纯函数、同一张表（表随 /api/me 下来），所以
    面板上的「本次约 ¥x」就是 createJob 会写进 priceCny 的那个数。音轨是加价项，取的是
    芯片的**生效值**（`audioOn`），不再恒按有声估——不然可灵关声的实例会按有声报价却
    交付无声视频。唯一仍对不齐的是可灵实例的分辨率档（由服务端环境变量决定，浏览器
    看不见），那里这个数是下限，最终判定仍以服务端的 402 为准（方案 §3.2）。
  */
  const estimateCny = priceCny(
    mode === "t2i"
      ? { mode: "text_to_image", imageResolution: "1k" }
      : { mode: mode === "i2v" ? "image_to_video" : "text_to_video", durationSec: dur, resolution: "720p", generateAudio: audioOn },
    me?.prices,
  );
  // 余额读数缺失（旧服务端、或 /api/me 挂了）时不拦提交：拦了用户也没有别的路可走
  const balanceShort = !!balance && estimateCny > balance.availableCny;

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      // 整页跳转而不是 router.push：会话没了，客户端缓存里的任务数据也该一起丢掉
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    } catch (e) {
      setSigningOut(false);
      setError(e instanceof Error ? e.message : "退出失败");
    }
  }

  /* ── 任务跟踪 ── */
  const upsert = useCallback((j: JobPublic) => {
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [j, ...prev]));
  }, []);
  const onLive = useCallback(
    (j: JobPublic) => {
      setJob(j);
      upsert(j);
    },
    [upsert],
  );
  useJobLive(job ?? NO_JOB, onLive);

  const active = !!job && isActive(job.status);
  const working = busy || active;
  /*
    配额随任务变化：新任务占一个预留，终态成功转「已用」、失败 / 取消释放预留
    （方案 §6.1）。挂载、任务 id 变化、任务转终态、以及 meTick 被事件处理推进时
    各读一次 /api/me。setState 只发生在 then 回调里，effect 体内不同步改状态。
  */
  const jobId = job?.id ?? "";
  const jobTerminal = !!job && isTerminal(job.status);
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
  useEffect(() => {
    if (!active) return;
    const t0 = window.setTimeout(() => setNow(Date.now()), 0);
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(t);
    };
  }, [active]);
  // 生成中：地平线更亮、波幅更大；完成后回落
  useEffect(() => {
    dawn.current?.setEnergy(working ? 1 : 0);
  }, [working]);

  /* ── 作品页：拖拽 → 环旋转；重建环时把当前圈数带过去 ── */
  useEffect(() => {
    if (view === "home" && focusPending.current) {
      focusPending.current = false;
      textarea.current?.focus();
    }
  }, [view, studio]);

  const current = list.length ? list[hov >= 0 && hov < list.length ? hov : Math.min(sel, list.length - 1)] : null;

  /* ── 输入：首次出现非空内容即进入工作室；手动编辑时按"文本是否仍含该段"同步选中态 ── */
  function onPromptChange(v: string) {
    setPrompt(v);
    setOpts((prev) => {
      const next: Opts = {};
      for (const g of GROUPS) {
        const id = prev[g.id];
        if (id && v.includes(optionOf(g.id, id).text)) next[g.id] = id;
      }
      return next;
    });
    if (v.trim()) setStudio(true);
  }

  /* ── 选项飞入：在 body 上生成同样式的固定定位芯片，Web Animations 640ms 后落成提示词 ── */
  function fly(from: DOMRect, label: string, done: () => void) {
    const ta = textarea.current;
    if (!ta) return done();
    const to = ta.getBoundingClientRect();
    const el = document.createElement("span");
    el.className = "fly";
    el.textContent = label;
    el.style.left = `${from.left}px`;
    el.style.top = `${from.top}px`;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.remove();
      done();
    };
    if (typeof el.animate !== "function" || reducedMotion()) return finish();
    document.body.appendChild(el);
    const dx = to.left + 8 - from.left;
    const dy = to.bottom - 30 - from.top;
    const anim = el.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        { transform: `translate(${dx * 0.55}px,${dy * 0.35 - 40}px) scale(1.04)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx}px,${dy}px) scale(.7)`, opacity: 0 },
      ],
      { duration: 640, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" },
    );
    anim.onfinish = finish;
    anim.oncancel = finish;
    window.setTimeout(finish, 720);
  }

  function pickOpt(g: Group, o: Option, e: React.MouseEvent<HTMLButtonElement>) {
    const prev = opts[g.id];
    if (prev === o.id) {
      const next = { ...opts };
      delete next[g.id];
      setOpts(next);
      setPrompt((p) => stripSeg(p, o.text));
      return;
    }
    fly(e.currentTarget.getBoundingClientRect(), o.label, () => {
      setOpts((cur) => ({ ...cur, [g.id]: o.id }));
      setPrompt((cur) => {
        const base = prev ? stripSeg(cur, optionOf(g.id, prev).text) : cur;
        return base.trim() ? `${base.replace(/\s+$/, "")}\n\n${o.text}` : o.text;
      });
      setStudio(true);
    });
  }

  /* ── 首帧：回形针选图，自动切到图生视频；再点一次移除 ── */
  async function pickFirst(file: File | undefined) {
    if (!file) return;
    if (first?.preview) URL.revokeObjectURL(first.preview);
    const preview = URL.createObjectURL(file);
    setFirst({ preview, uploadId: null, state: "busy" });
    if (mode === "t2v") setMode("i2v");
    setError(null);
    try {
      const up = await uploadFile(file, "start");
      setFirst({ preview, uploadId: up.uploadId, state: "ready" });
    } catch (e) {
      setFirst({ preview, uploadId: null, state: "error", message: e instanceof Error ? e.message : "上传失败" });
    }
  }
  function toggleFirst() {
    if (first) {
      URL.revokeObjectURL(first.preview);
      setFirst(null);
      return;
    }
    firstInput.current?.click();
  }

  /* ── 时长 / 画幅：点击循环；开启 harness 时时长多出 30 / 45 / 60（仅视频） ── */
  const durOptions: readonly number[] = harness ? [...baseDurs, ...HARNESS_DURATIONS] : baseDurs;
  const cycleDur = () => setDur((d) => durOptions[(durOptions.indexOf(d) + 1) % durOptions.length]);
  const cycleRatio = () => setRatio((r) => RATIOS[(RATIOS.indexOf(r) + 1) % RATIOS.length]);
  /** 实例不支持音轨时芯片是死的：点了也不改状态，免得估价与成片再次分叉 */
  const cycleAudio = () => {
    if (!audioAvailable) return;
    setAudio((a) => !a);
  };

  /* ── 提交：沿用 /api/jobs 契约（createJobBodySchema，无 model 字段） ── */
  async function submit() {
    if (working) return;
    setError(null);
    try {
      if (quotaExhausted) throw new Error(QUOTA_EXHAUSTED);
      if (balanceShort) throw new Error(BALANCE_SHORT);
      if (mode !== "i2v" && !prompt.trim()) throw new Error("这条路径需要提示词");
      if (mode === "i2v" && first?.state !== "ready") throw new Error(first?.state === "busy" ? "首帧还在上传，请稍候" : "图生视频需要先选一张首帧");
      setBusy(true);
      setStudio(true);
      // 网络抖动时沿用同一个 key，服务端回放原任务而不是重复计费
      idempotencyKey.current ??= newIdempotencyKey();
      const native = MODES.find((m) => m.id === mode)!.native;
      const body: Record<string, unknown> = { mode: native, prompt, idempotencyKey: idempotencyKey.current };
      if (mode === "t2i") {
        body.aspectRatio = ratio;
        body.imageResolution = "1k";
      } else {
        body.durationSec = dur;
        body.aspectRatio = ratio;
        body.resolution = "720p";
        body.generateAudio = audioOn;
        if (mode === "i2v") body.startUploadId = first!.uploadId;
      }
      const created = await createJob(body);
      idempotencyKey.current = null;
      setJob(created);
      upsert(created);
    } catch (e) {
      // 402 insufficient_balance / 429 quota_exceeded / failure_limit_reached：服务端消息原样展示
      setError(e instanceof Error ? e.message : String(e));
      refreshMe();
    } finally {
      setBusy(false);
    }
  }

  /* ── 取消 / 重试：取消改写当前任务；重试是服务端复制出的新任务 ── */
  async function cancel() {
    if (!job || busy || !isActive(job.status)) return;
    setError(null);
    setBusy(true);
    try {
      onLive(await cancelJob(job.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (!job || busy || (job.status !== "failed" && job.status !== "expired")) return;
    // Second line of defence behind the server's 409: a shot may already be paid for upstream.
    if (job.retryBlocked) return;
    setError(null);
    setBusy(true);
    try {
      // 重试也向上游发新的计费请求，同样走配额（方案 §6.2）
      onLive(await retryJob(job.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refreshMe();
    } finally {
      setBusy(false);
    }
  }

  /* ── 视图切换 ── */
  function goHome() {
    setView("home");
    setStudio(false);
  }
  function goWorks() {
    setHov(-1);
    setView("works");
  }
  function openWork(w: Work) {
    const i = works.filter((x) => x.kind === w.kind).indexOf(w);
    setKind(w.kind);
    setSel(Math.max(0, i));
    setHov(-1);
    setView("works");
  }
  function switchKind(k: Kind) {
    if (k === kind) return;
    setKind(k);
    setSel(0);
    setHov(-1);
  }
  /** 用这条提示词再生成：图生视频的首帧无法复用，回落到文生视频 */
  function reuse(w: Work) {
    setPrompt(w.prompt);
    setOpts({});
    setMode(w.mode === "i2v" ? "t2v" : w.mode);
    setError(null);
    focusPending.current = true;
    setView("home");
    setStudio(true);
  }

  /* ── 派生读数 ── */
  const done = !!job && job.status === "succeeded" && !!job.output;
  const failed = !!job && isFailed(job.status);
  const pct = job ? Math.round(done ? 100 : job.progress) : 0;
  const shotsDone = job?.shots ? job.shots.filter((s) => s.status === "succeeded").length : 0;
  const stage = !job
    ? "排队中"
    : job.status === "generating_shots" && job.shots
      ? `生成分镜 ${shotsDone}/${job.shots.length}`
      : STAGE_LABEL[job.status];
  const clock = job ? formatElapsed(job.createdAt, isTerminal(job.status) ? new Date(job.updatedAt).getTime() : now) : "00:00";
  const exhibitState: "idle" | "busy" | "done" | "failed" = working ? "busy" : done ? "done" : failed ? "failed" : "idle";
  const longForm = isVideo && isHarnessDuration(dur);
  const longCost = longForm ? estimateHarnessCostUsd(packHarnessDuration(dur)) : 0;
  const modelName = `${isVideo ? videoModel : "grok-imagine-image"}${longForm ? ` · ≈ $${longCost.toFixed(2)}` : ""}${mock ? " · 模拟" : ""}`;
  const placeholder = mode === "i2v" ? "已选首帧，提示词可选" : mode === "t2i" ? "清晨山谷薄雾，一束光落在湖面" : "清晨山谷薄雾，镜头缓慢推进…";
  const rows = studio ? Math.min(7, Math.max(3, prompt.split("\n").length)) : 2;
  const exhibitBottom = 236 + (rows - 3) * 23;
  const angleLabel = `${String(angle).padStart(3, "0")}°`;
  const retryLabel = job?.shots?.length ? "重做失败分镜" : "重新生成";
  // 悬停才展开的三个数：面板上只放「本次约 / 余额」，预留是解释「钱去哪了」用的
  const balanceHint = balance
    ? `余额 ${formatCny(balance.balanceCny)}，在途预留 ${formatCny(balance.reservedCny)}，可用 ${formatCny(balance.availableCny)}`
    : undefined;

  return (
    <div className="app" data-enter={entering} data-ready={ready} data-view={view}>
      <SceneHost
        className="app__dawn"
        aria-hidden="true"
        mount={(c) => mountDawn(c, { horizon: 0.46 })}
        onReady={(h) => {
          dawn.current = h;
        }}
      />
      {view === "works" ? (
        <SceneHost
          key={ringKey}
          className="works__canvas"
          aria-label="作品环，拖拽旋转"
          mount={(c) =>
            mountRingDark(c, {
              images: list.map((w) => w.still),
              radius: ringRadius,
              autoRotate: true,
              onSelect: setSel,
              onHover: setHov,
              onTurn: setAngle,
            })
          }
          onReady={(h) => {
            ring.current = h;
            h?.setScroll(turn.current);
          }}
          onPointerDown={(e) => {
            dragX.current = e.clientX;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragX.current == null) return;
            const d = (e.clientX - dragX.current) / window.innerWidth;
            dragX.current = e.clientX;
            turn.current -= d * 0.6;
            ring.current?.setScroll(turn.current);
          }}
          onPointerUp={() => {
            dragX.current = null;
          }}
          onPointerCancel={() => {
            dragX.current = null;
          }}
        />
      ) : null}

      <div className="frame" data-studio={view === "home" && studio}>
        {/* ── 顶栏 ── */}
        <header className="top">
          <button type="button" className="brand" onClick={goHome} aria-label="Genius，回首页">
            <span className="brand__ring" aria-hidden="true" />
            Genius
          </button>
          <nav className="nav" aria-label="主导航">
            <button type="button" className="nav__item" data-on={view === "home"} onClick={goHome}>
              首页
            </button>
            <button type="button" className="nav__item" data-on={view === "works"} onClick={goWorks}>
              作品
            </button>
            <button type="button" className="nav__item" aria-disabled="true" title="即将推出">
              我的
            </button>
          </nav>
          <div className="account">
            <span className="account__name" title={email} aria-label={`当前账号 ${email}`}>
              {shortName(email)}
            </span>
            {/* 余额跟着账号名一起在极窄屏隐藏：那点宽度先留给「退出」 */}
            {balance ? (
              <span
                className="account__balance"
                title={`余额 ${formatCny(balance.balanceCny)}，在途预留 ${formatCny(balance.reservedCny)}`}
                aria-label={`余额 ${formatCny(balance.balanceCny)}`}
              >
                余额 {formatCny(balance.balanceCny)}
              </span>
            ) : null}
            <button type="button" className="login" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut ? "退出中" : "退出"}
            </button>
          </div>
        </header>

        {view === "home" ? (
          <div className="stage" data-studio={studio} style={{ "--exhibit-bottom": `${exhibitBottom}px` } as React.CSSProperties}>
            <div className="hero" aria-hidden={studio}>
              <h1 className="hero__title">创建你的世界</h1>
            </div>

            {/* ── 操作台 ── */}
            <aside className="console" aria-label="操作台" aria-hidden={!studio}>
              <div className="console__panel">
                {GROUPS.map((g) => (
                  <div key={g.id} className="group">
                    <div className="group__head">
                      <span>{g.title}</span>
                      <span className="group__current">{opts[g.id] ? optionOf(g.id, opts[g.id]!).label : ""}</span>
                    </div>
                    <div className="group__chips" role="group" aria-label={g.title}>
                      {g.options.map((o) => (
                        <button key={o.id} type="button" className="chip" aria-pressed={opts[g.id] === o.id} data-on={opts[g.id] === o.id} tabIndex={studio ? 0 : -1} onClick={(e) => pickOpt(g, o, e)}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            {/* ── 展览区 ── */}
            <div className="exhibit-wrap" aria-hidden={!studio}>
              <div className="exhibit" data-state={exhibitState} data-kind={job?.output?.kind ?? ""} data-job-id={job?.id ?? ""} data-status={job?.status ?? ""} aria-live="polite">
                <ClothVeil state={exhibitState} />
                {exhibitState === "idle" ? <span className="exhibit__hint">预览</span> : null}
                {exhibitState === "busy" ? (
                  <>
                    <div className="exhibit__center">
                      <span className="exhibit__pct">{pct}%</span>
                      <span className="exhibit__stage">
                        {stage} · {clock}
                      </span>
                      {active ? (
                        <div className="exhibit__links">
                          <button type="button" className="exhibit__link" disabled={busy} onClick={() => void cancel()}>
                            取消
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="exhibit__bar" style={{ width: `${pct}%` }} />
                  </>
                ) : null}
                {exhibitState === "failed" && job ? (
                  <div className="exhibit__center">
                    <span className="exhibit__pct">{STAGE_LABEL[job.status]}</span>
                    <span className="exhibit__stage">
                      {stage} · {clock}
                    </span>
                    {job.error ? (
                      <span className="exhibit__err" role="alert">
                        {job.error.message}
                      </span>
                    ) : null}
                    {job.retryBlocked ? (
                      <span className="exhibit__blocked" role="alert">
                        {job.retryBlocked.message}
                      </span>
                    ) : null}
                    <div className="exhibit__links">
                      {(job.status === "failed" || job.status === "expired") && !job.retryBlocked ? (
                        <button type="button" className="exhibit__link" disabled={busy} onClick={() => void retry()}>
                          {retryLabel}
                        </button>
                      ) : null}
                      <button type="button" className="exhibit__link" onClick={() => setJob(null)}>
                        关闭
                      </button>
                    </div>
                  </div>
                ) : null}
                {exhibitState === "done" && job?.output ? (
                  <>
                    <div className="exhibit__media">
                      {job.output.kind === "video" ? (
                        <video key={job.id} src={job.output.videoUrl} poster={job.output.posterUrl} controls playsInline preload="metadata" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={job.id} src={job.output.imageUrl} alt={job.prompt || "生成图像"} />
                      )}
                    </div>
                    <div className="exhibit__foot">
                      <span className="exhibit__meta" title={jobMeta(job)}>
                        {jobMeta(job)}
                      </span>
                      <a className="exhibit__action" href={`${job.output.kind === "video" ? job.output.videoUrl : job.output.imageUrl}?download=1`} download>
                        下载
                      </a>
                      <button type="button" className="exhibit__action exhibit__action--dim" onClick={() => setJob(null)}>
                        关闭
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            {/* ── 输入卡 ── */}
            <div className="composer-pos">
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <textarea
                  ref={textarea}
                  className="composer__text"
                  rows={rows}
                  value={prompt}
                  maxLength={2000}
                  placeholder={placeholder}
                  aria-label="提示词"
                  onChange={(e) => onPromptChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div className="composer__bar">
                  <div className="composer__chips" role="radiogroup" aria-label="路径">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={mode === m.id}
                        data-on={mode === m.id}
                        onClick={() => {
                          setMode(m.id);
                          setError(null);
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                    {isVideo ? (
                      <button type="button" className="chip chip--menu" data-dur={dur} aria-label={`时长 ${dur} 秒，点击切换`} title="点击切换时长" onClick={cycleDur}>
                        {dur}s
                        <Chevron />
                      </button>
                    ) : null}
                    <button type="button" className="chip chip--menu" data-ratio={ratio} aria-label={`画幅 ${ratio}，点击切换`} title="点击切换画幅" onClick={cycleRatio}>
                      {ratio}
                      <Chevron />
                    </button>
                    {/*
                      有声 / 无声。实例不支持音轨时不隐藏这个入口，而是标「暂不可用」——
                      藏起来用户只会以为产品没这功能，说清楚才知道是这台实例的事。
                    */}
                    {isVideo ? (
                      <button
                        type="button"
                        className="chip chip--menu"
                        data-audio={audioOn ? "on" : "off"}
                        aria-disabled={audioAvailable ? undefined : true}
                        aria-label={audioAvailable ? (audioOn ? "有声，点击切换为无声" : "无声，点击切换为有声") : "无声，当前视频服务暂不支持音轨"}
                        title={audioAvailable ? "点击切换音轨（有声加价）" : "当前视频服务未开启音轨，暂不可用"}
                        onClick={cycleAudio}
                      >
                        {audioAvailable ? audioLabel(audioOn) : `${audioLabel(false)} · 暂不可用`}
                        {audioAvailable ? <Chevron /> : null}
                      </button>
                    ) : null}
                    {/* 本次售价与可用余额由 /api/me 提供；字段缺失时整行不渲染 */}
                    {balance ? (
                      <span className="composer__quota" data-empty={balanceShort} title={balanceHint}>
                        本次约 {formatCny(estimateCny)} · 余额 {formatCny(balance.availableCny)}
                      </span>
                    ) : null}
                  </div>
                  <div className="composer__cluster">
                    <span className="composer__model">{modelName}</span>
                    <button
                      type="button"
                      className="composer__clip"
                      data-on={!!first}
                      data-state={first?.state ?? ""}
                      aria-label={first ? "移除首帧" : "选择首帧"}
                      title={first?.message ?? (first ? "移除首帧" : "选择首帧（会切到图生视频）")}
                      onClick={toggleFirst}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                    </button>
                    <button
                      type="submit"
                      className="composer__send"
                      aria-label={working ? `生成中 ${pct}%` : quotaExhausted ? QUOTA_EXHAUSTED : balanceShort ? BALANCE_SHORT : "生成"}
                      title={quotaExhausted ? QUOTA_EXHAUSTED : balanceShort ? BALANCE_SHORT : undefined}
                      data-busy={working}
                      disabled={working || quotaExhausted || balanceShort}
                      style={{ "--p": `${pct}%` } as React.CSSProperties}
                    >
                      {working ? (
                        <span className="composer__send-pct">{pct}%</span>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#15171c" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m5 12 7-7 7 7" />
                          <path d="M12 19V5" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                {error ? (
                  <p className="composer__error" role="alert">
                    {error}
                  </p>
                ) : quotaExhausted ? (
                  <p className="composer__error composer__error--quota">{QUOTA_EXHAUSTED}</p>
                ) : balanceShort ? (
                  // 余额不够是「换个配置或去充值」，不是报错，但要比配额那行更显眼
                  <p className="composer__error composer__error--balance">{BALANCE_SHORT}</p>
                ) : null}
              </form>
            </div>

            {/* ── 最近成片 ── */}
            <div className="recent" aria-label="最近成片" aria-hidden={studio}>
              {recent.map((w, i) => (
                <button
                  key={w.key}
                  type="button"
                  className="recent__item"
                  data-purged={w.purged}
                  title={w.purged ? `${w.prompt}（作品已过期清理）` : w.prompt}
                  aria-label={w.purged ? `${w.prompt}，作品已过期清理` : w.prompt}
                  tabIndex={studio ? -1 : 0}
                  style={{ backgroundImage: `url(${w.still})`, "--delay": `${(1.08 + i * 0.06).toFixed(2)}s` } as React.CSSProperties}
                  onClick={() => openWork(w)}
                />
              ))}
            </div>
          </div>
        ) : (
          <main className="works">
            <div className="works__tabs">
              <div className="pill" role="tablist" aria-label="作品类型">
                {(["video", "image"] as const).map((k) => (
                  <button key={k} type="button" role="tab" className="tab" aria-selected={kind === k} data-on={kind === k} onClick={() => switchKind(k)}>
                    {k === "video" ? "视频" : "图片"}
                    <span className="tab__count">{works.filter((w) => w.kind === k).length}</span>
                  </button>
                ))}
              </div>
            </div>
            {!list.length ? <span className="works__empty">还没有{kind === "video" ? "视频" : "图片"}作品</span> : null}
            {current?.purged ? (
              <div className="works__purged" role="status">
                <span className="works__purged-title">作品已过期清理</span>
                <span className="works__purged-hint">超过留存期的成片与素材已删除，可用这条提示词重新生成</span>
              </div>
            ) : null}
            <div className="works__foot">
              <div className="works__info">
                <span className="works__meta">{current ? workMeta(current) : ""}</span>
                <p className="works__prompt">{current?.prompt ?? ""}</p>
              </div>
              <div className="works__actions">
                <span className="works__angle">{angleLabel} · 拖拽旋转</span>
                <button type="button" className="btn-glass" disabled={!current} onClick={() => current && reuse(current)}>
                  用这条提示词再生成
                </button>
                {current && !current.purged ? (
                  <a className="btn-light" href={current.sample ? current.media : `${current.media}?download=1`} download>
                    下载
                  </a>
                ) : null}
              </div>
            </div>
          </main>
        )}
      </div>

      <input
        ref={firstInput}
        type="file"
        accept="image/*"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          void pickFirst(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
