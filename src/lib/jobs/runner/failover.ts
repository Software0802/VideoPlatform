import { priceCny } from "@/lib/billing/prices";
import { estimateCostUsd } from "@/lib/cost";
import { relayMaxSwitches } from "@/lib/env";
import { packHarnessDuration } from "@/lib/harness/pack-duration";
import {
  harnessSettingsFor,
  harnessSubmitEstimateUsd,
  modelForProvider,
  providerSettingsFor,
  videoPricingOf,
} from "@/lib/jobs/provider-settings";
import { readJob, updateJob } from "@/lib/jobs/store";
import { log } from "@/lib/log";
import { productForProvider } from "@/lib/products/catalog";
import { isImageMode } from "@/lib/providers/grok/mode-matrix";
import { recordOutcome } from "@/lib/providers/health";
import { isCertainRejection } from "@/lib/providers/rejection";
import { currentProviderId } from "@/lib/providers/router";
import { ProviderHttpError, type ProviderId } from "@/lib/providers/types";
import {
  emitRec,
  fail,
  MAX_UPSTREAM_RETRIES,
  UPSTREAM_BACKOFF_BASE_MS,
  UPSTREAM_BACKOFF_CODES,
} from "./state";

/**
 * Send a refused submit back to `queued` with an exponential delay (15s / 30s / 60s),
 * or report that the budget of retries is spent so the caller can fail it.
 *
 * Returns true when the job has been dealt with (re-queued, or already canceled) and
 * `runOne` should simply return.
 */
export async function backoffRequeue(id: string, error: unknown): Promise<boolean> {
  if (!(error instanceof ProviderHttpError) || !UPSTREAM_BACKOFF_CODES.has(error.code)) {
    return false;
  }
  const rec = await readJob(id);
  if (!rec) return false;
  // A cancel that landed while the refused request was in flight wins; there is
  // nothing to re-queue and nothing to fail.
  if (rec.canceled || rec.status === "canceled") return true;
  const attempts = rec.upstreamRetries ?? 0;
  if (attempts >= MAX_UPSTREAM_RETRIES) return false;
  const delayMs = UPSTREAM_BACKOFF_BASE_MS * 2 ** attempts;
  const next = await updateJob(id, (r) => {
    if (r.status === "canceled" || r.canceled) return r;
    r.status = "queued";
    r.upstreamRetries = (r.upstreamRetries ?? 0) + 1;
    r.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    return r;
  });
  emitRec(next);
  log("info", "upstream refused submit, backing off", {
    id,
    code: error.code,
    attempt: attempts + 1,
    delayMs,
  });
  return true;
}

/**
 * 提交被上游**确定拒绝**时（`isCertainRejection`：4xx 业务拒绝、`upstreamRejected`
 * 结构化 5xx、连接根本没建起来的 `phase:"connect"`），把这次任务改交给下一家接得下的
 * provider。
 *
 * 被拒的 submit 从来没有被计费，所以换家不是「再买一次」，而是同一次任务换个门；
 * 相比 `backoffRequeue` 的等 15/30/60 秒再撞同一堵墙，充值之前那堵墙不会自己消失。
 * 读超时 / 中途断连 / 裸 5xx 这类「可能已受理」的失败永远到不了这里——它们在
 * `resolveAmbiguousSubmit` 的 `uncertain_submit` 路径上结束。
 *
 * 换家会重算 model 与上游档位（新家的时长 / 分辨率枚举不一样），`priceCny` 则**只降不升**：
 * 换家是我们内部的事，用户什么都没做，不能让他多付；新家的档位反而更便宜时照低的收，
 * 因为交付的确实是更低的那一档。`upstreamRetries` 不加——退避重试的预算是留给「同一家
 * 暂时忙」的。
 *
 * 排除集是本任务**已经试过的全部家**（`providerSwitches` 的 from/to 并集 + 当前家），
 * 换家上限 `RELAY_MAX_SWITCHES`（默认 2）；两条都防的是同一个错被摊到每家账上。
 * 用户点名产品的任务（`productPicked`）不换家——换成别家是交付了他没选的产品，
 * 确定拒绝时直接按 `product_unavailable` 失败。
 *
 * 新家的时长档位比原来**大**（可灵 5 秒 → 只有 10/15 档的模型）且售价会因此上涨时，
 * 干脆不换：那等于替用户买了一个他没选的时长。这种任务交回退避路径，按原规则重试或失败。
 *
 * 返回 true 表示这次失败已经被处理掉（换家 / 点名产品已失败 / 任务已取消），
 * `runOne` 直接返回。
 */
export async function switchProvider(id: string, error: unknown, submitMs: number): Promise<boolean> {
  if (!isCertainRejection(error)) return false;
  const rec = await readJob(id);
  if (!rec) return false;
  if (rec.canceled || rec.status === "canceled") return false;
  const err = error as ProviderHttpError;
  const kind = isImageMode(rec.mode) ? "image" : "video";
  // 健康记账先行：quota_exhausted 落 6h 冷却、rate_limited 吃 Retry-After / 指数档、
  // 其余确定拒绝也计入窗口样本——路由与 `/api/models` 立刻绕开这家。
  recordOutcome(rec.provider, kind, false, submitMs, err.code, { retryAfterMs: err.retryAfterMs });

  // 用户点名了产品：换成别家等于交付他没选的产品，确定拒绝直接失败。
  if (rec.productPicked) {
    await fail(id, "product_unavailable", "所选模型暂时不可用，请换一个模型或稍后再试", err.message);
    return true;
  }

  // 已试过的全部家：当前家 + 历次换家的落点。换家次数上限按任务计。
  const tried = new Set<ProviderId>([
    rec.provider,
    ...(rec.providerSwitches ?? []).flatMap((s) => [s.from, s.to]),
  ]);
  if ((rec.providerSwitches ?? []).length >= relayMaxSwitches()) return false;

  let next: ProviderId;
  try {
    next = currentProviderId(rec.mode, {
      harness: Boolean(rec.harness?.enabled),
      aspectRatio: rec.aspectRatio ?? undefined,
      // 尾帧是硬条件：换到一家发不出尾帧的上游，交付的是另一个东西，不是同一件事换个门。
      needsLastFrame: Boolean(rec.assets.last),
      // 分辨率**故意不做硬条件**：这条路径上的备选是「降一档并退掉差价」还是「彻底没有
      // 成片」。降档后 `priceCny` 只降不升（下面那段），所以降档是对用户有利的一侧；
      // 而创建任务时没有这个两难，1080p 接不下就该 400，不该悄悄给 720p。
      durationSec: rec.durationSec,
      exclude: [...tried],
    });
  } catch {
    // 没有一家接得下这个画幅了（`currentProviderId` 的 400/503）：交回退避路径，
    // 让它按既有规则重试或失败，而不是在这里编一个新的错误码。
    return false;
  }
  // 换到 mock 就是拿一段水印片冒充成片。宁可让任务照常失败，也不交付一个假成片。
  if (tried.has(next) || next === "mock") return false;

  const model = modelForProvider(next, rec.mode);
  // 长片的 30/45/60 是管线内部拆 shot 的目标总长，不按上游档位归一；换家只换执行方，
  // job.durationSec 必须留住，否则下游认不出它走 harness。分辨率 / 音轨 / 画幅的归一
  // 照常走——`harnessSettingsFor` 只取非时长字段。
  const isHarness = Boolean(rec.harness?.enabled);
  const normBody = {
    prompt: rec.prompt,
    aspectRatio: rec.aspectRatio ?? undefined,
    resolution: rec.resolution ?? undefined,
    generateAudio: rec.generateAudio,
  };
  // 产品只当标签用，不参与归一：换家是我们内部的事，不该顺手把实例配置
  // （`KLING_VIDEO_AUDIO` 之类）换成产品表里的默认档，那会改动用户被收的钱。
  const normOpts = { hasLastFrame: Boolean(rec.assets.last) };
  const hSettings = isHarness
    ? harnessSettingsFor(next, rec.mode, normBody, model, normOpts)
    : null;
  const settings = isHarness
    ? null
    : providerSettingsFor(next, rec.mode, rec.durationSec, normBody, model, normOpts);
  // 产品标签跟着 provider 走：换家之后仍挂着「标准」，界面就会拿一个不是这次执行的
  // 产品名去显示。找不到对应产品就摘掉标签，不编一个。音轨也要对上——可灵的「标准」
  // 与「高清有声」共用同一个上游模型，只按模型名找会把出声的那条标成无声的那一档。
  const product = productForProvider(next, rec.mode, model, {
    audio: (settings ?? hSettings)?.audio,
  });
  // 新家归一后这次任务该值多少钱。图片模式 `settings` 恒为 null，算出来与原价同档。
  const switchedPrice = priceCny({
    mode: rec.mode,
    durationSec: settings ? settings.durationSec : rec.durationSec,
    resolution: (settings ?? hSettings)?.resolution ?? rec.resolution,
    generateAudio: (settings ?? hSettings)
      ? (settings ?? hSettings)!.audio === "native"
      : rec.generateAudio,
    imageResolution: rec.imageResolution,
  });
  // 用户选的是 5 秒，新家最短 10 秒且因此更贵：这不是「同一件事换个门」，是另一件商品。
  if (settings && settings.durationSec > rec.durationSec && switchedPrice > rec.priceCny) {
    log("info", `provider ${rec.provider} 积分耗尽，但 ${next} 的时长档更长且更贵，放弃换家`, {
      id,
      from: rec.provider,
      to: next,
      fromDurationSec: rec.durationSec,
      toDurationSec: settings.durationSec,
    });
    return false;
  }
  const from = rec.provider;
  const updated = await updateJob(id, (r) => {
    if (r.canceled || r.status === "canceled") return r;
    r.provider = next;
    // 换家留痕：从哪来、到哪去、被哪个错误码赶走。审计「这条单子为什么走了这家」
    // 全靠它——健康读数只能说明此刻谁被冷却，说明不了这条任务的历史。
    r.providerSwitches = [
      ...(r.providerSwitches ?? []),
      { from, to: next, code: err.code, at: new Date().toISOString() },
    ];
    r.model = model;
    r.product = product?.id;
    r.productName = product?.name;
    if (settings) {
      r.durationSec = settings.durationSec;
      r.resolution = settings.resolution;
      r.generateAudio = settings.audio === "native";
    }
    if (hSettings) {
      // 长片只搬非时长字段：durationSec 是管线目标总长，不归一。
      r.resolution = hSettings.resolution;
      r.generateAudio = hSettings.audio === "native";
    }
    // 只降不升：报价是对用户的承诺，换家不能让它涨；新档更便宜就照新档收。
    r.priceCny = Math.min(r.priceCny, switchedPrice);
    r.costUsdEstimate = isImageMode(r.mode)
      ? r.costUsdEstimate
      : isHarness
        ? harnessSubmitEstimateUsd(packHarnessDuration(r.durationSec as 30 | 45 | 60), {
            model,
            video: videoPricingOf(hSettings, next) ?? {
              resolution: r.resolution ?? "720p",
              audio: r.generateAudio ? "native" : "off",
              provider: next,
            },
          })
        : estimateCostUsd(model, r.durationSec, undefined, videoPricingOf(settings, next));
    r.status = "queued";
    // 上一家的退避时间戳不该拖住新家：这是另一个门，不用等。
    delete r.nextAttemptAt;
    return r;
  });
  if (updated.provider !== next) return false;
  emitRec(updated);
  log("info", `provider ${from} 确定拒单（${err.code}），任务改走 ${next}`, {
    id,
    from,
    to: next,
    model,
    detail: err.message,
  });
  return true;
}
