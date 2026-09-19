"use client";

import { useEffect, type RefObject } from "react";

/*
  弹层焦点管理（review 2026-09-15 U-07 / C-06）。

  原状是 7 个 `aria-modal="true"` 的层里只有改密弹窗靠 `autoFocus` 把焦点送进去，其余的
  打开后焦点还留在触发它的那个按钮上：读屏用户听不到层里的内容，键盘用户按 Tab 会一路走
  进被遮住、却仍然可聚焦的背景（WCAG 2.4.3 焦点顺序 / 2.1.2 无键盘陷阱要求的是「焦点在
  模态内循环」，不是「背景照样能走」）。

  这个 hook 做三件事，和 `CanvasView` 冲突层里手写的那一段同一个口径：
  打开时聚焦层内第一个可聚焦元素、Tab / Shift+Tab 在层内循环、关掉后把焦点还给打开它的
  那个元素。它**不**负责 Esc 收层与点外层收层——那是 `useDismiss` 的事，两者互不重叠。
*/

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  // 带原生控件的播放器是可聚焦的（键盘用户要能按空格播放）。漏掉它，下面的
  // 「焦点在层外就拉回来」会把 Tab 从播放器上踢走，作品详情里的成片就没法用键盘播了。
  "video[controls]",
  "audio[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** 层内当前真正可聚焦的元素。`hidden`/`display:none` 的拿 `offsetParent` 滤掉。 */
function focusables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * @param ref  弹层根元素（带 `role="dialog"` / `alertdialog"` 的那个）
 * @param open 层开着没有。`false` 时 hook 什么都不做
 * @param initial 打开时优先聚焦的元素选择器（比如「保留本地」这种默认动作）；
 *                选不中就退回第一个可聚焦元素
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  initial?: string,
): void {
  useEffect(() => {
    if (!open) return;
    const box = ref.current;
    if (!box) return;
    // 关掉之后要还回去的那个元素。可能在层开着的时候被卸载（列表项被删），所以还的时候再查一次。
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const list = focusables(box);
    const first = (initial ? box.querySelector<HTMLElement>(initial) : null) ?? list[0];
    if (first) {
      first.focus();
    } else {
      // 一个可聚焦元素都没有的层（纯文字提示）：让容器自己接住焦点，读屏才会念到它。
      box.tabIndex = -1;
      box.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(box);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const at = active ? items.indexOf(active) : -1;
      // 焦点已经在层外（at === -1，包括容器自身）时也拉回来：背景不该被 Tab 走到。
      const goingBack = e.shiftKey;
      const next =
        at === -1
          ? goingBack
            ? items[items.length - 1]
            : items[0]
          : goingBack
            ? at === 0
              ? items[items.length - 1]
              : items[at - 1]
            : at === items.length - 1
              ? items[0]
              : items[at + 1];
      e.preventDefault();
      next.focus();
    };
    // 捕获阶段：层里的输入框自己处理 Tab 之前就先决定去哪。
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, ref, initial]);
}
