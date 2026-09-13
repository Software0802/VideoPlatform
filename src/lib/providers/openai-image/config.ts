import {
  openaiApiKey,
  openaiBase,
  openaiImageEditsEnabled,
  openaiImageModel,
  openaiImageTaskTimeoutMs,
  openaiImageTimeoutMs,
  ymanApiKey,
  ymanBase,
  ymanImageEditsEnabled,
  ymanImageModel,
} from "@/lib/env";
import { openaiImagePriceTable, ymanImagePriceTable, type ImagePriceTable } from "@/lib/cost";
import { envImageShape, type OpenaiImageShape } from "@/lib/providers/openai-image/rest-map";
import type { ProviderId } from "@/lib/providers/types";

/**
 * 一条「OpenAI Images API 兼容」通道的全部配置。
 *
 * 这套代码原先只服务一个上游（官方 / ccgoai），所有参数直接读 `OPENAI_IMAGE_*`。
 * YMan 同样兼容这套 REST，但用的是另一把 key、另一个 base、另一张价目表，所以把
 * 「读哪几个环境变量」收进这里，provider 由 `makeOpenaiImageProvider(cfg)` 生成。
 *
 * 全是函数而不是取好的值：环境变量在测试里被 stub、在运行时也可能改，取值必须发生
 * 在调用那一刻，不能固化在模块加载时。
 */
export type OpenaiImageConfig = {
  /** 落进 `job.provider` 与 `ProviderHandle.providerId` 的 id。 */
  id: ProviderId;
  /** 缺 key 时报错信息里点名的那个变量，免得用户对着 OPENAI_API_KEY 找 YMan 的 key。 */
  keyEnvName: string;
  apiKey(): string | undefined;
  base(): string;
  /** `req.model` 为空时的兜底模型名（正常路径由 `modelForProvider` 写进 job.model）。 */
  model(): string;
  shape(): OpenaiImageShape;
  /**
   * 这条通道是否允许带参考图的 t2i（`POST /images/edits` multipart）。打开后
   * `capabilities().supportsImageReference` 为真；关闭时带参考图的请求被
   * `validate()` 400 拒掉。两条通道各自的开关：`OPENAI_IMAGE_EDITS_ENABLED` /
   * `YMAN_IMAGE_EDITS_ENABLED`，默认都关——中转是否透传 edits 接口未验证。
   */
  imageEditsEnabled(): boolean;
  priceTable(): ImagePriceTable | null;
  /** 单次 HTTP 请求超时。 */
  timeoutMs(): number;
  /** 202 异步出图任务「受理 → 轮询 → 取 result」整条链的总上限。 */
  taskTimeoutMs(): number;
};

/** 官方 OpenAI / 兼容中转（ccgoai）。行为与加 YMan 之前逐字一致。 */
export const OPENAI_IMAGE_CONFIG: OpenaiImageConfig = {
  id: "openai",
  keyEnvName: "OPENAI_API_KEY",
  apiKey: openaiApiKey,
  base: openaiBase,
  model: openaiImageModel,
  shape: envImageShape,
  imageEditsEnabled: openaiImageEditsEnabled,
  priceTable: openaiImagePriceTable,
  timeoutMs: openaiImageTimeoutMs,
  taskTimeoutMs: openaiImageTaskTimeoutMs,
};

/**
 * YMan 的生图通道，与它的视频通道共用 `YMAN_API_KEY` / `YMAN_BASE_URL`。
 *
 * `flexibleSizes` 与 `quality` 是**定值**而不是环境变量：这条通道按「画质档 × 尺寸档」
 * 计费且接受任意尺寸，七个画幅都能原生出图，没有理由退回官方那三档 + 本地裁切；
 * 画质固定 high 同理——省下的钱远不如一张糊图的代价。要改价目用
 * `YMAN_IMAGE_PRICE_TABLE`，那才是会变的那部分。
 */
export const YMAN_IMAGE_CONFIG: OpenaiImageConfig = {
  id: "yman",
  keyEnvName: "YMAN_API_KEY",
  apiKey: ymanApiKey,
  base: ymanBase,
  model: ymanImageModel,
  shape: () => ({ flexibleSizes: true, quality: "high" }),
  imageEditsEnabled: ymanImageEditsEnabled,
  priceTable: ymanImagePriceTable,
  timeoutMs: openaiImageTimeoutMs,
  taskTimeoutMs: openaiImageTaskTimeoutMs,
};

/** 一个 provider id 对应的生图通道配置；不是生图通道就返回 undefined。 */
export function imageConfigFor(id: ProviderId): OpenaiImageConfig | undefined {
  if (id === "openai") return OPENAI_IMAGE_CONFIG;
  if (id === "yman") return YMAN_IMAGE_CONFIG;
  return undefined;
}
