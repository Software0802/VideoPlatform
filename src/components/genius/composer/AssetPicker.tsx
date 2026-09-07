"use client";

import { useState } from "react";
import { IconClose, IconUpload } from "@/components/genius/icons";
import { useShell, type SlotTarget } from "@/components/genius/ShellContext";
import { useT } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  素材选择弹窗（交接包 §4.1 图 13–15）。阶段 A 起两个页签都是真的：
  - 「已上传」= 本地文件选择，走 `uploadFile(file, role)` 那一条通道（与直接点槽位同一个 input）；
  - 「已创建」= 本人成功的图片任务，点选后由服务端把那张产物认领成一次上传
    （`POST /api/uploads/from-job`），拿回 `uploadId` 填进当前槽位——浏览器不必把图片
    下回来再传一遍。

  弹窗服务的是「当前槽位」（首帧 / 尾帧 / 参考），由 `openPicker(target)` 设定，标题跟着变。
*/

const TITLE: Record<SlotTarget, MessageKey> = {
  start: "composer.picker.title.start",
  last: "composer.picker.title.last",
  reference: "composer.picker.title.reference",
};

export function AssetPicker({ onUpload }: { onUpload: () => void }) {
  const { jobs, setPop, slotTarget, pickCreated } = useShell();
  const t = useT();
  const [tab, setTab] = useState<"made" | "uploaded">("uploaded");

  const made = jobs.filter((j) => j.status === "succeeded" && j.output?.kind === "image" && !j.artifactsPurgedAt);

  return (
    <div
      className="picker"
      role="dialog"
      aria-modal="true"
      aria-label={t("composer.picker.aria")}
      onClick={() => setPop(null)}
    >
      <div className="picker__panel" onClick={(e) => e.stopPropagation()}>
        <div className="picker__head">
          <span className="picker__title">{t(TITLE[slotTarget])}</span>
          <button type="button" className="picker__close" aria-label={t("common.close")} onClick={() => setPop(null)}>
            <IconClose size={15} />
          </button>
        </div>
        <div className="picker__tabs">
          <span className="picker__filter">{t("common.all")}</span>
          <button type="button" className="picker__tab" data-on={tab === "made"} onClick={() => setTab("made")}>
            {t("composer.picker.tab.made")}
          </button>
          <button type="button" className="picker__tab" data-on={tab === "uploaded"} onClick={() => setTab("uploaded")}>
            {t("composer.picker.tab.uploaded")}
          </button>
        </div>
        <div className="picker__body">
          {tab === "uploaded" ? (
            <button type="button" className="picker__drop" onClick={onUpload}>
              <IconUpload size={20} />
              <span>{t("composer.picker.drop")}</span>
            </button>
          ) : made.length ? (
            <div className="picker__grid">
              {made.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className="picker__item"
                  data-job-id={j.id}
                  title={j.prompt || t("composer.picker.noPrompt")}
                  onClick={() => pickCreated(j)}
                >
                  {/* 已生成的图片走 /api/media（owner 校验 + private,no-cache），本地 <img> 足够 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={j.output?.kind === "image" ? j.output.imageUrl : ""}
                    alt={j.prompt || t("composer.picker.alt")}
                  />
                </button>
              ))}
            </div>
          ) : (
            <p className="picker__empty">{t("composer.picker.empty")}</p>
          )}
        </div>
        <button type="button" className="picker__ok" onClick={() => setPop(null)}>
          {t("common.confirm")}
        </button>
      </div>
    </div>
  );
}
