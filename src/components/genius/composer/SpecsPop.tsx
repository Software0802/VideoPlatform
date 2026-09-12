"use client";

import { IMAGE_RES_LABEL, RES_LABEL, useShell } from "@/components/genius/ShellContext";
import { IconClose } from "@/components/genius/icons";
import { useT } from "@/components/genius/i18n/I18nProvider";

/*
  规格弹层（交接包 §4.1 图 5）：向上弹出的三块卡——分辨率 / 宽高比 / 时长。
  与原型的几处有意差异（方案 §4 + 阶段 A）：
  1. 三块卡的选项**全部来自当前产品的能力**（`/api/models`），拿不到产品时回落服务端
     下发的枚举——不是原型写死的 360P/540P、8 项画幅、15 档时长。
  2. 右上「预览模式」开关与底部「剩余 3 次试用」去掉——后端没有这两个概念。
  3. 首尾帧模式不显示宽高比卡：成片比例跟着两张帧走，选了也没处发（交接包图 11）。
*/

/** 线框按原型的像素表（16:9 = 26×15…）按比例画；产品能力之外的画幅不会出现。 */
const FRAME: Record<string, [number, number]> = {
  "16:9": [26, 15],
  "4:3": [22, 16],
  "1:1": [18, 18],
  "3:4": [15, 20],
  "9:16": [12, 21],
  "3:2": [24, 16],
  "2:3": [15, 22],
};

export function SpecsPop() {
  const {
    tab,
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
    setPop,
  } = useShell();
  const t = useT();
  const isImage = tab === "image";

  return (
    <div className="specs-pop">
      {/*
        可见关闭控件（H4）：规格层是多卡面板不是 listbox 下拉，给一枚浮在右上角的
        ✕；Esc / 再点规格芯片 / 点外层的收层路径照旧。
      */}
      <button type="button" className="specs-pop__close" aria-label={t("common.close")} onClick={() => setPop(null)}>
        <IconClose size={12} />
      </button>
      <div className="specs-pop__card">
        <span className="specs-pop__title">{t("composer.specs.resolution")}</span>
        <div className="specs-pop__res">
          {isImage
            ? imageResolutions.map((r) => (
                <button key={r} type="button" data-res={r} aria-pressed={imageRes === r} onClick={() => setImageRes(r)}>
                  {IMAGE_RES_LABEL[r]}
                </button>
              ))
            : resolutions.map((r) => (
                <button key={r} type="button" data-res={r} aria-pressed={res === r} onClick={() => setRes(r)}>
                  {RES_LABEL[r]}
                </button>
              ))}
        </div>
      </div>

      {ratioUsable ? (
        <div className="specs-pop__card">
          <span className="specs-pop__title">{t("composer.specs.ratio")}</span>
          <div className="specs-pop__grid">
            {ratios.map((r) => {
              const [w, h] = FRAME[r] ?? [20, 20];
              return (
                <button
                  key={r}
                  type="button"
                  className="specs-pop__ratio"
                  data-ratio={r}
                  aria-pressed={ratio === r}
                  onClick={() => setRatio(r)}
                >
                  <span className="specs-pop__frame" style={{ width: `${w}px`, height: `${h}px` }} aria-hidden="true" />
                  <span className="specs-pop__label">{r}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {isImage ? null : (
        <div className="specs-pop__card">
          <span className="specs-pop__title">{t("composer.specs.duration")}</span>
          <div className="specs-pop__durs">
            {durs.map((d) => (
              <button key={d} type="button" data-dur={d} aria-pressed={dur === d} onClick={() => setDur(d)}>
                {d}s
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
