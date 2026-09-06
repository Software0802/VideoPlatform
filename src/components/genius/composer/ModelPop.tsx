"use client";

import { IconBolt } from "@/components/genius/icons";
import { creditsOf, useShell } from "@/components/genius/ShellContext";

/*
  模型下拉（交接包 §4.1 图 7）：右下向上弹出，每行「图标 + 产品名 + ⚡基准积分 + 一行描述」，
  当前项底色高亮。

  用户 2026-09-06 决定：**只显示产品名，不露供应商**。所以这里渲染的一律是
  `Product.name` / `Product.description`，`Product.id` 只作 `data-product-id` 与提交体里的
  `model`，不出现在任何可见文案里。

  列表内容来自 `/api/models`，服务端只下发这台实例当前真能跑的产品——所以「列表里有」
  就等于「选了能提交」。拿不到列表时上层根本不渲染这个下拉（芯片退回只读文案）。
*/

export function ModelPop() {
  const { productChoices, product, pickProduct, caps } = useShell();

  return (
    <div className="model-pop" role="listbox" aria-label="模型">
      <span className="model-pop__title">模型</span>
      <div className="model-pop__list">
        {productChoices.map((p) => {
          const on = p.id === product?.id;
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
                  {caps.mock ? <span className="model-pop__mock">模拟</span> : null}
                </span>
                <span className="model-pop__desc">{p.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
