"use client";

import { useState } from "react";
import { IconClose, IconUpload } from "@/components/genius/icons";
import { useShell } from "@/components/genius/ShellContext";

/*
  素材选择弹窗（交接包 §4.1 图 13–15）。本轮的实现口径（方案 §4）：
  - 「已上传」= 本地文件选择，走 `uploadFile(file,"start")` 那一条通道（与直接点图片槽同一个 input）；
  - 「已创建」= 列出本人成功的图片任务，但**只展示不可选**并标「即将上线」：首帧必须是
    `startUploadId`（一次真实上传），拿一张已生成图片当首帧还需要后端支持，本轮不做。
*/

export function AssetPicker({ onUpload }: { onUpload: () => void }) {
  const { jobs, setPop, showToast } = useShell();
  const [tab, setTab] = useState<"made" | "uploaded">("uploaded");

  const made = jobs.filter((j) => j.status === "succeeded" && j.output?.kind === "image" && !j.artifactsPurgedAt);

  return (
    <div className="picker" role="dialog" aria-modal="true" aria-label="选择图片" onClick={() => setPop(null)}>
      <div className="picker__panel" onClick={(e) => e.stopPropagation()}>
        <div className="picker__head">
          <span className="picker__title">图片</span>
          <button type="button" className="picker__close" aria-label="关闭" onClick={() => setPop(null)}>
            <IconClose size={15} />
          </button>
        </div>
        <div className="picker__tabs">
          <span className="picker__filter">全部</span>
          <button type="button" className="picker__tab" data-on={tab === "made"} onClick={() => setTab("made")}>
            已创建
          </button>
          <button type="button" className="picker__tab" data-on={tab === "uploaded"} onClick={() => setTab("uploaded")}>
            已上传
          </button>
        </div>
        <div className="picker__body">
          {tab === "uploaded" ? (
            <button type="button" className="picker__drop" onClick={onUpload}>
              <IconUpload size={20} />
              <span>点击 / 拖拽 / 粘贴</span>
            </button>
          ) : made.length ? (
            <div className="picker__grid">
              {made.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className="picker__item"
                  aria-disabled="true"
                  title={`${j.prompt || "无提示词"}（即将上线）`}
                  onClick={() => showToast("从已创建图片选首帧即将上线")}
                >
                  {/* 已生成的图片走 /api/media，本地 <img> 足够，不引 next/image */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={j.output?.kind === "image" ? j.output.imageUrl : ""} alt={j.prompt || "已创建图片"} />
                  <span className="picker__soon">即将上线</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="picker__empty">还没有已创建的图片</p>
          )}
        </div>
        <button type="button" className="picker__ok" onClick={() => setPop(null)}>
          确认
        </button>
      </div>
    </div>
  );
}
