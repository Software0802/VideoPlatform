"use client";

import { useRef } from "react";
import { AssetPicker } from "@/components/genius/composer/AssetPicker";
import { Composer, ComposerBar } from "@/components/genius/composer/Composer";
import { useShell } from "@/components/genius/ShellContext";
import type { ShellView } from "@/components/genius/views";

/*
  悬浮层的锚点（交接包 §0 / §9.1）：`.dock` 是滚动容器 `main` 的**兄弟**，
  `position:absolute` 贴在 `.col` 底部，`main` 不为它预留 padding，也不加遮罩渐变。
  素材弹窗是另一个兄弟（`position:absolute; inset:0`），层级高于面板。

  主页收起时显示 `.bar`，面板仍留在 DOM 里但 `hidden` + `data-open="false"`（方案 §7）。
*/

export function Dock({ view }: { view: ShellView }) {
  const { open, pop } = useShell();
  const fileRef = useRef<HTMLInputElement>(null);
  if (view !== "home" && view !== "create") return null;
  // 创作页面板恒展开；主页要点过输入条才展开
  const showComposer = view === "create" || open;

  return (
    <>
      <div className="dock">
        {showComposer ? null : <ComposerBar />}
        <Composer visible={showComposer} fileRef={fileRef} />
      </div>
      {pop === "picker" ? <AssetPicker onUpload={() => fileRef.current?.click()} /> : null}
    </>
  );
}
