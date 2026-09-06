"use client";

import { useRef } from "react";
import { AssetPicker } from "@/components/genius/composer/AssetPicker";
import { Composer, ComposerBar, type FileRefs } from "@/components/genius/composer/Composer";
import { useShell } from "@/components/genius/ShellContext";
import type { ShellView } from "@/components/genius/views";

/*
  悬浮层的锚点（交接包 §0 / §9.1）：`.dock` 是滚动容器 `main` 的**兄弟**，
  `position:absolute` 贴在 `.col` 底部，`main` 不为它预留 padding，也不加遮罩渐变。
  素材弹窗是另一个兄弟（`position:absolute; inset:0`），层级高于面板。

  主页收起时显示 `.bar`，面板仍留在 DOM 里但 `hidden` + `data-open="false"`（方案 §7）。

  三个槽位（首帧 / 尾帧 / 参考）各有一个真实的 `input[type=file]`，素材弹窗的「点击上传」
  要触发**当前槽位**那一个，所以 ref 在这里统一持有再往下发。
*/

export function Dock({ view }: { view: ShellView }) {
  const { open, pop, slotTarget } = useShell();
  const start = useRef<HTMLInputElement>(null);
  const last = useRef<HTMLInputElement>(null);
  const reference = useRef<HTMLInputElement>(null);
  const fileRefs: FileRefs = { start, last, reference };
  if (view !== "home" && view !== "create") return null;
  // 创作页面板恒展开；主页要点过输入条才展开
  const showComposer = view === "create" || open;

  return (
    <>
      <div className="dock">
        {showComposer ? null : <ComposerBar />}
        <Composer visible={showComposer} fileRefs={fileRefs} />
      </div>
      {pop === "picker" ? <AssetPicker onUpload={() => fileRefs[slotTarget].current?.click()} /> : null}
    </>
  );
}
