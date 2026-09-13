"use client";

import { IconBolt } from "@/components/genius/icons";
import {
  creditsOf,
  IMAGE_RES_LABEL,
  RES_LABEL,
  useComposer,
  useSession,
} from "@/components/genius/ShellContext";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { HARNESS_DURATIONS } from "@/lib/harness/durations";
import type { Product } from "@/lib/client/models";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  模型下拉（交接包 §4.1 图 7）：右下向上弹出，每行「图标 + 产品名 + ⚡基准积分 + 成本档徽标
  + 一行元信息 + 一行描述」，当前项底色高亮。

  R2.3（N4）起按供应商分组：组头是 `providerName`，组内补次要信息（上游模型展示名、
  时长 / 分辨率档、参考图上限、成本档）。字段全部来自 `/api/models` 的白名单 DTO——
  key 与错误详情不下发；产品 id 只作 `data-product-id` 与提交体里的 `model`。
  产品名 / 描述 / 上游名都由服务端下发，不进字典（切语言不变）。

  组顺序 = DTO 顺序的首次出现顺序（服务端 ORDER / 优先级），客户端不排序。
  列表内容来自 `/api/models`，服务端只下发这台实例当前真能跑的产品——所以「列表里有」
  就等于「选了能提交」。拿不到列表时上层根本不渲染这个下拉（芯片退回只读文案）。
*/

/** 成本档徽标的文案键（`data-cost` 值与键后缀一致，e2e 按属性断言）。 */
const COST_KEY: Record<NonNullable<Product["costHint"]>, MessageKey> = {
  low: "composer.model.cost.low",
  mid: "composer.model.cost.mid",
  high: "composer.model.cost.high",
};

type ProductGroup = { id: string; name: string; items: Product[] };

/** 按 providerId 分组，保持 DTO 的首次出现顺序。没有 provider 字段的产品归入「默认路由」组。 */
function groupProducts(list: Product[], fallback: string): ProductGroup[] {
  const groups: ProductGroup[] = [];
  const byId = new Map<string, ProductGroup>();
  for (const p of list) {
    const id = p.providerId ?? "";
    let group = byId.get(id);
    if (!group) {
      group = { id, name: p.providerName ?? p.providerId ?? fallback, items: [] };
      byId.set(id, group);
      groups.push(group);
    }
    group.items.push(p);
  }
  return groups;
}

/**
 * 时长档文案：`5s · 10s`；长片档（30/45/60）与面板芯片同一条判据——
 * `caps.harness` 且产品声明 `supportsLongForm`（`ComposerProvider` 的 `durs`）。
 */
function durationsLabel(p: Product, harness: boolean): string {
  const base = p.durations ?? [];
  const all = harness && p.supportsLongForm ? [...base, ...HARNESS_DURATIONS] : base;
  return all.map((d) => `${d}s`).join(" · ");
}

/** 分辨率档文案：视频产品用 `resolutions`（720P…），图片产品用 `imageResolutions`（1K/2K）。 */
function resolutionsLabel(p: Product): string {
  const list =
    p.kind === "image"
      ? (p.imageResolutions ?? []).map((r) => IMAGE_RES_LABEL[r])
      : p.resolutions.map((r) => RES_LABEL[r]);
  return list.join(" · ");
}

export function ModelPop() {
  const { productChoices, product, pickProduct } = useComposer();
  const { caps } = useSession();
  const t = useT();
  const groups = groupProducts(productChoices, t("composer.model.defaultGroup"));

  return (
    <div className="model-pop" role="listbox" aria-label={t("composer.model.title")}>
      <span className="model-pop__title">{t("composer.model.title")}</span>
      <div className="model-pop__list">
        {groups.map((group) => (
          <div
            key={group.id || "_default"}
            className="model-pop__group"
            role="group"
            aria-label={group.name}
          >
            <span className="model-pop__group-title" role="presentation">
              {group.name}
            </span>
            {group.items.map((p) => {
              const on = p.id === product?.id;
              const durs = durationsLabel(p, caps.harness);
              const resolutions = resolutionsLabel(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  className="model-pop__item"
                  data-product-id={p.id}
                  aria-selected={on}
                  data-on={on}
                  onClick={() => pickProduct(p.id)}
                >
                  <span className="model-pop__icon" aria-hidden="true" />
                  <span className="model-pop__body">
                    <span className="model-pop__name">
                      {p.name}
                      {/* 基准价：一次典型出片的积分（¥1 = 100 积分），不是这次提交的实际报价 */}
                      <span className="model-pop__price">
                        <IconBolt size={10} />
                        {creditsOf(p.samplePriceCny)}
                      </span>
                      {p.costHint ? (
                        <span className="model-pop__cost" data-cost={p.costHint}>
                          {t(COST_KEY[p.costHint])}
                        </span>
                      ) : null}
                      {caps.mock ? <span className="model-pop__mock">{t("composer.model.mock")}</span> : null}
                    </span>
                    {/* 上游展示名只在「与产品名不同」时才露，免得同一串字印两遍。 */}
                    {p.upstreamModel && p.upstreamModel !== p.name ? (
                      <span className="model-pop__upstream">{p.upstreamModel}</span>
                    ) : null}
                    {durs || resolutions || p.maxReferenceImages > 0 ? (
                      <span className="model-pop__meta">
                        {[
                          durs,
                          resolutions,
                          p.maxReferenceImages > 0
                            ? t("composer.model.refs", { n: p.maxReferenceImages })
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : null}
                    <span className="model-pop__desc">{p.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
