import { openaiImageTaskTimeoutMs, openaiImageTimeoutMs, usdCnyRate } from "@/lib/env";
import { imagePriceTableFromRaw } from "@/lib/cost";
import { log } from "@/lib/log";
import type { OpenaiImageConfig } from "@/lib/providers/openai-image/config";
import { makeRelayCatalog, type RelayModelSpec } from "@/lib/providers/relay/catalog";
import {
  fetchRelayModels,
  readRelayCatalogSnapshot,
} from "@/lib/providers/relay/discover";
import {
  loadRelaysDetailed,
  relaysFileMtime,
  relaysFilePath,
  type RelayConfig,
} from "@/lib/providers/relay/config";
import {
  liveRelayViews,
  relayViewFor,
  setRelayView,
  type RelayView,
} from "@/lib/providers/relay/live";
import { makeRelayProvider } from "@/lib/providers/relay/native";
import { OPENAI_RELAY, YMAN_RELAY } from "@/lib/providers/relay/presets";
import { registerProvider, unregisterProvider } from "@/lib/providers/registry";
import type { NativeMode, ProviderId } from "@/lib/providers/types";

/**
 * relay 装配：`data/relays.json` / `LUMEN_RELAYS` / 老 env 折算 → `RelayView` →
 * `VideoProvider` 注册进 registry。模块加载时装一次（`builtin.ts` 引它），此后靠
 * mtime 轮询 `reconcileRelays()` 热重载。
 */

const VIDEO_MODES: NativeMode[] = ["text_to_video", "image_to_video", "reference_to_video"];

/** RelayConfig（文件/种子形状）→ RelayView；env / 目录取值都保持调用时读取。 */
export function viewForConfig(cfg: RelayConfig, source: RelayView["source"]): RelayView {
  const apiKey = () => process.env[cfg.keyEnv]?.trim() || undefined;
  const catalogSource = cfg.catalog?.source ?? "static";
  const catalog = cfg.video
    ? makeRelayCatalog({
        // models-endpoint：目录 = `/models` 快照 ∪ 配置覆盖（配置赢同名模型）。
        table: () =>
          catalogSource === "models-endpoint"
            ? {
                ...readRelayCatalogSnapshot(cfg.id),
                ...((cfg.catalog?.models ?? {}) as Record<string, RelayModelSpec>),
              }
            : ((cfg.catalog?.models ?? {}) as Record<string, RelayModelSpec>),
        unknownCredits: () => cfg.catalog?.unknownCredits ?? 150,
        configuredModel: (mode: NativeMode) =>
          VIDEO_MODES.includes(mode)
            ? cfg.video?.defaults[mode as "text_to_video"]
            : undefined,
      })
    : null;
  const image: OpenaiImageConfig | null = cfg.image
    ? {
        id: cfg.id,
        keyEnvName: cfg.keyEnv,
        apiKey,
        base: () => cfg.baseUrl,
        model: () => cfg.image?.model ?? "gpt-image-1",
        shape: () => ({
          flexibleSizes: cfg.image?.flexibleSizes ?? false,
          quality: cfg.image?.quality ?? "medium",
        }),
        imageEditsEnabled: () => cfg.image?.editsEnabled ?? false,
        priceTable: () => imagePriceTableFromRaw(cfg.image?.priceTable, `relay:${cfg.id}:image`),
        timeoutMs: openaiImageTimeoutMs,
        taskTimeoutMs: openaiImageTaskTimeoutMs,
      }
    : null;
  const perCny = cfg.creditsPerCny ?? 100;
  return {
    id: cfg.id,
    name: cfg.name,
    keyEnvName: cfg.keyEnv,
    apiKey,
    base: () => cfg.baseUrl,
    // 有可用通道的 relay 进「无显式 ORDER 时的默认次序」，按 priority 降序排在内置默认后。
    implicitOrder: Boolean(catalog || image),
    priority: cfg.priority,
    enabled: cfg.enabled,
    catalog,
    catalogSource,
    videoTaskTimeoutMs: () => cfg.video?.taskTimeoutMs,
    image,
    chatModel: () => cfg.chat?.model,
    creditsPerCny: cfg.creditsPerCny,
    creditsToUsd: (credits) =>
      Math.round((credits / perCny / usdCnyRate()) * 1_000_000) / 1_000_000,
    source,
  };
}

/**
 * 装配侧自己记的「id → 配置签名」：reconcile 用它判断该注册 / 替换 / 注销谁。
 * env 预设没有 RelayConfig 原文，签名固定为 `preset:<id>`——它们的 thunk 本来
 * 就调用时取值，env 变了也不用换 provider 对象。
 */
const activeSignatures = new Map<ProviderId, string>();

function activate(view: RelayView, signature: string): void {
  // 已注册的先注销（对象进影子表），再注册新对象——正在跑的任务握着旧引用不受影响。
  unregisterProvider(view.id);
  setRelayView(view);
  if (view.enabled) registerProvider(makeRelayProvider(view));
  activeSignatures.set(view.id, signature);
}

function deactivate(id: ProviderId): void {
  unregisterProvider(id);
  activeSignatures.delete(id);
  // live 视图保留：列表读数、download-headers 对老任务产物续传都还要它。
}

/**
 * 读当前配置并把 registry 对齐到它：新增注册、删除注销（影子表保留给老任务解析）、
 * 改动替换对象。模块加载与 mtime 轮询都走这一个入口。
 */
export function reconcileRelays(): void {
  const wanted = new Map<ProviderId, { view: RelayView; signature: string }>();
  for (const entry of desiredRelayEntries()) {
    wanted.set(entry.view.id, entry);
  }

  // 删：装配过、这一版不再要的 relay id。
  for (const id of [...activeSignatures.keys()]) {
    if (!wanted.has(id)) deactivate(id);
  }
  // 增 / 改 / 开关翻转。
  for (const [id, { view, signature }] of wanted) {
    const prev = relayViewFor(id);
    if (
      !prev ||
      activeSignatures.get(id) !== signature ||
      prev.enabled !== view.enabled
    ) {
      activate(view, signature);
    }
  }
}

/**
 * 这一版配置想要的「view + 签名」列表。签名从**原始 RelayConfig** 算（view 里全是
 * 函数，序列化会丢字段）；env 预设没有原文，固定 `preset:<id>`——thunk 本来调用时
 * 取值，env 变了不用换对象。文件没写到的 `yman` / `openai` 回落 env 预设——
 * `providerForId` 对这两个 id 必须永远可解析（历史任务记录指着它们）。
 */
function desiredRelayEntries(): { view: RelayView; signature: string }[] {
  const { relays, source } = loadRelaysDetailed();
  if (source === "legacy") {
    return [
      { view: YMAN_RELAY, signature: "preset:yman" },
      { view: OPENAI_RELAY, signature: "preset:openai" },
    ];
  }
  const entries = relays.map((cfg) => ({
    view: viewForConfig(cfg, source),
    signature: JSON.stringify(cfg),
  }));
  if (!entries.some((e) => e.view.id === "yman"))
    entries.push({ view: YMAN_RELAY, signature: "preset:yman" });
  if (!entries.some((e) => e.view.id === "openai"))
    entries.push({ view: OPENAI_RELAY, signature: "preset:openai" });
  return entries;
}

/** 对外：当前生效的 relay view 列表（管理接口 GET / 列表读数用）。 */
export function currentRelayViews(): RelayView[] {
  return desiredRelayEntries().map((e) => e.view);
}

const POLL_MS = 10_000;
let lastMtime: number | null = null;
let watcherStarted = false;

/**
 * 模块加载时装配一次 + 起 mtime 轮询。`fs.watch` 在 Windows 对编辑器「写临时文件
 * 再 rename」的原子写经常丢事件，10s 轮询够用且行为可预测。
 */
export function assembleRelays(): void {
  reconcileRelays();
  lastMtime = relaysFileMtime();
  if (watcherStarted) return;
  // 测试进程不起轮询：vitest 各文件的临时 DATA_DIR 在同一个进程里轮换，
  // 10s 定时器撞上别的文件的 relays.json 会把注册表改掉——测试里热重载
  // 一律显式调 `reconcileRelays()`。
  if (process.env.VITEST) return;
  watcherStarted = true;
  // models-endpoint 的首次拉取延迟 30s：启动路径不能被一家中转的慢响应拖住，
  // 快照文件已经给了它一个可用的旧目录。
  setTimeout(() => {
    void (async () => {
      for (const view of liveRelayViews()) {
        if (view.catalogSource !== "models-endpoint" || !view.enabled) continue;
        try {
          await fetchRelayModels(view);
        } catch (error) {
          log("warn", "relay 目录首次拉取失败，继续使用旧快照 / 配置目录", {
            relay: view.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      reconcileRelays();
    })();
  }, 30_000).unref();
  const timer = setInterval(() => {
    const mtime = relaysFileMtime();
    if (mtime === lastMtime) return;
    lastMtime = mtime;
    log("info", "data/relays.json 变更，重建 relay 注册", { file: relaysFilePath() });
    try {
      reconcileRelays();
    } catch (error) {
      log("error", "relay 热重载失败，保留现有注册", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, POLL_MS);
  // 轮询不该拖着进程不退（单测 / 脚本）。
  if (typeof timer.unref === "function") timer.unref();
}
