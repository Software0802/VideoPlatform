"use client";

import { IMAGE_RES, VIDEO_RES, useShell } from "@/components/genius/ShellContext";

/*
  规格弹层（交接包 §4.1 图 5）：向上弹出的三块卡——分辨率 / 宽高比 / 时长。
  与原型的两处有意差异（方案 §4）：
  1. 分辨率只列后端真有的档（视频 480P/720P/1080P、图片 1K/2K），去掉原型的 360P/540P；
     右上「预览模式」开关与底部「剩余 3 次试用」一并去掉——后端没有这两个概念。
  2. 宽高比 / 时长只列服务端下发的枚举（provider 能力），不是原型写死的 8 项 / 15 档。
*/

/** 线框按原型的像素表（16:9 = 26×15…）按比例画；服务端下发之外的画幅不会出现。 */
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
  const { tab, res, setRes, imageRes, setImageRes, ratio, setRatio, ratios, dur, setDur, durs } = useShell();
  const isImage = tab === "image";

  return (
    <div className="specs-pop">
      <div className="specs-pop__card">
        <span className="specs-pop__title">分辨率</span>
        <div className="specs-pop__res">
          {isImage
            ? IMAGE_RES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  data-res={r.id}
                  aria-pressed={imageRes === r.id}
                  onClick={() => setImageRes(r.id)}
                >
                  {r.label}
                </button>
              ))
            : VIDEO_RES.map((r) => (
                <button key={r.id} type="button" data-res={r.id} aria-pressed={res === r.id} onClick={() => setRes(r.id)}>
                  {r.label}
                </button>
              ))}
        </div>
      </div>

      <div className="specs-pop__card">
        <span className="specs-pop__title">宽高比</span>
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

      {isImage ? null : (
        <div className="specs-pop__card">
          <span className="specs-pop__title">时长</span>
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
