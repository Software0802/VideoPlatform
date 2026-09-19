"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { JobPublic } from "@/lib/jobs/schema";
import type { AspectRatio, ImageResolution, NativeMode, Resolution } from "@/lib/providers/types";
import { DEFAULT_PRICE_TABLE, priceCny, priceTableFor } from "@/lib/billing/prices";
import { HARNESS_DURATIONS, isHarnessDuration } from "@/lib/harness/durations";
import { createJob, newIdempotencyKey, uploadFile, uploadFromJob } from "@/lib/client/jobs";
import { fetchProducts, supportsMode, type Product } from "@/lib/client/models";
import { fetchTemplates, type Template } from "@/lib/client/templates";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import { errorText } from "@/lib/i18n/errorText";
import { MAX_IMAGE_BYTES, MAX_IMAGE_LABEL } from "@/lib/media/upload-limits";
import {
  MAX_COUNT,
  creditsOf,
  type ComposerTab,
  type Frame,
  type Pop,
  type SlotTarget,
  type VideoMode,
} from "./shared";
import { useSessionBridge } from "./SessionProvider";
import { useNoticesBridge } from "./NoticesProvider";
import { useJobsBridge } from "./JobsProvider";

/*
  创作面板域：面板开合 / 标签页 / 模式 / 规格选择 / 图片槽 / 幂等 key / 提交流程，
  以及「产品目录 `/api/models`」——面板的可选项全部由当前选中的产品决定
  （分辨率 / 画幅 / 时长 / 音轨 / 首尾帧 / 参考图上限），`/api/models` 拿不到时
  （老服务端、网络抖动）整套回落到 `caps.*` 下发的枚举，界面照常可用，只是参考 /
  首尾帧两个模式保持置灰——宁可少露出一个功能，也不能让用户选一个提交必然 400 的东西。
*/

export type ComposerShell = {
  /* 产品（`/api/models`） */
  products: Product[];
  /** 产品表拉完了没有（成功或失败都算完）：拉到之前不能替这台实例断言「没有这种模型」。 */
  productsLoaded: boolean;
  /** 读产品表时的那个错误——「读不到」与「读到了但没有」是两回事。 */
  productsError: unknown;
  /** 当前标签页下可选的产品（视频页只列 video、图片页只列 image） */
  productChoices: Product[];
  /** 当前生效的产品；`/api/models` 还没回来或这台实例没有该类产品时为 null */
  product: Product | null;
  pickProduct: (id: string) => void;

  /* 面板 */
  open: boolean;
  openComposer: () => void;
  tab: ComposerTab;
  pickTab: (tab: ComposerTab) => void;
  mode: VideoMode;
  pickMode: (mode: VideoMode) => void;
  /**
   * 这个模式此刻不能用的具体理由（已翻译），能用为 `null`。置灰项照常渲染，
   * 但不再一律说「即将上线」。
   */
  modeReason: (mode: VideoMode) => string | null;
  /** 「模板」按钮不可用的理由（这台实例没配模板），可用为 `null`。 */
  templateReason: string | null;
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
  /** 当前时长在不在长片（多镜头）档；开关读它。 */
  multi: boolean;
  /** 这台实例有没有长片档可切（`HARNESS_ENABLED` + 产品声明 `supportsLongForm`）。 */
  multiAvailable: boolean;
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
  /** 面板提示行的实际文案：`error`，或「按钮为什么是灰的」（在途任务 / 额度 / 余额）。 */
  notice: string | null;
  /** 这一行是错误还是状态说明——决定颜色与读屏播报级别。 */
  noticeTone: "error" | "info";
  submit: () => void;
  /** 「用这条提示词再生成」：回填面板并展开 */
  reuse: (prompt: string, kind: "video" | "image") => void;
  /** 模板卡片：把预置的提示词与参数回填进面板并展开 */
  applyTemplate: (template: Template) => void;
  /** `GET /api/templates` 的清单；模式行旁的「模板」按钮列它，空表示这台实例没配模板。 */
  templates: Template[];
  /** 清单拉完了没有（成功或失败都算完）：主页模板页签靠它区分「还在读」与「没有」。 */
  templatesLoaded: boolean;
  /** 读清单时的那个错误，原样给出——由取用的视图按当前语言译。 */
  templatesError: unknown;
  /** 音频页：选一个带原生音轨的视频产品，切到视频页并打开音轨。 */
  useAudioProduct: (productId: string) => void;
};

const Ctx = createContext<ComposerShell | null>(null);

export function useComposer(): ComposerShell {
  const value = useContext(Ctx);
  if (!value) throw new Error("useComposer 必须在 ComposerProvider 内使用");
  return value;
}

const ALL_RES: readonly Resolution[] = ["480p", "720p", "1080p"];
const ALL_IMAGE_RES: readonly ImageResolution[] = ["1k", "2k"];
const ALL_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
/** 服务端没下发画幅时的兜底（三家视频 provider 都接得下的那几个） */
const VIDEO_RATIO_FALLBACK: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];
/** 服务端没下发时长时的兜底（grok / mock 的档位） */
const DUR_FALLBACK = [4, 6, 8, 10] as const;
const DEFAULT_DUR = 5;
const DEFAULT_RES: Resolution = "720p";

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

export function ComposerProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const t = useT();
  const { caps, me, error, setError, refreshMe } = useSessionBridge();
  const { showToast, noteJob } = useNoticesBridge();
  const { working, upsert, setBusy, setCurrentJob } = useJobsBridge();

  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [productsError, setProductsError] = useState<unknown>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesError, setTemplatesError] = useState<unknown>(null);
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
  const [count, setCountState] = useState(1);
  const [image, setImage] = useState<Frame | null>(null);
  const [lastImage, setLastImage] = useState<Frame | null>(null);
  const [refs, setRefs] = useState<Frame[]>([]);

  /*
    幂等 key：一次逻辑创作 n 个（数量芯片），第 i 条任务一个（方案 §3 + 阶段 A §5）。
    提交失败（网络抖动、5xx）时整批复用同一组 key 重试：已经建成的那几条会被服务端按
    key 回放成原任务而不重复计费，没建成的继续用自己的 key 建。用户改了提示词或任一
    选项就算另一次创作，整组作废。
  */
  const keys = useRef<string[]>([]);

  const dropKey = useCallback(() => {
    keys.current = [];
  }, []);

  /* ── 产品：/api/models 是唯一来源 ── */
  useEffect(() => {
    let alive = true;
    void fetchProducts().then(
      (list) => {
        if (!alive) return;
        setProducts(list);
        setProductsLoaded(true);
      },
      (e: unknown) => {
        // 老服务端没有这个路由、或一次网络抖动：面板回落 caps 下发的枚举，不打断使用。
        // 但「读不到」要记下来：置灰理由不能拿它当「这台实例没有这种模型」讲。
        if (!alive) return;
        setProductsError(e);
        setProductsLoaded(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  /*
    模板清单（`GET /api/templates`）：模式行旁的「模板」按钮、主页的模板 / 挑战页签与
    活动横幅都读这一份，全站只拉一次。拉不到对面板来说就是空表，按钮自己置灰并说
    「这台实例还没配模板」，不再是一句「即将上线」；主页那边把错误如实说出来。
  */
  useEffect(() => {
    let alive = true;
    void fetchTemplates().then(
      (list) => {
        if (!alive) return;
        setTemplates(list);
        setTemplatesLoaded(true);
      },
      (e: unknown) => {
        if (!alive) return;
        setTemplatesError(e);
        setTemplatesLoaded(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  /*
    `pop` 驱动的悬浮层（规格 / 模型 / 数量 / 搭子 / 素材库 / 模板）共用一条 Esc 收层
    （H4）：在 Provider 挂一次 keydown 就够，各浮层自己不用重复绑。点开关件 /
    点外层的既有收层路径不变。
  */
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPop(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pop]);

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
        : // 上传失败的首帧不算「有图」（review 2026-09-15 U-01）：否则一次失败的上传会把
          // 这次提交顶成 image_to_video，产品、价格、校验全跟着换，而槽位里根本没有图。
          image && image.state !== "error"
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
  const resolutions: readonly Resolution[] = useMemo(
    () =>
      tab === "video" && mode === "firstLast" && productRes.includes("1080p") ? (["1080p"] as const) : productRes,
    [tab, mode, productRes],
  );
  const imageResolutions: readonly ImageResolution[] = product?.imageResolutions?.length
    ? product.imageResolutions
    : ALL_IMAGE_RES;

  const baseDurs: readonly number[] = useMemo(
    () =>
      product?.durations?.length
        ? product.durations
        : caps.videoDurations?.length
          ? caps.videoDurations
          : DUR_FALLBACK,
    [product, caps.videoDurations],
  );
  /*
    长片（30 / 45 / 60）是一致性管线的档位，由 `HARNESS_ENABLED` 追加。但它只对**时长
    连续**的那条通道成立：按档计费的产品（`durations` 非空）在服务端会被
    `product-choice.ts` 直接 400（「所选模型不支持 30 / 45 / 60 秒长片」），把 30 留在芯片上
    等于给用户一个点了必被拒的档。产品还没拉到时照旧追加（回落到换产品之前的行为）。
  */
  // 长片档位由产品声明（`supportsLongForm`），没有产品信息时才退回「管线开着就给」。
  const longForm = caps.harness && (product ? product.supportsLongForm : true);
  const durs: readonly number[] = useMemo(
    () => (longForm ? [...baseDurs, ...HARNESS_DURATIONS] : baseDurs),
    [longForm, baseDurs],
  );

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

  /*
    「多镜头」不是请求体里的一个字段（`createJobBodySchema` 是 strict，压根没有它）。
    真·分镜走的是 30/45/60 秒长片档（`HARNESS_DURATIONS` + `HARNESS_ENABLED`，进度按
    `job.shots` 显示）。所以这枚开关读的就是「当前时长在不在长片档」，点它在长片档与
    常规档之间切时长——原来它恒为关、点了只说「即将上线」（review 2026-09-15 C-02）。
  */
  const multiAvailable = longForm;
  const multi = isHarnessDuration(dur);
  const preMultiDur = useRef<number | null>(null);

  const balance = me?.balance;
  const quota = me?.quota;
  const quotaExhausted = !!quota && quota.remaining <= 0 && tab === "image";

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
    priceTableFor(me?.prices ?? DEFAULT_PRICE_TABLE, product?.price),
  );
  const batchPrice = price * count;
  const sendCredits = tab === "audio" ? 0 : creditsOf(batchPrice);
  const balanceShort = !!balance && batchPrice > balance.availableCny && tab !== "audio";
  /*
    提示行（契约 §7 `.composer__error`）：真提交失败时显示服务端那句话；没提交过但按钮本来
    就按不下去时，把原因常驻显示——否则用户只看见一个灰按钮，不知道是上一条还在跑、今天的
    额度用完了，还是余额不够（方案 §4「余额不足按钮禁用 + 错误行」，review 2026-09-15 U-14）。

    `error` 必须排在最前：提交失败后可能仍有活任务（部分失败那条路径就是），顺序反了会把
    402/429 盖成一句「上一条还在生成中」。working 排在额度与余额之前，与发送钮 title 的
    三元同序。忙碌不是错误，所以另给一个 tone，让颜色与播报级别跟着变。
  */
  const notice =
    error ??
    (working
      ? t("composer.jobRunning")
      : quotaExhausted
        ? t("composer.quotaExhausted")
        : balanceShort
          ? t("composer.balanceShort")
          : null);
  const noticeTone: "error" | "info" = !error && working ? "info" : "error";

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
    [dropKey, setError],
  );

  /*
    产品表还没读到时，凭什么替这台实例说「没有支持首尾帧的模型」？没读到就说没读到：
    参考 / 首尾帧 / 有声三条判据全看产品表，表不在手里就先报这一句，读到了再按真能力讲。
  */
  const productUnknown: MessageKey | null = !productsLoaded
    ? "composer.mode.block.productsLoading"
    : productsError
      ? "composer.mode.block.productsError"
      : null;

  /**
   * 这个模式此刻为什么不能用——能用就是 `null`。
   *
   * 每条都有具体理由，不再一律「即将上线」：参考 / 首尾帧 / 有声看的是当前产品与产品表
   * 的真实能力，编辑 / 续写 / 动作模仿是平台这一侧还没有的东西——说清楚是哪一种，用户
   * 才知道换个产品有没有用。
   */
  const modeBlock = useCallback(
    (m: VideoMode): MessageKey | null => {
      switch (m) {
        case "prompt":
          return null;
        case "reference":
          return (
            productUnknown ??
            (maxRefs > 0 && !!product && supportsMode(product, "reference_to_video")
              ? null
              : "composer.mode.block.reference")
          );
        case "firstLast":
          return (
            productUnknown ??
            (productChoices.some((p) => p.supportsLastFrame) ? null : "composer.mode.block.firstLast")
          );
        case "voice":
          // 「人声」= 出带声音的成片。平台唯一能保证有声的路径是原生音轨产品
          // （`product.audio === "native"`，与音轨开关同一判据）。
          return (
            productUnknown ??
            (productChoices.some((p) => p.audio === "native") ? null : "composer.mode.block.voice")
          );
        case "edit":
        case "extend":
          // 后端保留了 `edit_video` / `extend_video`，但没有「拿哪条成片来改」的入口，
          // 当前也没有 provider 承接（AGENTS.md「edit/extend UI 继续置灰」）。
          return "composer.mode.block.noSource";
        default:
          return "composer.mode.block.unsupported";
      }
    },
    [maxRefs, product, productChoices, productUnknown],
  );

  /** 置灰项的具体理由（已翻译）；能用就是 `null`。 */
  const modeReason = useCallback(
    (m: VideoMode): string | null => {
      const key = modeBlock(m);
      return key ? t(key) : null;
    },
    [modeBlock, t],
  );
  /** 「模板」不在模式行里（见 `shared.ts`），理由单独给一份。 */
  const templateReason = !templatesLoaded
    ? null
    : templatesError
      ? t("composer.mode.block.templateError")
      : templates.length
        ? null
        : t("composer.mode.block.template");

  const pickMode = useCallback(
    (next: VideoMode) => {
      /*
        先问「这个模式此刻能不能用」，再谈自动换产品：芯片的 title 与点下去那句提示
        必须是同一句话。产品表还没读到 / 读不到时，`modeBlock` 说的是「不知道」，
        这里就不能替它改口说「这台实例没有支持首尾帧的模型」。
      */
      const block = modeBlock(next);
      if (block) {
        showToast(t(block));
        return;
      }
      if (next === "firstLast") {
        // 切到首尾帧时当前产品不支持，就自动换到第一个支持的产品并说一声（阶段 A §4）
        if (!supportsLastFrame) {
          const alt = productChoices.find((p) => p.supportsLastFrame);
          if (alt) {
            setVideoProductId(alt.id);
            showToast(t("composer.lastFrame.switched", { name: alt.name }));
          }
        }
        setMode(next);
        setPop(null);
        dropKey();
        return;
      }
      if (next === "voice") {
        // 当前产品出不了声就换到能出声的那个，并把音轨开关打开——这个模式的意义就是有声。
        if (!audioAvailable) {
          const alt = productChoices.find((p) => p.audio === "native");
          if (alt) {
            setVideoProductId(alt.id);
            showToast(t("composer.voice.switched", { name: alt.name }));
          }
        }
        setAudio(true);
        setMode(next);
        setPop(null);
        dropKey();
        return;
      }
      setMode(next);
      setPop(null);
      dropKey();
    },
    [audioAvailable, dropKey, modeBlock, productChoices, showToast, supportsLastFrame, t],
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
        if (m === "voice" && next.audio !== "native") return "prompt";
        return m;
      });
      setPop(null);
      setError(null);
      dropKey();
    },
    [dropKey, productChoices, setError],
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
    if (audio) setMode((m) => (m === "voice" ? "prompt" : m));
    setAudio((a) => !a);
    dropKey();
  }, [audio, audioAvailable, dropKey, showToast, t]);
  /** 在长片档与常规档之间切时长（见 `multi` 的说明）；这台实例没开长片管线就说清楚。 */
  const toggleMulti = useCallback(() => {
    if (!multiAvailable) {
      showToast(t("composer.multi.unavailable"));
      return;
    }
    if (multi) {
      const prev = preMultiDur.current;
      setDurChoice(prev !== null && baseDurs.includes(prev) ? prev : null);
    } else {
      preMultiDur.current = dur;
      setDurChoice(HARNESS_DURATIONS[0]);
    }
    dropKey();
  }, [baseDurs, dropKey, dur, multi, multiAvailable, showToast, t]);
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
      /*
        先在本地拦掉两类必然被服务端拒掉的输入（review 2026-09-15 U-01）：原来这两种都是
        「槽位里出现一个裂图、错误行不出现」，用户既不知道为什么没上去，也不知道上限是
        6MB。`file.type` 为空（认不出扩展名）时不拦，交给服务端按真实字节判。
      */
      if (file.type && !file.type.startsWith("image/")) {
        setError(t("composer.err.notImage"));
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(t("composer.err.imageTooLarge", { limit: MAX_IMAGE_LABEL }));
        return;
      }
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
        (e: unknown) => {
          const message = errorText(t, e);
          settle({ preview, uploadId: null, state: "error", message });
          // 原因必须出现在 `.composer__error`：只写进帧里的话，界面上就只有一个裂图
          // 加一个 ×，要等用户点了「创作」才第一次看到一句「图片上传失败」。
          setError(message);
        },
      );
    },
    [dropKey, setError, t],
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
        (e: unknown) => {
          const message = errorText(t, e);
          settle({ preview, uploadId: null, state: "error", message });
          setError(message);
        },
      );
    },
    [dropKey, maxRefs, refs.length, setError, showToast, slotTarget, t],
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
  }, [dropKey, setError]);

  /* ── 提交：请求体以 createJobBodySchema（strict）为准 ── */
  const submit = useCallback(() => {
    if (working) return;
    if (tab === "audio") {
      // 音频页没有提交路径（它只指路，见 `AudioPanel`）。这是一道防御：真按到这里，
      // 也要说清楚声音是随视频出的，而不是「即将上线」。
      showToast(t("composer.audioPage.lead"));
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
          noteJob(created);
          upsert(created);
        }
        keys.current = [];
        setBusy(false);
        // 「当前任务」显示最新一条，其余进最近列表（阶段 A §5）
        setCurrentJob(made[made.length - 1] ?? null);
        setOpen(true);
        router.push("/create");
      } catch (e: unknown) {
        // 402 insufficient_balance / 429 quota_exceeded / failure_limit_reached：按错误码出当前语言文案（H2）。
        // 已经建成的那几条留在列表里，幂等 key 也留着——再点一次「创作」不会重复计费。
        setBusy(false);
        const reason = errorText(t, e);
        /*
          部分成功必须说清「已建成几条」（review 2026-09-15 C-24）：不说的话用户会改提示词
          再点，而改动会 `dropKey()` 作废整组 key，同一次创作意图变成两组任务、为已建成的
          那几条多付一次。已建成的也只有 /create 的「最近任务」看得见——主页瀑布流只收
          succeeded——所以这时候要把人带过去。
        */
        setError(made.length ? t("composer.err.partial", { n: made.length, total: n, reason }) : reason);
        if (made.length) {
          setCurrentJob(made[made.length - 1]);
          setOpen(true);
          router.push("/create");
        }
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
    noteJob,
    product,
    prompt,
    quotaExhausted,
    ratio,
    ratioUsable,
    refreshMe,
    refs,
    res,
    router,
    setBusy,
    setCurrentJob,
    setError,
    showToast,
    t,
    tab,
    upsert,
    working,
  ]);

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
    [clearAll, dropKey, setError],
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
    [clearAll, dropKey, setError],
  );

  /**
   * 音频页的唯一动作：平台出声的路径就是「原生音轨的视频产品」，所以这里做的事就是
   * 切到视频页、选中那个产品、把音轨打开——之后是一次普通的视频创作，不是另一条通道。
   */
  const useAudioProduct = useCallback(
    (productId: string) => {
      const target = products.find((p) => p.id === productId && p.kind === "video" && p.audio === "native");
      if (!target) return;
      setVideoProductId(target.id);
      setTab("video");
      setMode("prompt");
      setAudio(true);
      setPop(null);
      setError(null);
      dropKey();
      showToast(t("composer.audioPage.switched", { name: target.name }));
    },
    [dropKey, products, setError, showToast, t],
  );

  const value = useMemo<ComposerShell>(
    () => ({
      products,
      productChoices,
      product,
      pickProduct,
      open,
      openComposer,
      tab,
      pickTab,
      mode,
      pickMode,
      modeReason,
      templateReason,
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
      multiAvailable,
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
      notice,
      noticeTone,
      submit,
      reuse,
      applyTemplate,
      templates,
      templatesLoaded,
      templatesError,
      productsLoaded,
      productsError,
      useAudioProduct,
    }),
    [
      templates,
      templatesLoaded,
      templatesError,
      productsLoaded,
      productsError,
      useAudioProduct,
      products,
      productChoices,
      product,
      pickProduct,
      open,
      openComposer,
      tab,
      pickTab,
      mode,
      pickMode,
      modeReason,
      templateReason,
      collapsed,
      toggleCollapsed,
      pop,
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
      audioOn,
      audioAvailable,
      toggleAudio,
      multi,
      multiAvailable,
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
      notice,
      noticeTone,
      submit,
      reuse,
      applyTemplate,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
